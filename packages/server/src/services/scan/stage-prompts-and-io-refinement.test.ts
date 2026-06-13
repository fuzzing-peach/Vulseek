import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	buildFuzzerRequestSchema,
	candidateSchema,
	deltaScopeManifestSchema,
	functionScanManifestSchema,
	moduleScanManifestSchema,
	moduleSchema,
	repositoryModuleSchema,
	repositoryScanManifestSchema,
	triageSchema,
	verificationSchema,
} from "./artifacts/contracts/domain-object.contract";
import { buildFunctionScannerPrompt } from "./prompts/function-scanner.prompt";
import { buildDeltaScopePrompt } from "./prompts/delta-scope.prompt";
import { buildModuleScannerPrompt } from "./prompts/module-scanner.prompt";
import { buildRepositoryScannerPrompt } from "./prompts/repository-scanner.prompt";
import { buildStructuredOutputPromptSuffix } from "./runtime/run-single-turn-agent";

const scanDir = dirname(fileURLToPath(import.meta.url));
const readStagePromptTemplate = (fileName: string) =>
	readFileSync(join(scanDir, "stages", fileName), "utf-8");
const readSkillSource = (skillName: string) =>
	readFileSync(
		join(scanDir, "../../../../../agents/skills", skillName, "SKILL.md"),
		"utf-8",
	);

const evidence = {
	id: "e1",
	kind: "code" as const,
	summary: "Bounds check is after the indexed read.",
	filePath: "src/parser.c",
	line: 42,
	symbol: "parse_record",
	command: null,
	artifactPath: null,
	observation: "read happens before length validation",
	supports: ["candidate-claim"],
	contradicts: [],
	confidenceImpact: "raises confidence",
};

test("refined schemas keep module artifacts concise and require function context/evidence fields", () => {
	assert.equal(
		repositoryModuleSchema.safeParse({
			id: "tls-parser",
			moduleId: "tls-parser",
			name: "TLS Parser",
			summary: "Parser planning context",
			priority: 1,
			files: ["src/parser.c"],
			notes: [],
		}).success,
		false,
	);

	assert.equal(
		repositoryModuleSchema.safeParse({
			id: "tls-parser",
			moduleId: "tls-parser",
			name: "TLS Parser",
			summary: "Parser planning context",
			priority: 1,
			files: ["src/parser.c"],
			entryPoints: ["parse_record"],
			trustBoundaries: ["network"],
			attackSurfaces: ["TLS records"],
			vulnerabilityThemes: ["memory safety"],
			runtimeComponents: ["core library"],
			notes: [],
		}).success,
		true,
	);

	assert.equal(
		moduleSchema.safeParse({
			id: "tls-parser",
			moduleId: "tls-parser",
			name: "TLS Parser",
			summary: "Parser security model",
			priority: 1,
			files: ["src/parser.c"],
			entryPoints: ["parse_record"],
			trustBoundaries: ["network"],
			attackSurfaces: ["TLS records"],
			vulnerabilityThemes: ["memory safety"],
			runtimeComponents: ["core library"],
			notes: [],
		}).success,
		true,
	);

	assert.equal(
		moduleSchema.safeParse({
			id: "tls-parser",
			moduleId: "tls-parser",
			name: "TLS Parser",
			summary: "Parser security model",
			priority: 1,
			files: ["src/parser.c"],
			entryPoints: ["parse_record"],
			trustBoundaries: ["network"],
			attackSurfaces: ["TLS records"],
			vulnerabilityThemes: ["memory safety"],
			runtimeComponents: ["core library"],
			notes: [],
			functions: [
				{
					id: "parse_record",
					moduleId: "tls-parser",
					moduleName: "TLS Parser",
					functionId: "parse_record",
					functionName: "parse_record",
					filePath: "src/parser.c",
					line: 42,
					priority: 1,
					summary: "Parses a TLS record",
					vulnerabilityType: "out-of-bounds read",
					score: 7,
					role: "entry point",
					reachability: "reachable from network input",
					sourceToSinkHint: "record length to indexed read",
					excludeReason: null,
					priorityReason: "crosses the network trust boundary",
					securityModelRelation: "entry point and parser boundary",
					attackSurface: "TLS records",
					trustBoundary: "network",
					likelyVulnerabilityTypes: ["out-of-bounds read"],
				},
			],
		}).success,
		false,
	);

	assert.equal(
		candidateSchema.safeParse({
			id: "c1",
			functionId: "parse_record",
			title: "Unchecked record length read",
			description: "Potential out-of-bounds read.",
			filePath: "src/parser.c",
			line: 42,
			vulnerabilityType: "out-of-bounds read",
			confidence: 0.5,
			score: 7,
			claim: "record length can drive an indexed read before validation",
			rootCauseKey: "late-length-check",
			evidence: [evidence],
			attackerControl: "network record length",
			affectedSink: "indexed buffer read",
			preconditions: ["malformed record reaches parser"],
			quickDisproofAttempt: "looked for earlier length check",
			needsFuzzing: true,
			needsManualAnalysis: true,
		}).success,
		true,
	);
});

