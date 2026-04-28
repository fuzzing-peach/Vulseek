import { promises as fs } from "node:fs";
import { z } from "zod";
import { analysisSchema } from "./domain-object.contract";

const normalizeAnalysisResult = (value: string | undefined) => {
	const normalized = (value || "")
		.trim()
		.toLowerCase()
		.replace(/\s+/g, "_")
		.replace(/-/g, "_");

	switch (normalized) {
		case "real_vulnerability":
			return "real_vulnerability";
		case "likely_vulnerability":
			return "likely_vulnerability";
		case "plausible_but_unproven":
		case "weak_hypothesis":
			return "plausible_but_unproven";
		case "false_positive":
			return "false_positive";
		default:
			return normalized || "plausible_but_unproven";
	}
};

const analysisResultSchema = analysisSchema
	.pick({
		result: true,
		summary: true,
		confidence: true,
		score: true,
	})
	.extend({
		result: z
			.string()
			.min(1, "analysis result file must contain a non-empty result field")
			.transform(normalizeAnalysisResult),
		summary: z.string().optional().default(""),
		confidence: z.number().nullable().optional().default(null),
		score: z.number().nullable().optional().default(null),
	});

export type AnalysisResultPayload = z.infer<typeof analysisResultSchema>;

export const validateAnalysisResultFile = async (filePath: string) => {
	let raw = "";
	try {
		raw = await fs.readFile(filePath, "utf-8");
	} catch (error) {
		throw new Error(
			`analysis result file not found at ${filePath}: ${error instanceof Error ? error.message : "unknown error"}`,
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(
			`analysis result file contains invalid JSON at ${filePath}: ${error instanceof Error ? error.message : "unknown error"}`,
		);
	}

	return analysisResultSchema.parse(parsed);
};
