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
	datasetSourceSchema,
} from "@vulseek/server/db/schema";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { execAsync } from "../utils/process/execAsync";
import {
	datasetManifestRelativePath,
	resolveDatasetPathInside,
	resolveDatasetHostRoot as resolveDatasetHostRootContract,
	validateDatasetManifest as validateDatasetManifestContract,
} from "./dataset-contracts";

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
		.set({ status: "preparing", errorMessage: null, updatedAt: new Date().toISOString() })
		.where(eq(datasetProfiles.profileId, profileId));

	try {
		const source = datasetSourceSchema.parse(row.dataset.source);
		await prepareSource(source, hostRoot, row.dataset.organizationId);
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
					configSnapshot: {
						source,
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
		await db.update(datasetProfiles).set({ status: "failed", errorMessage: message.slice(0, 4000), updatedAt: new Date().toISOString() }).where(eq(datasetProfiles.profileId, profileId));
		throw error;
	}
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

export const datasetManifestPath = manifestRelativePath;