test("repository, module, and function prompts stay concise while delegating detail to skills", () => {
	const repositoryPrompt = buildRepositoryScannerPrompt({
		repository: { id: "repo", name: "wolfSSL" },
		repositoryRoot: "/workspace/repo",
		repositoryState: {
			currentBranch: "master",
			targetRef: "master",
			currentExactTag: null,
			targetTag: null,
			resolvedTargetSha: "abc",
		},
		repositoryStatePath: "/task/00_repository_state.json",
		agentProvider: "codex",
	});
	assert.match(repositoryPrompt, /scan-repository skill/);
	assert.match(repositoryPrompt, /entryPoints, trustBoundaries, attackSurfaces, vulnerabilityThemes, and runtimeComponents/);
	assert.match(repositoryPrompt, /at least 4 modules and no more than 20 modules/);
	assert.doesNotMatch(repositoryPrompt, /attackerControlledInputs/);
	assert.doesNotMatch(repositoryPrompt, /dangerousSinks/);

	const repositorySkill = readSkillSource("scan-repository");
	assert.match(repositorySkill, /Required range for normal repositories: 4 to 20 modules/i);
	assert.match(repositorySkill, /source of truth/i);
	assert.match(repositorySkill, /Externally reachable entry points/i);
	assert.match(repositorySkill, /Trust boundaries and attacker-controlled input boundaries/i);
	assert.doesNotMatch(repositorySkill, /securityModel/);
	assert.doesNotMatch(repositorySkill, /dangerousSinks/);

	const modulePrompt = buildModuleScannerPrompt({
		scanJobId: "job",
		moduleId: "tls-parser",
		moduleName: "TLS Parser",
		repositoryJsonPath: "/task/inputs/repository.json",
		moduleJsonPath: "/task/inputs/module.json",
	});
	assert.match(modulePrompt, /scan-module skill/);
	assert.match(modulePrompt, /canonical module object/);
	assert.doesNotMatch(modulePrompt, /sourceToSinkHint/);

	const moduleSkill = readSkillSource("scan-module");
	assert.match(
		moduleSkill,
		/attack surface, trust boundary, entry point, or validation stack/,
	);
	assert.match(moduleSkill, /tree-sitter extracted symbol identity/i);
	assert.match(moduleSkill, /worth scanning now/i);
	assert.match(moduleSkill, /do not require global unique ownership/i);

	const functionPrompt = buildFunctionScannerPrompt({
		scanJobId: "job",
		moduleId: "tls-parser",
		moduleName: "TLS Parser",
		functionId: "parse_record",
		functionName: "parse_record",
		repositoryJsonPath: "/task/inputs/repository.json",
		moduleJsonPath: "/task/inputs/module.json",
		functionJsonPath: "/task/inputs/function.json",
	});
	assert.match(functionPrompt, /scan-function skill/);
	assert.match(functionPrompt, /candidates/);
	assert.doesNotMatch(functionPrompt, /needsFuzzing/);

	const functionSkill = readSkillSource("scan-function");
	assert.match(functionSkill, /needsFuzzing/);
	assert.match(functionSkill, /complex control flow, state/);
	assert.match(functionSkill, /structured evidence/i);
});

