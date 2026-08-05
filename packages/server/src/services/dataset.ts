import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { db } from "@vulseek/server/db";
import {
	datasetProfiles,
	datasetSamples,
	datasetEvaluations,
	datasetEvaluationTrials,
	datasets,
	sshKeys,
	type DatasetSource,
	datasetHookSchema,
	datasetSourceSchema,
	agentProfiles,
} from "@vulseek/server/db/schema";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { execAsync } from "../utils/process/execAsync";
import {
	createJsonSchemaContract,
	validateJsonSchemaContract,
} from "./scan/pipeline/scan-pipeline-schema-contracts";
import {
	datasetManifestRelativePath,
	resolveDatasetPathInside,
	resolveDatasetHostRoot as resolveDatasetHostRootContract,
	validateDatasetManifest as validateDatasetManifestContract,
} from "./dataset-contracts";
import type { AgentProfileLike, ScanJob } from "./scan/types";

const shellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

const sanitizeSegment = (value: string) =>
	value
		.replace(/[\\/]+/g, "-")
		.replace(/[^a-zA-Z0-9._-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "") || "unknown";

export const resolveDatasetHostRoot = resolveDatasetHostRootContract;
export const validateDatasetManifest = validateDatasetManifestContract;
const manifestRelativePath = datasetManifestRelativePath;

const resolveSourceDigest = async (hostRoot: string, source: DatasetSource) => {
	if (source.type === "git") {
		try {
			const { stdout } = await execAsync(
				`git -C ${shellQuote(hostRoot)} rev-parse HEAD`,
			);
			return stdout.trim();
		} catch {
			// A local checkout can be a non-git directory. Fall through to a
			// content-derived digest so profiles remain reproducible enough to inspect.
		}
	}
	const manifest = await fs.readFile(path.join(hostRoot, manifestRelativePath));
	return createHash("sha256")
		.update(JSON.stringify(source))
		.update(manifest)
		.digest("hex");
};

const prepareSource = async (
	source: DatasetSource,
	hostRoot: string,
	organizationId: string,
) => {
	await fs.mkdir(path.dirname(hostRoot), { recursive: true });

	if (source.type === "local") {
		const sourcePath = path.resolve(source.path);
		const stat = await fs.stat(sourcePath);
		if (!stat.isDirectory()) throw new Error("Dataset local source must be a directory");
		const resolvedHostRoot = path.resolve(hostRoot);
		if (
			resolvedHostRoot === sourcePath ||
			resolvedHostRoot.startsWith(`${sourcePath}${path.sep}`) ||
			sourcePath.startsWith(`${resolvedHostRoot}${path.sep}`)
		) {
			throw new Error("Dataset local source cannot overlap the profile host root");
		}
		await fs.rm(hostRoot, { recursive: true, force: true });
		await fs.cp(sourcePath, hostRoot, { recursive: true, errorOnExist: true });
		return;
	}

	await fs.rm(hostRoot, { recursive: true, force: true });
	const refArgs = source.ref ? `--branch ${shellQuote(source.ref)}` : "";
	let sshKeyPath: string | null = null;
	try {
		if (source.sshKeyId) {
			const key = await db
				.select({ privateKey: sshKeys.privateKey })
				.from(sshKeys)
				.where(and(eq(sshKeys.sshKeyId, source.sshKeyId), eq(sshKeys.organizationId, organizationId)))
				.limit(1)
				.then((rows) => rows[0]);
			if (!key?.privateKey?.trim()) {
				throw new Error("Dataset SSH key was not found or has no private key");
			}
			sshKeyPath = path.join(os.tmpdir(), `vulseek-dataset-key-${nanoid(12)}`);
			await fs.writeFile(sshKeyPath, `${key.privateKey.trim()}\n`, { mode: 0o600 });
		}
		const sshEnv = sshKeyPath
			? `GIT_SSH_COMMAND=${shellQuote(`ssh -i ${sshKeyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=no`)}`
			: "";
		const gitCommand = `${sshEnv ? `${sshEnv} ` : ""}git clone --depth 1 ${refArgs} ${shellQuote(source.url)} ${shellQuote(hostRoot)}`;
		await execAsync(gitCommand);
		if (source.submodules) {
			await execAsync(
				`${sshEnv ? `${sshEnv} ` : ""}git -C ${shellQuote(hostRoot)} submodule update --init --recursive`,
			);
		}
	} finally {
		if (sshKeyPath) await fs.rm(sshKeyPath, { force: true }).catch(() => {});
	}
};

const activeDatasetHookContainers = new Map<string, Set<string>>();

const registerDatasetHookContainer = (key: string | undefined, containerName: string) => {
	if (!key) return;
	const containers = activeDatasetHookContainers.get(key) ?? new Set<string>();
	containers.add(containerName);
	activeDatasetHookContainers.set(key, containers);
};

const unregisterDatasetHookContainer = (key: string | undefined, containerName: string) => {
	if (!key) return;
	const containers = activeDatasetHookContainers.get(key);
	containers?.delete(containerName);
	if (containers?.size === 0) activeDatasetHookContainers.delete(key);
};

export const cancelDatasetHookRuns = async (key: string) => {
	const containers = [...(activeDatasetHookContainers.get(key) ?? [])];
	await Promise.all(
		containers.map((containerName) =>
			execAsync(`docker rm -f -- ${shellQuote(containerName)}`).catch(() => {}),
		),
	);
};

const runWithTimeout = async <T>(promise: Promise<T>, timeoutSeconds: number, message: string) => {
	const timeoutMs = Math.max(1, timeoutSeconds) * 1000;
	let timeoutHandle: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timeoutHandle = setTimeout(() => reject(new Error(message)), timeoutMs);
	});
	promise.catch(() => {});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timeoutHandle) clearTimeout(timeoutHandle);
	}
};

