import assert from "node:assert/strict";
import test from "node:test";
import {
	createJsonSchemaContract,
	validateJsonSchemaContract,
	validateJsonSchemaContractArtifacts,
} from "./scan-pipeline-schema-contracts";
import { SCAN_PIPELINE_DEFINITIONS } from "./scan-pipeline-definitions";

const artifactPath = (name: string) => `/task/artifacts/${name}.json`;

const repository = {
	id: "repo-1",
	name: "Demo Repo",
	summary: "Repository summary",
	languages: ["TypeScript"],
	buildSystems: ["pnpm"],
	runtimeDirectories: ["apps/vulseek"],
	downrankedDirectories: ["docs"],
	notes: [],
	targetRef: "main",
	targetTag: null,
	commitSha: "abc123",
	baseSha: null,
	commitWindow: 5,
};

const module = {
	id: "web",
	moduleId: "web",
	name: "Web",
	summary: "Web module",
	priority: 1,
	files: ["apps/vulseek"],
	entryPoints: ["app router"],
	trustBoundaries: ["HTTP"],
	attackSurfaces: ["routes"],
	vulnerabilityThemes: ["authorization"],
	runtimeComponents: ["web runtime"],
	notes: [],
};

const target = {
	id: "target-1",
	moduleId: "web",
	moduleName: "Web",
	targetId: "target-1",
	targetName: "createIssue",
	targetKind: "function",
	language: "TypeScript",
	framework: "Next.js",
	sourceFiles: ["apps/vulseek/app/page.tsx"],
	filePath: "apps/vulseek/app/page.tsx",
	line: 12,
	routePath: null,
	httpMethods: [],
	priority: 1,
	summary: "Creates issue",
	attackerInputs: ["request body"],
	sinks: ["database"],
	trustBoundary: "HTTP",
	likelyVulnerabilityTypes: ["authorization"],
	evidence: ["source line"],
	score: 0.8,
	excludeReason: null,
	priorityReason: "reachable",
};

const threatModel = {
	moduleId: "web",
	moduleName: "Web",
	modulePath: artifactPath("module"),
	assets: ["issues"],
	entrypoints: ["createIssue"],
	trustBoundaries: ["HTTP"],
	attackerInputs: ["request body"],
	sinkClasses: ["database write"],
	likelyVulnerabilityClasses: ["authorization bypass"],
	rulePriorities: [],
	securityAssumptions: [],
	assumptions: [],
	limitations: [],
	summary: "Threat model",
};

const evidence = {
	id: "e1",
	kind: "code",
	summary: "Authorization check is missing.",
	filePath: "apps/vulseek/app/page.tsx",
	line: 12,
	symbol: "createIssue",
	command: null,
	artifactPath: null,
	observation: "No owner check",
	supports: ["claim"],
	contradicts: [],
	confidenceImpact: "raises confidence",
};

const candidate = {
	id: "candidate-1",
	functionId: "target-1",
	title: "Missing owner check",
	description: "Mutating action does not check ownership.",
	filePath: "apps/vulseek/app/page.tsx",
	line: 12,
	vulnerabilityType: "authorization",
	confidence: 0.8,
	score: 0.8,
	claim: "User can mutate another user's issue.",
	rootCauseKey: null,
	evidence: [evidence],
	attackerControl: "request body",
	affectedSink: "database update",
	preconditions: ["authenticated user"],
	quickDisproofAttempt: null,
	needsFuzzing: false,
	needsManualAnalysis: false,
};

const analysis = {
	id: "analysis-1",
	result: "likely_vulnerability",
	summary: "Likely owner check bypass.",
	confidence: 0.8,
	score: 0.8,
	reportPath: "/task/01_report.md",
	runtimeSeconds: 12,
	analysisFingerprint: "fingerprint-1",
	hypothesis: "Missing ownership validation.",
	evidenceTable: [evidence],
	attackPath: ["send request"],
	blockers: [],
	rulingRationale: "Code lacks owner check.",
	missingEvidenceRequest: [],
	feedbackHistory: [],
};

const criticResponse = {
	id: "critic-1",
	stance: "convinced",
	reviewedAnalysisFingerprint: "fingerprint-1",
	summary: "Evidence is sufficient.",
	objections: [],
	requiredAdditionalEvidence: [],
	codeExistenceChecks: [],
	citationValidityChecks: [],
	reachabilityAssessment: "Reachable",
	preconditionAssessment: "Authenticated user",
	falsePositiveAlternatives: [],
	severityExploitabilityAssessment: "Practical",
	refutedClaims: [],
	missingEvidenceFields: [],
	suggestedNextAction: null,
};

const finalAnalysis = {
	...analysis,
	criticApproval: {
		criticTaskId: "critic-task-1",
		reviewedAnalysisFingerprint: "fingerprint-1",
		stance: "convinced",
		summary: "Approved",
	},
	evidenceBundle: [evidence],
	fuzzEvidence: [],
};

const verification = {
	id: "verification-1",
	result: "likely",
	summary: "Likely exploitable.",
	confidence: 0.75,
	score: 0.75,
	reportPath: "/task/01_verify_report.md",
	runtimeSeconds: 20,
	evidenceBundle: [evidence],
	residualUncertainty: [],
};

const triage = {
	id: "triage-1",
	result: "security_issue",
	disqualifier: null,
	disqualifierReason: null,
	securityClassification: "vulnerability",
	isSecurityIssue: true,
	impactType: "authorization bypass",
	cvssVector: null,
	cvssScore: 7.5,
	cvssSeverity: "high",
	exploitability: "practical",
	isExploitable: true,
	commonTriggerConditions: ["authenticated user"],
	hardeningOrRobustness: false,
	epssProbability30d: null,
	epssSource: "not_applicable",
	summary: "Security issue.",
	reportPath: "/task/01_triage_report.md",
	runtimeSeconds: 10,
	evidenceBundle: [evidence],
	residualUncertainty: [],
};

