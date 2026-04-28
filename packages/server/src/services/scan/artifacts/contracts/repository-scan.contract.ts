import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { moduleSchema, repositorySchema } from "./domain-object.contract";

const repositoryModuleSchema = moduleSchema.pick({
	moduleId: true,
	name: true,
	summary: true,
	artifactDir: true,
	pathListFile: true,
	priority: true,
});

const repositoryScanSchema = repositorySchema
	.pick({
		name: true,
		summary: true,
		languages: true,
		buildSystems: true,
		runtimeDirectories: true,
		downrankedDirectories: true,
		attackSurfaces: true,
		publicApis: true,
		vulnerabilityThemes: true,
		notes: true,
	})
	.extend({
		modules: z.array(repositoryModuleSchema),
	});

const readJsonObject = async (filePath: string, label: string) => {
	let raw = "";
	try {
		raw = await fs.readFile(filePath, "utf-8");
	} catch (error) {
		throw new Error(
			`${label} file not found at ${filePath}: ${error instanceof Error ? error.message : "unknown error"}`,
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(
			`${label} file contains invalid JSON at ${filePath}: ${error instanceof Error ? error.message : "unknown error"}`,
		);
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${label} file must contain a top-level JSON object`);
	}

	return parsed;
};

export const validateRepositoryScanArtifacts = async (
	repositoryArtifactDir: string,
) => {
	const repositoryScanPath = path.join(
		repositoryArtifactDir,
		"repository_scan.json",
	);
	const repositoryScan = repositoryScanSchema.parse(
		await readJsonObject(repositoryScanPath, "repository scan"),
	);

	return {
		repositoryScanPath,
		repositoryScan,
	};
};