test("delta scope prompt and schema stay limited to repository and functions", () => {
	assert.equal(
		deltaScopeManifestSchema.safeParse({
			repository: "/task/repository.json",
			functions: ["/task/functions/parse_record.json"],
		}).success,
		true,
	);
	assert.equal(
		deltaScopeManifestSchema.safeParse({
			repository: "/task/repository.json",
			functions: [],
		}).success,
		true,
	);
	assert.equal(
		deltaScopeManifestSchema.safeParse({
			repository: "/task/repository.json",
			module: "/task/module.json",
			functions: [],
		}).success,
		false,
	);

	const deltaScopePrompt = buildDeltaScopePrompt({
		repository: { id: "repo", name: "wolfSSL" },
		repositoryState: {
			currentBranch: "master",
			targetRef: "master",
			currentExactTag: null,
			targetTag: null,
			resolvedTargetSha: "abc",
			resolvedBaseSha: "def",
			commitWindow: 3,
		},
		repositoryStatePath: "/task/00_repository_state.json",
		agentProvider: "codex",
	});
	assert.match(deltaScopePrompt, /delta-scope as your working method/);
	assert.match(
		deltaScopePrompt,
		/\/workspace\/repo\/\.agents\/skills\/delta-scope\/SKILL\.md/,
	);
	assert.match(deltaScopePrompt, /repository/);
	assert.match(deltaScopePrompt, /functions/);
	assert.match(deltaScopePrompt, /Do not write or return a module artifact/);
	assert.match(deltaScopePrompt, /\{ "repository": "\/task\/repository\.json", "functions": \[\] \}/);

	const deltaScopeSkill = readSkillSource("delta-scope");
	assert.match(deltaScopeSkill, /impact scoping only/i);
	assert.match(deltaScopeSkill, /Do not write module artifacts/i);
	assert.match(deltaScopeSkill, /functions/);
});

test("stage boundary manifests use task artifact paths instead of object lists", () => {
	assert.equal(
		repositoryScanManifestSchema.safeParse({
			repository: "/task/repository.json",
			modules: ["/task/modules/tls.json"],
		}).success,
		true,
	);
	assert.equal(
		repositoryScanManifestSchema.safeParse({
			repository: "/task/repository.json",
			modules: [
				{
					id: "tls",
					moduleId: "tls",
					name: "TLS",
				},
			],
		}).success,
		false,
	);
	assert.equal(
		moduleScanManifestSchema.safeParse({
			module: "/task/module.json",
			functions: ["/task/functions/wolfSSL_connect.json"],
		}).success,
		true,
	);
	assert.equal(
		functionScanManifestSchema.safeParse({
			candidates: ["/task/candidates/c1.json"],
		}).success,
		true,
	);
	assert.equal(
		functionScanManifestSchema.safeParse({
			candidates: ["candidates/c1.json"],
		}).success,
		false,
	);
});

test("structured output prompts include annotated task artifact schemas", () => {
	const suffix = buildStructuredOutputPromptSuffix(
		repositoryScanManifestSchema,
		"/task/output.schema.json",
		"/task/output.json",
	);
	assert.match(suffix, /Task artifact JSON schemas/);
	assert.match(suffix, /output\.repository points to a JSON file/);
	assert.match(suffix, /output\.modules\[\] points to JSON files/);
	assert.match(suffix, /"runtimeDirectories"/);
	assert.doesNotMatch(suffix, /"runtimeAttackSurfaces"/);
	assert.doesNotMatch(suffix, /"testGeneratedExclusions"/);
	assert.doesNotMatch(suffix, /"securityModel"/);
	assert.doesNotMatch(suffix, /"dangerousSinks"/);
	assert.doesNotMatch(suffix, /"publicApis"/);
	assert.doesNotMatch(suffix, /"buildRunHints"/);
	assert.match(suffix, /"entryPoints"/);
	assert.match(suffix, /"trustBoundaries"/);
	assert.match(suffix, /"attackSurfaces"/);
	assert.match(suffix, /"vulnerabilityThemes"/);
	assert.match(suffix, /"runtimeComponents"/);
	assert.match(suffix, /Distribution or runtime component labels/);
	assert.doesNotMatch(suffix, /"functionName"/);
	assert.doesNotMatch(suffix, /"sourceToSinkHint"/);

	const moduleSuffix = buildStructuredOutputPromptSuffix(
		moduleScanManifestSchema,
		"/task/output.schema.json",
		"/task/output.json",
	);
	assert.match(moduleSuffix, /"entryPoints"/);
	assert.match(moduleSuffix, /"trustBoundaries"/);
	assert.match(moduleSuffix, /"attackSurfaces"/);
	assert.match(moduleSuffix, /"vulnerabilityThemes"/);
	assert.match(moduleSuffix, /"runtimeComponents"/);

	const persistentSuffix = buildStructuredOutputPromptSuffix(
		functionScanManifestSchema,
		"/task/output.schema.json",
		"/task/output.json",
		undefined,
		{ persistent: true },
	);
	assert.match(persistentSuffix, /Set exit to false/);
	assert.doesNotMatch(persistentSuffix, /Set exit to true/);

	const analysisExitSuffix = buildStructuredOutputPromptSuffix(
		functionScanManifestSchema,
		"/task/output.schema.json",
		"/task/output.json",
		undefined,
		{ allowAgentExit: true },
	);
	assert.match(analysisExitSuffix, /stage prompt explicitly instructs/);
});

