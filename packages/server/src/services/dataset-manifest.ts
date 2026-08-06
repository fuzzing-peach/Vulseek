import { promises as fs } from "node:fs";
import path from "node:path";
import type { DatasetManifest } from "@vulseek/server/db/schema";
import { z } from "zod";

export const datasetManifestRelativePath = path.join(
	".vulseek",
	"samples.json",
);

export const assertDatasetPathInside = (root: string, relativePath: string) => {
	if (path.isAbsolute(relativePath))
		throw new Error(`Dataset repositoryPath must be relative: ${relativePath}`);
	const resolvedRoot = path.resolve(root);
	const resolved = path.resolve(root, relativePath);
	if (
		resolved !== resolvedRoot &&
		!resolved.startsWith(`${resolvedRoot}${path.sep}`)
	)
		throw new Error(
			`Dataset repositoryPath escapes the profile root: ${relativePath}`,
		);
	return resolved;
};

export const resolveDatasetPathInside = async (
	root: string,
	relativePath: string,
) => {
	const candidate = assertDatasetPathInside(root, relativePath);
	const [realRoot, realCandidate] = await Promise.all([
		fs.realpath(root),
		fs.realpath(candidate),
	]);
	if (
		realCandidate !== realRoot &&
		!realCandidate.startsWith(`${realRoot}${path.sep}`)
	) {
		throw new Error(
			`Dataset repositoryPath resolves outside the profile root: ${relativePath}`,
		);
	}
	return realCandidate;
};

const manifestSchema = z.object({
	version: z.literal(1),
	samples: z
		.array(
			z.object({
				id: z.string().trim().min(1).max(300),
				title: z.string().optional().default(""),
				repositoryPath: z.string().trim().min(1),
				metadata: z.record(z.unknown()).optional().default({}),
			}),
		)
		.min(1),
});

export type ValidatedDatasetManifest = {
	version: 1;
	samples: Array<DatasetManifest["samples"][number] & { ordinal: number }>;
};

export const parseDatasetManifest = (raw: string): ValidatedDatasetManifest => {
	const parsed = manifestSchema.parse(JSON.parse(raw));
	const seenIds = new Set<string>();
	const samples = [];
	for (const [ordinal, sample] of parsed.samples.entries()) {
		if (seenIds.has(sample.id))
			throw new Error(`Duplicate dataset id: ${sample.id}`);
		seenIds.add(sample.id);
		samples.push({ ...sample, ordinal });
	}
	return { version: 1, samples };
};

export const validateDatasetManifest = async (
	hostRoot: string,
): Promise<ValidatedDatasetManifest> => {
	const raw = await fs.readFile(
		path.join(hostRoot, datasetManifestRelativePath),
		"utf8",
	);
	const manifest = parseDatasetManifest(raw);
	for (const sample of manifest.samples) {
		const repositoryPath = await resolveDatasetPathInside(
			hostRoot,
			sample.repositoryPath,
		);
		const stat = await fs.stat(repositoryPath).catch(() => null);
		if (!stat?.isDirectory())
			throw new Error(
				`Dataset sample directory does not exist: ${sample.repositoryPath}`,
			);
	}
	return manifest;
};
