import { z } from "zod";
import {
	artifactPathListOf,
	artifactPathOf,
} from "../artifact-schema-annotations";

export const scanTaskStatusSchema = z.enum([
	"pending",
	"launching",
	"launched",
	"starting",
	"running",
	"completed",
	"failed",
	"exited",
	"canceled",
]);

export const vulnerabilityCandidateStageSchema = z.enum([
	"analyzing",
	"verifying",
]);

export const analysisResultEnumSchema = z.enum([
	"real_vulnerability",
	"likely_vulnerability",
	"plausible_but_unproven",
	"false_positive",
]);

export const verificationResultEnumSchema = z.enum([
	"true",
	"likely",
	"false",
]);

export const triageResultEnumSchema = z.enum([
	"security_issue",
	"non_security",
	"hardening",
	"needs_review",
]);

export const triageSecurityClassificationSchema = z.enum([
	"vulnerability",
	"security_hardening",
	"robustness",
	"non_security",
	"unknown",
]);

export const triageCvssSeveritySchema = z.enum([
	"none",
	"low",
	"medium",
	"high",
	"critical",
	"unknown",
]);

export const triageExploitabilitySchema = z.enum([
	"none",
	"theoretical",
	"proof_of_concept",
	"practical",
	"unknown",
]);

export const triageDisqualifierSchema = z.enum([
	"D-0",
	"D-1",
	"D-1.5",
	"D-2",
	"D-3",
	"D-4",
	"D-5",
]);

export const evidenceSchema = z.object({
	id: z.string().min(1),
	kind: z.enum([
		"code",
		"runtime",
		"fuzz",
		"negative",
		"assumption",
		"external",
	]),
	summary: z.string(),
	filePath: z.string().nullable(),
	line: z.number().int().nullable(),
	symbol: z.string().nullable(),
	command: z.string().nullable(),
	artifactPath: z.string().nullable(),
	observation: z.string().nullable(),
	supports: z.array(z.string()),
	contradicts: z.array(z.string()),
	confidenceImpact: z.string().nullable(),
});

export const analysisFeedbackItemSchema = z.object({
	kind: z.enum(["candidate", "critic", "manual"]),
	summary: z.string(),
	evidence: z.array(evidenceSchema),
});

export const repositorySchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	summary: z.string(),
	languages: z.array(z.string()),
	buildSystems: z.array(z.string()),
	runtimeDirectories: z.array(z.string()),
	downrankedDirectories: z.array(z.string()),
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
	role: z.string(),
	reachability: z.string(),
	sourceToSinkHint: z.string().nullable(),
	excludeReason: z.string().nullable(),
	priorityReason: z.string(),
	securityModelRelation: z.string(),
	attackSurface: z.string().nullable(),
	trustBoundary: z.string().nullable(),
	likelyVulnerabilityTypes: z.array(z.string()),
});

export const targetKindSchema = z.enum([
	"function",
	"route-handler",
	"middleware",
	"api-route",
	"server-action",
	"page-loader",
	"controller-action",
	"view-function",
	"resolver",
	"job-handler",
	"cli-command",
	"security-config",
	"template-render",
	"parser-deserializer",
	"data-access",
	"unknown",
]);

export const targetSchema = z
	.object({
		id: z.string().min(1),
		moduleId: z.string().min(1),
		moduleName: z.string().min(1),
		targetId: z.string().min(1),
		targetName: z.string().min(1),
		targetKind: targetKindSchema,
		language: z.string().nullable(),
		framework: z.string().nullable(),
		sourceFiles: z.array(z.string()).min(1),
		filePath: z.string().nullable(),
		line: z.number().int().nullable(),
		routePath: z.string().nullable(),
		httpMethods: z.array(z.string()),
		priority: z.number().int(),
		summary: z.string().nullable(),
		attackerInputs: z.array(z.string()),
		sinks: z.array(z.string()),
		trustBoundary: z.string().nullable(),
		likelyVulnerabilityTypes: z.array(z.string()),
		evidence: z.array(z.string()),
		score: z.number().nullable(),
		excludeReason: z.string().nullable(),
		priorityReason: z.string(),
	})
	.strict();

