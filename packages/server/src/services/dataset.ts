import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { db } from "@vulseek/server/db";
import {
	datasetEvaluations,
	datasetEvaluationTrials,
	datasetProfiles,
	datasetSamples,
	datasets,
} from "@vulseek/server/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { execAsync } from "../utils/process/execAsync";
import {
	assertDatasetPathInside,
	datasetManifestRelativePath,
	parseDatasetManifest,
	validateDatasetManifest as validateDatasetManifestContract,
} from "./dataset-manifest";

const shellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

const sanitizeSegment = (value: string) =>
	value
		.replace(/[\\/]+/g, "-")
		.replace(/[^a-zA-Z0-9._-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "") || "unknown";

export const validateDatasetManifest = validateDatasetManifestContract;
const manifestRelativePath = datasetManifestRelativePath;

const readDatasetManifestInCheckoutContainer = async (
	hostRoot: string,
	toolsImage: string,
) => {
	const configuredScanContextHostRoot =
		process.env.VULSEEK_SCAN_CONTEXT_HOST_PATH?.trim();
	if (!configuredScanContextHostRoot) {
		throw new Error(
			"Scan context host path is not configured for dataset checkout output",
		);
	}
	const scanContextAppRoot =
		process.env.VULSEEK_SCAN_CONTEXT_APP_PATH?.trim() ||
		configuredScanContextHostRoot;
	await fs.mkdir(path.join(scanContextAppRoot, "tmp"), { recursive: true });
	const outputAppRoot = await fs.mkdtemp(
		path.join(scanContextAppRoot, "tmp", "vulseek-dataset-checkout-"),
	);
	const outputHostRoot = path.resolve(
		configuredScanContextHostRoot,
		path.relative(scanContextAppRoot, outputAppRoot),
	);
	const validationScript = [
		"import json, os",
		"root = os.path.realpath('/dataset')",
		"with open('/dataset/.vulseek/samples.json', encoding='utf-8') as handle: manifest = json.load(handle)",
		"for sample in manifest.get('samples', []):",
		"    relative = sample.get('repositoryPath')",
		"    if not isinstance(relative, str) or os.path.isabs(relative): raise RuntimeError(f'Invalid dataset repositoryPath: {relative!r}')",
		"    candidate = os.path.realpath(os.path.join('/dataset', relative))",
		"    if candidate != root and not candidate.startswith(root + os.sep): raise RuntimeError(f'Dataset repositoryPath escapes the profile root: {relative}')",
		"    if not os.path.isdir(candidate): raise RuntimeError(f'Dataset sample directory does not exist: {relative}')",
		"temporary_output = '/result/manifest.json.tmp'",
		"with open(temporary_output, 'w', encoding='utf-8') as handle: json.dump(manifest, handle, ensure_ascii=False, separators=(',', ':'))",
		"os.replace(temporary_output, '/result/manifest.json')",
		"print('validated sampleCount=' + str(len(manifest.get('samples', []))))",
	].join("\n");
	const command = [
		"docker run --rm --network none",
		"--mount type=bind,source=" +
			shellQuote(hostRoot) +
			",target=/dataset,readonly",
		"--mount type=bind,source=" +
			shellQuote(outputHostRoot) +
			",target=/result",
		shellQuote(toolsImage),
		"bash -lc",
		shellQuote(["python3 - <<'PY'", validationScript, "PY"].join("\n")),
	].join(" ");
	try {
		await execAsync(command);
		return await fs.readFile(path.join(outputAppRoot, "manifest.json"), "utf8");
	} finally {
		await fs.rm(outputAppRoot, { recursive: true, force: true });
	}
};

const buildCheckoutImage = async (profileId: string, toolsImage: string) => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "vulseek-dataset-image-"),
	);
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
	const variant =
		process.env.VULSEEK_TOOLS_IMAGE_VARIANT?.trim() ||
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

	await db
		.update(datasetProfiles)
		.set({
			status: "preparing",
			errorMessage: null,
			updatedAt: new Date().toISOString(),
		})
		.where(eq(datasetProfiles.profileId, profileId));

	try {
		if (
			!row.profile.hostRoot.trim() ||
			!path.isAbsolute(row.profile.hostRoot)
		) {
			throw new Error(
				"Dataset Profile local path must be an absolute directory path",
			);
		}
		const hostRoot = path.resolve(row.profile.hostRoot);
		const source = { type: "local" as const, path: hostRoot };
		const toolsImage = await resolveDatasetToolsImage();
		const manifest = parseDatasetManifest(
			await readDatasetManifestInCheckoutContainer(hostRoot, toolsImage),
		);
		const manifestSampleIds = new Set(
			manifest.samples.map((sample) => sample.id),
		);
		const selectedSampleIds = row.profile.selectedSampleIds.filter((sampleId) =>
			manifestSampleIds.has(sampleId),
		);
		const checkoutImage = await buildCheckoutImage(profileId, toolsImage);
		await db.transaction(async (tx) => {
			await tx
				.delete(datasetSamples)
				.where(eq(datasetSamples.profileId, profileId));
			if (manifest.samples.length > 0) {
				await tx.insert(datasetSamples).values(
					manifest.samples.map((sample) => ({
						profileId,
						id: sample.id,
						title: sample.title ?? "",
						repositoryPath: sample.repositoryPath,
						metadata: sample.metadata ?? {},
						ordinal: sample.ordinal,
					})),
				);
			}
			await tx
				.update(datasetProfiles)
				.set({
					status: "ready",
					hostRoot,
					selectedSampleIds,
					sourceDigest: null,
					checkoutImage: checkoutImage.imageTag,
					checkoutImageDigest: checkoutImage.imageDigest,
					configSnapshot: {
						source,
						manifestPath: path.join(hostRoot, manifestRelativePath),
					},
					errorMessage: null,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(datasetProfiles.profileId, profileId));
		});
		return {
			profileId,
			status: "ready" as const,
			sampleCount: manifest.samples.length,
			sourceDigest: null,
			checkoutImage: checkoutImage.imageTag,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await db
			.update(datasetProfiles)
			.set({
				status: "failed",
				errorMessage: message.slice(0, 4000),
				updatedAt: new Date().toISOString(),
			})
			.where(eq(datasetProfiles.profileId, profileId));
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
	if (referenced[0])
		throw new Error("Dataset profile is referenced by an evaluation");
	if (profile.profile.checkoutImage) {
		await execAsync(
			`docker rmi ${shellQuote(profile.profile.checkoutImage)}`,
		).catch(() => {});
	}
	await db
		.delete(datasetProfiles)
		.where(eq(datasetProfiles.profileId, profileId));
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
		.innerJoin(
			datasetEvaluations,
			eq(datasetEvaluationTrials.evaluationId, datasetEvaluations.evaluationId),
		)
		.innerJoin(
			datasetSamples,
			eq(datasetEvaluationTrials.sampleId, datasetSamples.sampleId),
		)
		.innerJoin(
			datasetProfiles,
			eq(datasetSamples.profileId, datasetProfiles.profileId),
		)
		.innerJoin(datasets, eq(datasetEvaluations.datasetId, datasets.datasetId))
		.where(eq(datasetEvaluationTrials.scanJobId, scanJobId))
		.limit(1)
		.then((rows) => rows[0]);
	if (!row) return null;
	const sampleHostPath = assertDatasetPathInside(
		row.profile.hostRoot,
		row.sample.repositoryPath,
	);
	if (!row.profile.checkoutImage) {
		throw new Error(
			`Dataset profile ${row.profile.profileId} has no checkout image`,
		);
	}
	return {
		...row,
		sampleHostPath,
		profileHostRoot: row.profile.hostRoot,
		checkoutImage: row.profile.checkoutImage,
	};
};

export const datasetManifestPath = manifestRelativePath;
