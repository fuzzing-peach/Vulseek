import { promises as fs } from "node:fs";
import path from "node:path";
import type { DatasetManifest } from "@vulseek/server/db/schema";
import { z } from "zod";

export const datasetManifestRelativePath = path.join(".vulseek", "samples.json");

export const sanitizeDatasetSegment = (value: string) =>
	value
		.replace(/[\\/]+/g, "-")
		.replace(/[^a-zA-Z0-9._-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "") || "unknown";

export const resolveDatasetHostRoot = (
	datasetId: string,
	profileId: string,
	environment: NodeJS.ProcessEnv = process.env,
) => {
	const root = environment.VULSEEK_DATASET_HOST_PATH?.trim() || environment.VULSEEK_SCAN_CONTEXT_HOST_PATH?.trim();
	if (!root) throw new Error("Dataset host path is not configured. Set VULSEEK_DATASET_HOST_PATH or VULSEEK_SCAN_CONTEXT_HOST_PATH.");
	return path.join(root, "datasets", sanitizeDatasetSegment(datasetId), "profiles", sanitizeDatasetSegment(profileId));
};

export const assertDatasetPathInside = (root: string, relativePath: string) => {
	if (path.isAbsolute(relativePath)) throw new Error(`Dataset repositoryPath must be relative: ${relativePath}`);
	const resolvedRoot = path.resolve(root);
	const resolved = path.resolve(root, relativePath);
	if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error(`Dataset repositoryPath escapes the profile root: ${relativePath}`);
	return resolved;
};

export const resolveDatasetPathInside = async (root: string, relativePath: string) => {
	const candidate = assertDatasetPathInside(root, relativePath);
	const [realRoot, realCandidate] = await Promise.all([
		fs.realpath(root),
		fs.realpath(candidate),
	]);
	if (realCandidate !== realRoot && !realCandidate.startsWith(`${realRoot}${path.sep}`)) {
		throw new Error(`Dataset repositoryPath resolves outside the profile root: ${relativePath}`);
	}
	return realCandidate;
};

const manifestSchema = z.object({
	version: z.literal(1),
	samples: z.array(z.object({
		sampleKey: z.string().trim().min(1).max(300),
		title: z.string().optional().default(""),
		repositoryPath: z.string().trim().min(1),
		scannerInput: z.record(z.unknown()).optional().default({}),
		evaluatorMetadata: z.record(z.unknown()).optional().default({}),
	})).min(1),
});

export type ValidatedDatasetManifest = {
	version: 1;
	samples: Array<DatasetManifest["samples"][number] & { ordinal: number }>;
};

export const validateDatasetManifest = async (hostRoot: string): Promise<ValidatedDatasetManifest> => {
	const raw = await fs.readFile(path.join(hostRoot, datasetManifestRelativePath), "utf8");
	const parsed = manifestSchema.parse(JSON.parse(raw));
	const seenKeys = new Set<string>();
	const samples = [];
	for (const [ordinal, sample] of parsed.samples.entries()) {
		if (seenKeys.has(sample.sampleKey)) throw new Error(`Duplicate dataset sampleKey: ${sample.sampleKey}`);
		seenKeys.add(sample.sampleKey);
		const repositoryPath = await resolveDatasetPathInside(hostRoot, sample.repositoryPath).catch((error) => {
			throw error;
		});
		const stat = await fs.stat(repositoryPath).catch(() => null);
		if (!stat?.isDirectory()) throw new Error(`Dataset sample directory does not exist: ${sample.repositoryPath}`);
		samples.push({ ...sample, ordinal });
	}
	return { version: 1, samples };
};