const runPostCheckoutScript = async (
	command: string,
	hostRoot: string,
	image: string,
	timeoutSeconds = 3_600,
) => {
	const { stdout, stderr } = await execAsync(
		`docker run --rm --network none -v ${shellQuote(`${hostRoot}:/workspace/dataset`)} -w /workspace/dataset ${shellQuote(image)} bash -lc ${shellQuote(`timeout --signal=TERM --kill-after=5s ${Math.max(1, timeoutSeconds)}s bash -lc ${shellQuote(command)}`)}`,
	);
	return `${stdout}${stderr}`;
};

const normalizeDatasetHookResult = (raw: string, schema: Record<string, unknown>) => {
	const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	let parsed: unknown = null;
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		try {
			parsed = JSON.parse(lines[index] as string);
			break;
		} catch {}
	}
	if (parsed === null) throw new Error("Dataset hook must print a JSON result as its final non-empty line");
	const envelope = parsed && typeof parsed === "object" && !Array.isArray(parsed) && "output" in parsed
		? parsed as { output?: unknown; route?: unknown }
		: { output: parsed, route: null };
	const output = envelope.output;
	const contract = createJsonSchemaContract({
		schemas: {},
		schema: Object.keys(schema).length > 0 ? schema : { type: "object", additionalProperties: true },
	});
	validateJsonSchemaContract(contract, output);
	return { route: envelope.route ?? null, output };
};

const readDatasetHookOutput = async (outputPath: string, timeoutMs: number) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const parsed = JSON.parse(await fs.readFile(outputPath, "utf8")) as unknown;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("output" in parsed)) {
				throw new Error("Dataset prompt hook output.json must be an output envelope");
			}
			return parsed as { output: unknown; route?: unknown };
		} catch (error) {
			if (error instanceof SyntaxError || (error instanceof Error && error.message.includes("ENOENT"))) {
				await new Promise((resolve) => setTimeout(resolve, 250));
				continue;
			}
			throw error;
		}
	}
	throw new Error(`Dataset prompt hook timed out after ${timeoutMs}ms waiting for output.json`);
};