test("analysis and fuzz prompts allow exploration-oriented fuzzing without route changes", () => {
	const analysisPromptTemplate = readStagePromptTemplate("analyze.prompt.md");
	assert.match(analysisPromptTemplate, /analyze/);
	assert.match(analysisPromptTemplate, /build_fuzzer/);
	assert.match(analysisPromptTemplate, /verification/);

	const deepAnalysisSkill = readSkillSource("analyze");
	assert.match(
		deepAnalysisSkill,
		/Need fuzzing evidence or dynamic exploration/,
	);
	assert.match(
		deepAnalysisSkill,
		/Do not reserve fuzzing only for strong vulnerability claims/,
	);

	assert.equal(
		buildFuzzerRequestSchema.safeParse({
			id: "request",
			candidateId: "c1",
			analysisFingerprint: "fp",
			fuzzGoal: "exploration",
			entryToCandidatePath: ["parse_record"],
			harnessRequirements: "drive parser with generated records",
			harnessEntry: "parse_record",
			inputModel: "TLS record bytes",
			expectedOracle: "sanitizer or parser invariant failure",
			seedCorpusHints: ["valid empty record"],
			buildCommandHints: ["cargo build"],
			sanitizerRuntimeAssumptions: ["ASAN enabled"],
			expectedTriggerCondition: "unexpected parser state or sanitizer finding",
			targetFunction: "parse_record",
			targetFilePath: "src/parser.c",
			notes: [],
		}).success,
		true,
	);

	const buildPromptTemplate = readStagePromptTemplate("build-fuzzer.prompt.md");
	assert.match(buildPromptTemplate, /build-fuzzer skill/);
	assert.match(buildPromptTemplate, /run_fuzzer/);
	assert.match(buildPromptTemplate, /analysis/);
	const buildSkill = readSkillSource("build-fuzzer");
	assert.match(buildSkill, /`evidence`/);
	assert.match(buildSkill, /`exploration`/);

	const runPromptTemplate = readStagePromptTemplate("run-fuzzer.prompt.md");
	assert.match(runPromptTemplate, /run-fuzzer skill/);
	assert.match(runPromptTemplate, /Always route back to analysis/);
	const runSkill = readSkillSource("run-fuzzer");
	assert.match(runSkill, /path\/state exploration/);
	assert.match(runSkill, /newly reached paths or states/);
});

test("verification is a three-value sanity check and triage owns security classification", () => {
	const baseVerification = {
		id: "verify-1",
		summary: "The code path and precondition exist.",
		confidence: 0.8,
		score: 0.8,
		reportPath: "/task/01_verify_report.md",
		runtimeSeconds: null,
		evidenceBundle: [evidence],
		residualUncertainty: [],
		status: "completed" as const,
	};

	assert.equal(
		verificationSchema.safeParse({
			...baseVerification,
			result: "true",
		}).success,
		true,
	);
	assert.equal(
		verificationSchema.safeParse({
			...baseVerification,
			result: "likely",
		}).success,
		true,
	);
	assert.equal(
		verificationSchema.safeParse({
			...baseVerification,
			result: "false",
		}).success,
		true,
	);
	assert.equal(
		verificationSchema.safeParse({
			...baseVerification,
			result: "real_vulnerability",
		}).success,
		false,
	);

	const baseTriage = {
		id: "triage-1",
		result: "security_issue",
		disqualifier: null,
		disqualifierReason: null,
		securityClassification: "vulnerability",
		isSecurityIssue: true,
		impactType: "memory corruption",
		cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
		cvssScore: 9.8,
		cvssSeverity: "critical",
		exploitability: "practical",
		isExploitable: true,
		commonTriggerConditions: ["malformed network record reaches parser"],
		hardeningOrRobustness: false,
		epssProbability30d: 0.02,
		epssSource: "heuristic:no-cve-mapping",
		summary: "Security issue with network trigger.",
		reportPath: "/task/01_triage_report.md",
		runtimeSeconds: null,
		evidenceBundle: [evidence],
		residualUncertainty: [],
		status: "completed",
	};

	assert.equal(triageSchema.safeParse(baseTriage).success, true);

	assert.equal(
		triageSchema.safeParse({
			...baseTriage,
			result: "non_security",
			disqualifier: "D-5",
			disqualifierReason:
				"Caller violates the documented API ownership contract.",
			securityClassification: "non_security",
			isSecurityIssue: false,
			cvssVector: null,
			cvssScore: null,
			cvssSeverity: "none",
			exploitability: "none",
			isExploitable: false,
			hardeningOrRobustness: true,
		}).success,
		true,
	);
});
