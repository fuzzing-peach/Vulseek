import { promises as fs } from "node:fs";
import { z } from "zod";
import { verificationSchema } from "./domain-object.contract";

const normalizeVerificationResult = (value: string | undefined) => {
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
		case "api_misuse":
			return "api_misuse";
		default:
			return normalized || "plausible_but_unproven";
	}
};

const verificationResultSchema = verificationSchema
	.pick({
		result: true,
		summary: true,
		isBug: true,
		isSecurity: true,
		confidence: true,
		score: true,
	})
	.extend({
		result: z
			.string()
			.min(1, "verification result file must contain a non-empty result field")
			.transform(normalizeVerificationResult),
		summary: z.string().optional().default(""),
		isBug: z.boolean().nullable().optional().default(null),
		isSecurity: z.boolean().nullable().optional().default(null),
		confidence: z.number().nullable().optional().default(null),
		score: z.number().nullable().optional().default(null),
	});

export type VerificationResultPayload = z.infer<
	typeof verificationResultSchema
>;

export const validateVerificationResultFile = async (filePath: string) => {
	let raw = "";
	try {
		raw = await fs.readFile(filePath, "utf-8");
	} catch (error) {
		throw new Error(
			`verification result file not found at ${filePath}: ${error instanceof Error ? error.message : "unknown error"}`,
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(
			`verification result file contains invalid JSON at ${filePath}: ${error instanceof Error ? error.message : "unknown error"}`,
		);
	}

	return verificationResultSchema.parse(parsed);
};