export const runDatasetPromptHook = async (input: {
	prompt: string;
	agentProfileId: string;
	organizationId: string;
	profileHostRoot: string;
	workspaceHostPath?: string;
	image: string;
	timeoutSeconds?: number;
	cancellationKey?: string;
	input?: unknown;
	schema?: Record<string, unknown>;
}) => {
	const agentProfile = await db
		.select()
		.from(agentProfiles)
		.where(and(eq(agentProfiles.agentProfileId, input.agentProfileId), eq(agentProfiles.organizationId, input.organizationId)))
		.limit(1)
		.then((rows) => rows[0]);
	if (!agentProfile || !agentProfile.isEnabled) {
		throw new Error(`Dataset hook agent profile is unavailable: ${input.agentProfileId}`);
	}

	const hookId = `hook-${nanoid(12)}`;
	const hostStageDir = path.join(input.profileHostRoot, ".vulseek", "hooks", hookId);
	const inputDir = input.input === undefined ? null : await fs.mkdtemp(path.join(os.tmpdir(), "vulseek-dataset-prompt-input-"));
	if (inputDir) await fs.writeFile(path.join(inputDir, "input.json"), `${JSON.stringify(input.input, null, 2)}\n`, { mode: 0o600 });
	const projectName = "dataset-hooks";
	const serviceName = hookId;
	const mountedProfileDir = path.posix.join("/scan-context", "projects", projectName, "profiles", serviceName);
	const stageRootInContainer = path.posix.join(mountedProfileDir, ".vulseek", "hooks", hookId);
	const containerName = `vulseek-dataset-hook-${sanitizeSegment(hookId)}`;
	const scanJob = {
		scanJobId: hookId,
		scanType: "full",
		applicationId: null,
		composeId: null,
		scanRuntimeSettings: {},
	} as unknown as ScanJob;
	const schema = input.schema && Object.keys(input.schema).length > 0
		? input.schema
		: { type: "object", additionalProperties: true };
	const schemaContract = createJsonSchemaContract({ schemas: {}, schema });

	try {
		registerDatasetHookContainer(input.cancellationKey, containerName);
		await fs.mkdir(hostStageDir, { recursive: true });
		const { startContainer, runSingleTurnAgentInContainer } = await import("./scan/runtime/run-single-turn-agent");
		await startContainer({
			scanJob,
			taskId: hookId,
			agentProfile: agentProfile as AgentProfileLike,
			containerName,
			codexHome: "/root/.codex",
			stageDirPath: hostStageDir,
			stageRootInContainer,
			taskRealRootInContainer: stageRootInContainer,
			reuseContainer: false,
			datasetAgentRuntime: {
				imageTag: input.image,
				projectName,
				serviceName,
				profileHostDir: input.profileHostRoot,
				workspaceHostPath: input.workspaceHostPath ?? input.profileHostRoot,
				workspaceReadOnly: false,
				inputHostPath: inputDir ? path.join(inputDir, "input.json") : undefined,
			},
		});
		await runWithTimeout(runSingleTurnAgentInContainer({
			scanJob,
			taskId: hookId,
			agentProfile: agentProfile as AgentProfileLike,
			containerName,
			codexHome: "/root/.codex",
			stageDirPath: hostStageDir,
			stageRootInContainer,
			taskStageDirPath: hostStageDir,
			taskStageRootInContainer: stageRootInContainer,
			taskRealRootInContainer: stageRootInContainer,
			reuseContainer: true,
			cwd: "/workspace/repo",
			prompt: `${input.prompt.trim()}\n\nThis is a dataset hook. Work only inside /workspace/repo. Return the structured hook result in /task/output.json. If an input file is present, read $VULSEEK_DATASET_INPUT.`,
			outputSchema: schemaContract,
			datasetAgentRuntime: {
				imageTag: input.image,
				projectName,
				serviceName,
				profileHostDir: input.profileHostRoot,
				workspaceHostPath: input.workspaceHostPath ?? input.profileHostRoot,
				workspaceReadOnly: false,
				inputHostPath: inputDir ? path.join(inputDir, "input.json") : undefined,
			},
		}), input.timeoutSeconds ?? 3_600, `Dataset prompt hook timed out after ${input.timeoutSeconds ?? 3_600}s`);
		const envelope = await readDatasetHookOutput(path.join(hostStageDir, "output.json"), (input.timeoutSeconds ?? 3_600) * 1000);
		validateJsonSchemaContract(schemaContract, envelope.output);
		return envelope.output;
	} finally {
		unregisterDatasetHookContainer(input.cancellationKey, containerName);
		const { removeContainer } = await import("./scan/runtime/run-single-turn-agent").catch(() => ({ removeContainer: async () => {} }));
		await removeContainer(containerName).catch(() => {});
		await fs.rm(hostStageDir, { recursive: true, force: true }).catch(() => {});
		if (inputDir) await fs.rm(inputDir, { recursive: true, force: true }).catch(() => {});
	}
};

