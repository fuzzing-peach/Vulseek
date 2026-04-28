import { promises as fs } from "node:fs";
import { z } from "zod";
import { candidateSchema as canonicalCandidateSchema } from "./domain-object.contract";

const candidateSchema = canonicalCandidateSchema
	.pick({
		title: true,
		description: true,
		filePath: true,
		line: true,
		confidence: true,
		score: true,
	})
	.extend({
		title: z.string().default(""),
		description: z.string().optional().default(""),
		filePath: z.string().nullable().optional().default(null),
		line: z.number().int().nullable().optional().default(null),
		confidence: z.number().nullable().optional().default(null),
		score: z.number().nullable().optional().default(null),
	});

const functionResultSchema = z.object({
  candidates: z.array(candidateSchema),
});

export type FunctionResultCandidatePayload = z.infer<typeof candidateSchema>;

export const validateFunctionResultFile = async (filePath: string) => {
  let raw = "";
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    throw new Error(`function result file not found at ${filePath}: ${error instanceof Error ? error.message : "unknown error"}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`function result file contains invalid JSON at ${filePath}: ${error instanceof Error ? error.message : "unknown error"}`);
  }

  const result = functionResultSchema.parse(parsed);
  return {
    candidates: result.candidates
      .filter((candidate) => candidate.title.trim().length > 0)
      .map((candidate) => ({
        title: candidate.title,
        description: candidate.description || undefined,
        filePath: candidate.filePath ?? undefined,
        line: candidate.line ?? undefined,
        confidence: candidate.confidence ?? undefined,
        score: candidate.score ?? undefined,
      })),
  };
};
