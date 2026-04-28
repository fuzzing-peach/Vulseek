import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { functionSchema, moduleSchema } from "./domain-object.contract";

const moduleFunctionSchema = functionSchema.pick({
	functionId: true,
	functionName: true,
	filePath: true,
	line: true,
	priority: true,
	summary: true,
	riskType: true,
	score: true,
});

const moduleScanSchema = z.object({
	module: moduleSchema.pick({
		moduleId: true,
		name: true,
		summary: true,
	}),
	importantFiles: moduleSchema.shape.importantFiles,
	entryPoints: moduleSchema.shape.entryPoints,
	trustBoundaries: moduleSchema.shape.trustBoundaries,
	attackSurfaces: moduleSchema.shape.attackSurfaces,
	vulnerabilityThemes: moduleSchema.shape.vulnerabilityThemes,
	notes: moduleSchema.shape.notes,
	functions: z.array(moduleFunctionSchema),
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

export const validateModuleScanArtifacts = async (moduleArtifactDir: string) => {
	const moduleScanPath = path.join(moduleArtifactDir, "module_scan.json");
	const moduleScan = moduleScanSchema.parse(
		await readJsonObject(moduleScanPath, "module scan"),
	);

	return {
		moduleScanPath,
		moduleScan,
	};
};