const buildCheckoutImage = async (profileId: string, toolsImage: string) => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vulseek-dataset-image-"));
	try {
		const dockerfile = `FROM ${toolsImage}\nRUN mkdir -p /workspace/repo /workspace/dataset\n`;
		await fs.writeFile(path.join(tempDir, "Dockerfile"), dockerfile);
		const imageTag = `vulseek-dataset-profile-${sanitizeSegment(profileId)}:${nanoid(8)}`;
		await execAsync(
			`docker build --pull=false -t ${shellQuote(imageTag)} ${shellQuote(tempDir)}`,
		);
		const { stdout } = await execAsync(
			`docker image inspect --format='{{.Id}}' ${shellQuote(imageTag)}`,
		);
		return { imageTag, imageDigest: stdout.trim() };
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
};

const resolveDatasetToolsImage = async () => {
	const configured =
		process.env.VULSEEK_SCAN_TOOLS_IMAGE?.trim() ||
		process.env.VULSEEK_TOOLS_IMAGE?.trim();
	if (configured) return configured;
	const variant = process.env.VULSEEK_TOOLS_IMAGE_VARIANT?.trim() ||
		(process.env.NODE_ENV === "production" ? "release" : "dev");
	const { stdout } = await execAsync(
		`docker images --format '{{.Repository}}:{{.Tag}}' 'vulseek-scan-tools-${sanitizeSegment(variant)}:*' | head -n 1`,
	);
	const image = stdout.trim();
	if (!image) {
		throw new Error(`No ${variant} scan tools image is available`);
	}
	return image;
};

