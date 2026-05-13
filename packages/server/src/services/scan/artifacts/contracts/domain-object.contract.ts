import { z } from "zod";

export const scanTaskStatusSchema = z.enum([
	"pending",
	"launching",
	"running",
	"completed",
	"failed",
]);

export const vulnerabilityCandidateStageSchema = z.enum([
	"analyzing",
	"fuzzing",
	"verifying",
]);

export const analysisResultEnumSchema = z.enum([
	"real_vulnerability",
	"likely_vulnerability",
	"plausible_but_unproven",
	"false_positive",
]);

export const verificationResultEnumSchema = z.enum([
	"real_vulnerability",
	"likely_vulnerability",
	"plausible_but_unproven",
	"false_positive",
	"api_misuse",
]);

export const repositorySchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	summary: z.string(),
	languages: z.array(z.string()),
	buildSystems: z.array(z.string()),
	runtimeDirectories: z.array(z.string()),
	downrankedDirectories: z.array(z.string()),
	attackSurfaces: z.array(z.string()),
	publicApis: z.array(z.string()),
	vulnerabilityThemes: z.array(z.string()),
	notes: z.array(z.string()),
	targetRef: z.string().nullable(),
	targetTag: z.string().nullable(),
	commitSha: z.string().nullable(),
	baseSha: z.string().nullable(),
	commitWindow: z.number().int().nonnegative(),
});

export const functionSchema = z.object({
	id: z.string().min(1),
	moduleId: z.string().min(1),
	moduleName: z.string().min(1),
	functionId: z.string().min(1),
	functionName: z.string().min(1),
	filePath: z.string().nullable(),
	line: z.number().int().nullable(),
	priority: z.number().int(),
	summary: z.string().nullable(),
	vulnerabilityType: z.string().nullable(),
	score: z.number().nullable(),
});

export const moduleSchema = z.object({
	id: z.string().min(1),
	moduleId: z.string().min(1),
	name: z.string().min(1),
	summary: z.string(),
	priority: z.number().int(),
	files: z.array(z.string()),
	entryPoints: z.array(z.string()),
	trustBoundaries: z.array(z.string()),
	attackSurfaces: z.array(z.string()),
	vulnerabilityThemes: z.array(z.string()),
	notes: z.array(z.string()),
	functions: z.array(functionSchema).optional(),
});

export const candidateSchema = z.object({
	id: z.string().min(1),
	// scanJobId: z.string().min(1),
	// repositoryId: z.string().min(1),
	// moduleTaskId: z.string().nullable(),
	// functionTaskId: z.string().nullable(),
	functionId: z.string().nullable(),
	title: z.string().min(1),
	description: z.string(),
	filePath: z.string().nullable(),
	line: z.number().int().nullable(),
	vulnerabilityType: z.string().nullable(),
	confidence: z.number().nullable(),
	score: z.number().nullable(),
	status: scanTaskStatusSchema.optional(),
	currentStage: vulnerabilityCandidateStageSchema.optional(),
});

export const analysisSchema = z.object({
	id: z.string().min(1),
	// scanJobId: z.string().min(1),
	// candidateId: z.string().min(1),
	result: analysisResultEnumSchema,
	summary: z.string(),
	confidence: z.number().nullable(),
	score: z.number().nullable(),
	reportPath: z.string().nullable(),
	runtimeSeconds: z.number().nullable(),
	status: scanTaskStatusSchema.optional(),
});

export const verificationSchema = z.object({
	id: z.string().min(1),
	// scanJobId: z.string().min(1),
	// candidateId: z.string().min(1),
	result: verificationResultEnumSchema,
	isBug: z.boolean().nullable(),
	isSecurity: z.boolean().nullable(),
	summary: z.string(),
	confidence: z.number().nullable(),
	score: z.number().nullable(),
	reportPath: z.string().nullable(),
	issueDraftPath: z.string().nullable(),
	pocPath: z.string().nullable(),
	dockerfilePath: z.string().nullable(),
	runScriptPath: z.string().nullable(),
	runtimeSeconds: z.number().nullable(),
	status: scanTaskStatusSchema.optional(),
});

export type Repository = z.infer<typeof repositorySchema>;
export type Module = z.infer<typeof moduleSchema>;
export type Function = z.infer<typeof functionSchema>;
export type Candidate = z.infer<typeof candidateSchema>;
export type Analysis = z.infer<typeof analysisSchema>;
export type Verification = z.infer<typeof verificationSchema>;