const artifacts: Record<string, unknown> = {
	[artifactPath("repository")]: repository,
	[artifactPath("module")]: module,
	[artifactPath("function")]: {
		id: "function-1",
		moduleId: "web",
		moduleName: "Web",
		functionId: "function-1",
		functionName: "createIssue",
		filePath: "apps/vulseek/app/page.tsx",
		line: 12,
		priority: 1,
		summary: "Create issue",
		vulnerabilityType: "authorization",
		score: 0.8,
		role: "handler",
		reachability: "reachable",
		sourceToSinkHint: "request body to database",
		excludeReason: null,
		priorityReason: "reachable mutating action",
		securityModelRelation: "authorization boundary",
		attackSurface: "HTTP",
		trustBoundary: "HTTP",
		likelyVulnerabilityTypes: ["authorization"],
	},
	[artifactPath("threat-model")]: threatModel,
	[artifactPath("target")]: target,
	[artifactPath("candidate")]: candidate,
};

const contractForStage = (stageId: string) => {
	const stage = SCAN_PIPELINE_DEFINITIONS.stages.find((item) => item.id === stageId);
	assert.ok(stage?.outputSchema, `stage ${stageId} must define outputSchema`);
	return createJsonSchemaContract({
		schemas: SCAN_PIPELINE_DEFINITIONS.schemas,
		schema: stage.outputSchema,
	});
};

const validateStageOutput = async (stageId: string, output: unknown) => {
	const contract = contractForStage(stageId);
	validateJsonSchemaContract(contract, output);
	await validateJsonSchemaContractArtifacts(contract, output, async (path) => {
		const artifact = artifacts[path];
		assert.notEqual(artifact, undefined, `missing artifact fixture ${path}`);
		return artifact;
	});
};

test("YAML stage output schemas validate current scan output shapes", async () => {
	await validateStageOutput("repository-profile", {
		repository: artifactPath("repository"),
		modules: [artifactPath("module")],
	});
	await validateStageOutput("delta-scope", {
		repository: artifactPath("repository"),
		functions: [artifactPath("function")],
	});
	await validateStageOutput("attack-surface-model", {
		repository: artifactPath("repository"),
		module: artifactPath("module"),
		threatModel: artifactPath("threat-model"),
	});
	await validateStageOutput("identify-target", {
		repository: artifactPath("repository"),
		module: artifactPath("module"),
		threatModel: artifactPath("threat-model"),
		targets: [artifactPath("target")],
	});
	await validateStageOutput("scan-target", {
		candidates: [artifactPath("candidate")],
	});
	await validateStageOutput("analyze-finding", analysis);
	await validateStageOutput("critique-finding", criticResponse);
	await validateStageOutput("verify-finding", verification);
	await validateStageOutput("triage-finding", triage);
});

test("verification YAML schema requires string results", () => {
	const verificationSchema = SCAN_PIPELINE_DEFINITIONS.schemas.Verification;
	assert.deepEqual(
		(verificationSchema?.properties as Record<string, unknown> | undefined)?.result,
		{ enum: ["true", "likely", "false"] },
	);

	const contract = contractForStage("verify-finding");
	assert.throws(() => validateJsonSchemaContract(contract, { ...verification, result: true }));
	assert.throws(() => validateJsonSchemaContract(contract, { ...verification, result: false }));
});

test("YAML routed final analysis schema validates critic-approved analysis", () => {
	const edge = SCAN_PIPELINE_DEFINITIONS.pipelines.full.edges.find(
		(item) => item.name === "analyze-finding-to-verify-finding",
	);
	assert.ok(edge?.outputSchema);
	const contract = createJsonSchemaContract({
		schemas: SCAN_PIPELINE_DEFINITIONS.schemas,
		schema: edge.outputSchema,
	});

	validateJsonSchemaContract(contract, finalAnalysis);
});

test("identify-target and scan-target input schemas require vulnerabilityClassFocus", () => {
	const identify = SCAN_PIPELINE_DEFINITIONS.stages.find(
		(stage) => stage.id === "identify-target",
	);
	const scanTarget = SCAN_PIPELINE_DEFINITIONS.stages.find(
		(stage) => stage.id === "scan-target",
	);
	assert.ok(identify?.inputSchema);
	assert.ok(scanTarget?.inputSchema);

	const identifyContract = createJsonSchemaContract({
		schemas: SCAN_PIPELINE_DEFINITIONS.schemas,
		schema: identify.inputSchema,
	});
	const scanContract = createJsonSchemaContract({
		schemas: SCAN_PIPELINE_DEFINITIONS.schemas,
		schema: scanTarget.inputSchema,
	});

	validateJsonSchemaContract(identifyContract, {
		scanJob: {
			scanJobId: "scan-1",
			scanType: "full",
			status: "running",
		},
		repositoryPath: artifactPath("repository"),
		modulePath: artifactPath("module"),
		threatModelPath: artifactPath("threat-model"),
		moduleId: "web",
		moduleName: "Web",
		priority: 1,
		vulnerabilityClassFocus: "authorization bypass",
	});

	validateJsonSchemaContract(scanContract, {
		scanJob: {
			scanJobId: "scan-1",
			scanType: "full",
			status: "running",
		},
		repositoryPath: artifactPath("repository"),
		modulePath: artifactPath("module"),
		threatModelPath: artifactPath("threat-model"),
		targetPath: artifactPath("target"),
		moduleId: "web",
		moduleName: "Web",
		targetId: "target-1",
		targetName: "createIssue",
		targetKind: "function",
		priority: 1,
		vulnerabilityClassFocus: "authorization bypass",
	});
});