export const prepareDatasetProfile = async (profileId: string) => {
	const row = await db
		.select({ profile: datasetProfiles, dataset: datasets })
		.from(datasetProfiles)
		.innerJoin(datasets, eq(datasetProfiles.datasetId, datasets.datasetId))
		.where(eq(datasetProfiles.profileId, profileId))
		.limit(1)
		.then((rows) => rows[0]);
	if (!row) throw new Error("Dataset profile not found");

	const hostRoot = row.profile.hostRoot;
	await db
		.update(datasetProfiles)
		.set({ status: "preparing", postCheckoutStatus: "pending", errorMessage: null, updatedAt: new Date().toISOString() })
		.where(eq(datasetProfiles.profileId, profileId));

	try {
		const source = datasetSourceSchema.parse(row.dataset.source);
		const hook = datasetHookSchema.parse(row.dataset.postCheckoutHook);
		await prepareSource(source, hostRoot, row.dataset.organizationId);
		let postCheckoutLog = "";
		let postCheckoutResult: unknown = null;
		if (hook.type === "script") {
			await db.update(datasetProfiles).set({ postCheckoutStatus: "running", updatedAt: new Date().toISOString() }).where(eq(datasetProfiles.profileId, profileId));
			postCheckoutLog = await runPostCheckoutScript(hook.command, hostRoot, await resolveDatasetToolsImage(), hook.timeoutSeconds);
			postCheckoutResult = normalizeDatasetHookResult(postCheckoutLog, row.dataset.postCheckoutSchema);
		} else if (hook.type === "prompt") {
			await db.update(datasetProfiles).set({ postCheckoutStatus: "running", updatedAt: new Date().toISOString() }).where(eq(datasetProfiles.profileId, profileId));
			postCheckoutResult = await runDatasetPromptHook({
				prompt: hook.prompt,
				agentProfileId: hook.agentProfileId,
				organizationId: row.dataset.organizationId,
				profileHostRoot: hostRoot,
				image: await resolveDatasetToolsImage(),
				timeoutSeconds: hook.timeoutSeconds,
				schema: row.dataset.postCheckoutSchema,
			});
		}

		const manifest = await validateDatasetManifest(hostRoot);
		const sourceDigest = await resolveSourceDigest(hostRoot, source);
		const toolsImage = await resolveDatasetToolsImage();
		const checkoutImage = await buildCheckoutImage(profileId, toolsImage);
		await db.transaction(async (tx) => {
			await tx.delete(datasetSamples).where(eq(datasetSamples.profileId, profileId));
			if (manifest.samples.length > 0) {
				await tx.insert(datasetSamples).values(
					manifest.samples.map((sample) => ({
						profileId,
						sampleKey: sample.sampleKey,
						title: sample.title ?? "",
						repositoryPath: sample.repositoryPath,
						scannerInput: sample.scannerInput ?? {},
						evaluatorMetadata: sample.evaluatorMetadata ?? {},
						ordinal: sample.ordinal,
					})),
				);
			}
			await tx
				.update(datasetProfiles)
				.set({
					status: "ready",
					sourceDigest,
					checkoutImage: checkoutImage.imageTag,
					checkoutImageDigest: checkoutImage.imageDigest,
					postCheckoutStatus: hook.type === "none" ? "skipped" : "completed",
					postCheckoutLog: postCheckoutLog || null,
					postCheckoutResult,
					configSnapshot: {
						source,
						postCheckoutHook: hook,
						postCheckoutSchema: row.dataset.postCheckoutSchema,
						postScanHook: datasetHookSchema.parse(row.dataset.postScanHook),
						postScanSchema: row.dataset.postScanSchema,
						postEvaluationHook: datasetHookSchema.parse(row.dataset.postEvaluationHook),
						postEvaluationSchema: row.dataset.postEvaluationSchema,
						manifestPath: `/workspace/dataset/${manifestRelativePath}`,
					},
					errorMessage: null,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(datasetProfiles.profileId, profileId));
		});
		return { profileId, status: "ready" as const, sampleCount: manifest.samples.length, sourceDigest, checkoutImage: checkoutImage.imageTag };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await db.update(datasetProfiles).set({ status: "failed", postCheckoutStatus: "failed", errorMessage: message.slice(0, 4000), updatedAt: new Date().toISOString() }).where(eq(datasetProfiles.profileId, profileId));
		throw error;
	}
};

export const resolveDatasetSampleHostPath = async (sampleId: string) => {
	const row = await db
		.select({ sample: datasetSamples, profile: datasetProfiles })
		.from(datasetSamples)
		.innerJoin(datasetProfiles, eq(datasetSamples.profileId, datasetProfiles.profileId))
		.where(eq(datasetSamples.sampleId, sampleId))
		.limit(1)
		.then((rows) => rows[0]);
	if (!row) throw new Error("Dataset sample not found");
	return resolveDatasetPathInside(row.profile.hostRoot, row.sample.repositoryPath);
};

export const pruneDatasetProfile = async (profileId: string) => {
	const profile = await db
		.select({ profile: datasetProfiles })
		.from(datasetProfiles)
		.where(eq(datasetProfiles.profileId, profileId))
		.limit(1)
		.then((rows) => rows[0]);
	if (!profile) throw new Error("Dataset profile not found");
	const referenced = await db
		.select({ evaluationId: datasetEvaluations.evaluationId })
		.from(datasetEvaluations)
		.where(eq(datasetEvaluations.profileId, profileId))
		.limit(1);
	if (referenced[0]) throw new Error("Dataset profile is referenced by an evaluation");
	await fs.rm(profile.profile.hostRoot, { recursive: true, force: true });
	if (profile.profile.checkoutImage) {
		await execAsync(`docker rmi ${shellQuote(profile.profile.checkoutImage)}`).catch(() => {});
	}
	await db.delete(datasetProfiles).where(eq(datasetProfiles.profileId, profileId));
	return { profileId, status: "pruned" as const };
};

export const resolveDatasetTrialRuntime = async (scanJobId: string) => {
	const row = await db
		.select({
			trial: datasetEvaluationTrials,
			evaluation: datasetEvaluations,
			sample: datasetSamples,
			profile: datasetProfiles,
			dataset: datasets,
		})
		.from(datasetEvaluationTrials)
		.innerJoin(datasetEvaluations, eq(datasetEvaluationTrials.evaluationId, datasetEvaluations.evaluationId))
		.innerJoin(datasetSamples, eq(datasetEvaluationTrials.sampleId, datasetSamples.sampleId))
		.innerJoin(datasetProfiles, eq(datasetSamples.profileId, datasetProfiles.profileId))
		.innerJoin(datasets, eq(datasetEvaluations.datasetId, datasets.datasetId))
		.where(eq(datasetEvaluationTrials.scanJobId, scanJobId))
		.limit(1)
		.then((rows) => rows[0]);
	if (!row) return null;
	const sampleHostPath = await resolveDatasetPathInside(row.profile.hostRoot, row.sample.repositoryPath);
	if (!row.profile.checkoutImage) {
		throw new Error(`Dataset profile ${row.profile.profileId} has no checkout image`);
	}
	return {
		...row,
		sampleHostPath,
		profileHostRoot: row.profile.hostRoot,
		checkoutImage: row.profile.checkoutImage,
	};
};

export const runDatasetScriptHook = async (input: {
	command: string;
	sampleHostPath?: string;
	profileHostRoot: string;
	image: string;
	timeoutSeconds?: number;
	cancellationKey?: string;
	input?: unknown;
}) => {
	const mountPath = input.sampleHostPath ?? input.profileHostRoot;
	const inputDir = await fs.mkdtemp(path.join(os.tmpdir(), "vulseek-dataset-hook-"));
	const containerName = `vulseek-dataset-script-${sanitizeSegment(nanoid(12))}`;
	try {
		const inputPath = path.join(inputDir, "input.json");
		await fs.writeFile(inputPath, `${JSON.stringify(input.input ?? {}, null, 2)}\n`, "utf8");
		registerDatasetHookContainer(input.cancellationKey, containerName);
		const { stdout, stderr } = await execAsync(
			`docker run --rm --name ${shellQuote(containerName)} --network none -v ${shellQuote(`${mountPath}:/workspace/repo:ro`)} -v ${shellQuote(`${inputDir}:/workspace/vulseek-input:ro`)} -w /workspace/repo -e VULSEEK_DATASET_INPUT=/workspace/vulseek-input/input.json ${shellQuote(input.image)} bash -lc ${shellQuote(`timeout --signal=TERM --kill-after=5s ${Math.max(1, input.timeoutSeconds ?? 3_600)}s bash -lc ${shellQuote(input.command)}`)}`,
		);
		return `${stdout}${stderr}`;
	} finally {
		unregisterDatasetHookContainer(input.cancellationKey, containerName);
		await fs.rm(inputDir, { recursive: true, force: true });
	}
};

export const datasetManifestPath = manifestRelativePath;