export const moduleSchema = z
	.object({
		id: z
			.string()
			.min(1)
			.describe(
				"Stable module artifact id. Use the same value as moduleId unless a schema-specific distinction is required.",
			),
		moduleId: z
			.string()
			.min(1)
			.describe(
				"Stable deterministic module identifier. Use lowercase kebab-case and keep it unique within the repository.",
			),
		name: z.string().min(1).describe("Human-readable module display name."),
		summary: z
			.string()
			.describe(
				"Short summary of this module boundary and downstream scan focus.",
			),
		priority: z
			.number()
			.int()
			.describe("Module scan priority. Lower numbers are higher priority."),
		files: z
			.array(z.string())
			.describe(
				"Compact repository-relative files or directories that define this module boundary.",
			),
		entryPoints: z
			.array(z.string())
			.describe(
				"Externally reachable or dispatch entrypoint signals for this module.",
			),
		trustBoundaries: z
			.array(z.string())
			.describe(
				"Trust boundaries or attacker-controlled input boundaries relevant to this module.",
			),
		attackSurfaces: z
			.array(z.string())
			.describe(
				"High-level attack surfaces exposed or processed by this module.",
			),
		vulnerabilityThemes: z
			.array(z.string())
			.describe(
				"Generic vulnerability classes or validation-risk themes worth scanning in this module.",
			),
		runtimeComponents: z
			.array(z.string())
			.describe(
				"Distribution or runtime component labels for this module, such as core library, compatibility layer, embedded integration, kernel integration, language bindings, CLI tools, service runtime, worker runtime, browser runtime, plugin runtime, or deployment/configuration surface.",
			),
		notes: z
			.array(z.string())
			.describe(
				"Short evidence notes, uncertainty notes, or boundary rationale for this module.",
			),
	})
	.describe(
		"Security module artifact used to route downstream module and function scanning.",
	)
	.strict();

export const repositoryModuleSchema = moduleSchema;

export const repositoryScanManifestSchema = z.object({
	repository: artifactPathOf(repositorySchema),
	modules: artifactPathListOf(repositoryModuleSchema),
});

export const deltaScopeManifestSchema = z
	.object({
		repository: artifactPathOf(repositorySchema),
		functions: artifactPathListOf(functionSchema),
	})
	.strict();

export const moduleScanManifestSchema = z.object({
	module: artifactPathOf(moduleSchema),
	functions: artifactPathListOf(functionSchema),
});

export const identifyTargetManifestSchema = z
	.object({
		repository: artifactPathOf(repositorySchema),
		module: artifactPathOf(moduleSchema),
		threatModel: artifactPathOf(z.lazy(() => moduleThreatModelSchema)),
		targets: artifactPathListOf(targetSchema),
	})
	.strict();

export const moduleThreatModelSchema = z
	.object({
		moduleId: z.string().min(1),
		moduleName: z.string().min(1),
		modulePath: z.string().min(1),
		assets: z.array(z.string()),
		entrypoints: z.array(z.string()),
		trustBoundaries: z.array(z.string()),
		attackerInputs: z.array(z.string()),
		sinkClasses: z.array(z.string()),
		likelyVulnerabilityClasses: z.array(z.string()).default([]),
		rulePriorities: z.array(z.string()),
		securityAssumptions: z.array(z.string()).default([]),
		assumptions: z.array(z.string()),
		limitations: z.array(z.string()),
		summary: z.string(),
	})
	.strict();

export const moduleThreatModelManifestSchema = z
	.object({
		repository: artifactPathOf(repositorySchema),
		module: artifactPathOf(moduleSchema),
		threatModel: artifactPathOf(moduleThreatModelSchema),
	})
	.strict();

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
	claim: z.string(),
	rootCauseKey: z.string().nullable(),
	targetId: z.string().nullable().optional(),
	targetKind: targetKindSchema.nullable().optional(),
	evidence: z.array(evidenceSchema),
	attackerControl: z.string().nullable(),
	affectedSink: z.string().nullable(),
	preconditions: z.array(z.string()),
	quickDisproofAttempt: z.string().nullable(),
	needsFuzzing: z.boolean(),
	needsManualAnalysis: z.boolean(),
	status: scanTaskStatusSchema.optional(),
	currentStage: vulnerabilityCandidateStageSchema.optional(),
});

export const functionScanManifestSchema = z.object({
	candidates: artifactPathListOf(candidateSchema),
});

export const scanTargetManifestSchema = functionScanManifestSchema;

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
	analysisFingerprint: z.string().optional(),
	hypothesis: z.string(),
	evidenceTable: z.array(evidenceSchema),
	attackPath: z.array(z.string()),
	blockers: z.array(z.string()),
	rulingRationale: z.string(),
	missingEvidenceRequest: z.array(z.string()),
	feedbackHistory: z.array(analysisFeedbackItemSchema),
	status: scanTaskStatusSchema.optional(),
});

export const criticResponseSchema = z.object({
	id: z.string().min(1),
	stance: z.enum(["object", "convinced"]),
	reviewedAnalysisFingerprint: z.string().min(1),
	summary: z.string(),
	objections: z.array(z.string()),
	requiredAdditionalEvidence: z.array(z.string()),
	codeExistenceChecks: z.array(z.string()),
	citationValidityChecks: z.array(z.string()),
	reachabilityAssessment: z.string(),
	preconditionAssessment: z.string(),
	falsePositiveAlternatives: z.array(z.string()),
	severityExploitabilityAssessment: z.string(),
	refutedClaims: z.array(z.string()),
	missingEvidenceFields: z.array(z.string()),
	suggestedNextAction: z.string().nullable(),
});

export const analysisFeedbackEnvelopeSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("critic"),
		result: criticResponseSchema,
	}),
]);

export const finalAnalysisSchema = analysisSchema.extend({
	analysisFingerprint: z.string().min(1),
	criticApproval: z.object({
		criticTaskId: z.string().min(1),
		reviewedAnalysisFingerprint: z.string().min(1),
		stance: z.literal("convinced"),
		summary: z.string(),
	}),
	evidenceBundle: z.array(evidenceSchema),
	fuzzEvidence: z.array(evidenceSchema),
});

export const verificationSchema = z.object({
	id: z.string().min(1),
	// scanJobId: z.string().min(1),
	// candidateId: z.string().min(1),
	result: verificationResultEnumSchema,
	summary: z.string(),
	confidence: z.number().nullable(),
	score: z.number().nullable(),
	reportPath: z.string().nullable(),
	runtimeSeconds: z.number().nullable(),
	evidenceBundle: z.array(evidenceSchema),
	residualUncertainty: z.array(z.string()),
	status: scanTaskStatusSchema.optional(),
});

export const triageSchema = z.object({
	id: z.string().min(1),
	result: triageResultEnumSchema,
	disqualifier: triageDisqualifierSchema.nullable().default(null),
	disqualifierReason: z.string().nullable().default(null),
	securityClassification: triageSecurityClassificationSchema,
	isSecurityIssue: z.boolean(),
	impactType: z.string(),
	cvssVector: z.string().nullable(),
	cvssScore: z.number().min(0).max(10).nullable(),
	cvssSeverity: triageCvssSeveritySchema,
	exploitability: triageExploitabilitySchema,
	isExploitable: z.boolean().nullable(),
	commonTriggerConditions: z.array(z.string()),
	hardeningOrRobustness: z.boolean(),
	epssProbability30d: z.number().min(0).max(1).nullable(),
	epssSource: z.string(),
	summary: z.string(),
	reportPath: z.string().nullable(),
	runtimeSeconds: z.number().nullable(),
	evidenceBundle: z.array(evidenceSchema),
	residualUncertainty: z.array(z.string()),
	status: scanTaskStatusSchema.optional(),
});

export type Repository = z.infer<typeof repositorySchema>;
export type RepositoryScanManifest = z.infer<
	typeof repositoryScanManifestSchema
>;
export type DeltaScopeManifest = z.infer<typeof deltaScopeManifestSchema>;
export type RepositoryModule = z.infer<typeof repositoryModuleSchema>;
export type Module = z.infer<typeof moduleSchema>;
export type ModuleScanManifest = z.infer<typeof moduleScanManifestSchema>;
export type Target = z.infer<typeof targetSchema>;
export type IdentifyTargetManifest = z.infer<typeof identifyTargetManifestSchema>;
export type ModuleThreatModel = z.infer<typeof moduleThreatModelSchema>;
export type ModuleThreatModelManifest = z.infer<
	typeof moduleThreatModelManifestSchema
>;
export type Function = z.infer<typeof functionSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type Candidate = z.infer<typeof candidateSchema>;
export type FunctionScanManifest = z.infer<typeof functionScanManifestSchema>;
export type ScanTargetManifest = z.infer<typeof scanTargetManifestSchema>;
export type Analysis = z.infer<typeof analysisSchema>;
export type CriticResponse = z.infer<typeof criticResponseSchema>;
export type AnalysisFeedbackEnvelope = z.infer<
	typeof analysisFeedbackEnvelopeSchema
>;
export type FinalAnalysis = z.infer<typeof finalAnalysisSchema>;
export type Verification = z.infer<typeof verificationSchema>;
export type Triage = z.infer<typeof triageSchema>;
