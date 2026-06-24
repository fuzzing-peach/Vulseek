import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	mkdtempSync,
	mkdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	candidateSchema,
	rulePlanSchema,
	sinkReviewTargetSchema,
	sinkPreAnalyzeManifestSchema,
} from "./artifacts/contracts/domain-object.contract";
import { filterValuableRuleFileScopes } from "./rule-file-scope-filter";
import {
	RULE_SCAN_STAGE_IDS,
	RUNTIME_STAGE_ID_SET,
} from "./runtime-settings";
import { SCAN_STAGE_IDS } from "./stage-metadata";
import {
	getRuleModuleScopes,
	validateRulePlanForModule,
} from "./stages/rule-design.stage";
import {
	buildRuleScopeArgsPrelude,
	buildRipgrepCommand,
} from "./stages/rule-scan.stage";

test("rule plan supports semgrep, ripgrep, and abstract patterns", () => {
	const parsed = rulePlanSchema.parse({
		module: {
			moduleId: "api",
			moduleName: "API",
			modulePath: "/task/inputs/module.json",
		},
		threatModelPath: "/task/inputs/module-threat-model.json",
		rules: [
			{
				ruleId: "api-sql-rg",
				engine: "ripgrep",
				riskClass: "sql-injection",
				intent: "Find raw SQL sinks",
				targetKinds: ["sink"],
				priority: "high",
				fileScopes: ["src"],
				artifactPath: "/task/rules/api-sql.patterns.json",
				execution: {
					patterns: ["query", "$queryRaw"],
					patternMode: "literal",
					semgrepRule: null,
				},
			},
			{
				ruleId: "api-command-semgrep",
				engine: "semgrep",
				riskClass: "command-injection",
				intent: "Find command execution sinks",
				targetKinds: ["sink"],
				priority: "medium",
				fileScopes: ["src"],
				artifactPath: "/task/rules/api-command.yaml",
				execution: {
					patterns: ["exec("],
					patternMode: null,
					semgrepRule: null,
				},
			},
		],
		abstractPatterns: [
			{
				patternId: "api-abstract-1",
				riskClass: "authorization-bypass",
				priority: "medium",
				location: {
					filePath: null,
					line: null,
					symbolName: "handleRequest",
				},
				reviewQuestions: ["Can untrusted input reach a privileged action?"],
				evidenceToCollect: ["Entrypoint to sink path"],
				discardIf: ["No privileged sink is reachable"],
				summary: "Review API request handling.",
			},
		],
		assumptions: [],
		limitations: [],
		summary: "Rule plan",
	});

	assert.equal(parsed.rules[0]?.engine, "ripgrep");
	assert.equal(parsed.rules[0]?.execution.patternMode, "literal");
	assert.equal(parsed.rules[1]?.engine, "semgrep");
	assert.equal(parsed.abstractPatterns.length, 1);
});

test("sink pre-analyze manifest carries candidate artifact paths compatible with candidate schema", () => {
	const candidate = candidateSchema.parse({
		id: "rule-target-1",
		functionId: "target-1",
		title: "sql-injection: raw query target",
		description: "Rule target",
		filePath: "src/api.ts",
		line: 42,
		vulnerabilityType: "sql-injection",
		confidence: 0.45,
		score: 7,
		claim: "Raw query can receive attacker input",
		rootCauseKey: "api:sql:src/api.ts:42",
		evidence: [],
		attackerControl: null,
		affectedSink: "query",
		preconditions: [],
		quickDisproofAttempt: null,
		needsFuzzing: false,
		needsManualAnalysis: true,
	});

	const manifest = sinkPreAnalyzeManifestSchema.parse({
		normalizedTargets: ["/task/targets/target-1.json"],
		candidates: ["/task/candidates/rule-target-1.json"],
		syntheticFunctions: ["/task/functions/target-1.json"],
		discardedTargets: ["/task/discarded-targets/discarded-target-1.json"],
		summary: "one candidate",
	});
	const discardedTarget = sinkReviewTargetSchema.parse({
		targetId: "discarded-target-1",
		moduleId: "api",
		targetType: "rule_finding",
		riskClass: "sql-injection",
		priority: "low",
		location: {
			filePath: "tests/api.test.ts",
			line: 10,
			column: 1,
			symbolName: null,
		},
		ruleEvidence: ["discarded: test-only path"],
		reviewQuestions: [],
		evidenceToCollect: [],
		discardIf: ["test-only path"],
		normalization: {
			key: "api:sql:tests/api.test.ts:10:-:discarded:test",
			snippet: "test-only path",
			mergedFindingIds: ["finding-1"],
		},
		summary: "Discarded low-value rule target.",
	});

	assert.equal(candidate.id, "rule-target-1");
	assert.equal(discardedTarget.priority, "low");
	assert.deepEqual(manifest.candidates, [
		"/task/candidates/rule-target-1.json",
	]);
	assert.deepEqual(manifest.discardedTargets, [
		"/task/discarded-targets/discarded-target-1.json",
	]);
});

test("rule design filters low-value scopes before rule execution", () => {
	const filtered = filterValuableRuleFileScopes([
		"src/liblsquic/lsquic_engine.c",
		"include/lsquic.h",
		"tests/test_ack_merge.c",
		"tests/CMakeLists.txt",
		"docs/protocol.md",
		".gitmodules",
		"tools/gen-tags.pl",
		"package-lock.json",
	]);
	assert.deepEqual(filtered.includedScopes, [
		"src/liblsquic/lsquic_engine.c",
		"include/lsquic.h",
	]);
	assert.deepEqual(
		filtered.excludedScopes.map((scope) => scope.category),
		[
			"test",
			"test",
			"documentation",
			"configuration",
			"configuration",
			"configuration",
		],
	);

	const moduleScopes = getRuleModuleScopes({
		id: "lsquic-core",
		moduleId: "lsquic-core",
		name: "LSQUIC Core",
		summary: "Core runtime",
		priority: 0,
		files: [
			"src/liblsquic/lsquic_engine.c",
			"tests/test_ack_merge.c",
			"CMakeLists.txt",
		],
		entryPoints: [],
		trustBoundaries: [],
		attackSurfaces: [],
		vulnerabilityThemes: [],
		runtimeComponents: [],
		notes: [],
	});
	assert.deepEqual(moduleScopes.includedScopes, [
		"src/liblsquic/lsquic_engine.c",
	]);

	const lowValueModuleScopes = getRuleModuleScopes({
		id: "tests",
		moduleId: "tests",
		name: "Protocol Tests and Harnesses",
		summary: "Protocol tests",
		priority: 3,
		files: ["src/liblsquic/lsquic_engine.c", "tests/test_ack_merge.c"],
		entryPoints: [],
		trustBoundaries: [],
		attackSurfaces: [],
		vulnerabilityThemes: [],
		runtimeComponents: [],
		notes: [],
	});
	assert.deepEqual(lowValueModuleScopes.includedScopes, []);
});

test("rule design validates LLM generated scopes and ripgrep modes", () => {
	const module = {
		id: "lsquic-core",
		moduleId: "lsquic-core",
		name: "LSQUIC Core",
		summary: "Core runtime",
		priority: 0,
		files: [
			"src/liblsquic/lsquic_engine.c",
			"include/lsquic.h",
			"tests/test_ack_merge.c",
		],
		entryPoints: ["lsquic_engine_packet_in"],
		trustBoundaries: ["network packet input"],
		attackSurfaces: ["QUIC packets"],
		vulnerabilityThemes: ["packet parsing"],
		runtimeComponents: ["transport"],
		notes: [],
	};
	const stageInput = {
		scanJob: {
			scanJobId: "scan-1",
			scanType: "rule" as const,
		},
		repositoryPath: "/task/inputs/repository.json",
		modulePath: "/task/inputs/module.json",
		threatModelPath: "/task/inputs/module-threat-model.json",
		moduleId: "lsquic-core",
		moduleName: "LSQUIC Core",
		priority: 0,
	};
	const validPlan = rulePlanSchema.parse({
		module: {
			moduleId: "lsquic-core",
			moduleName: "LSQUIC Core",
			modulePath: "/task/inputs/module.json",
		},
		threatModelPath: "/task/inputs/module-threat-model.json",
		rules: [
			{
				ruleId: "lsquic-core-packet-rg",
				engine: "ripgrep",
				riskClass: "packet-parsing",
				intent: "Find packet parsing branches fed by network input.",
				targetKinds: ["sink", "state-transition"],
				priority: "high",
				fileScopes: ["src/liblsquic/lsquic_engine.c"],
				artifactPath: null,
				execution: {
					patterns: ["lsquic_engine_packet_in", "parse_packet_in_begin"],
					patternMode: "literal",
					semgrepRule: null,
				},
			},
		],
		abstractPatterns: [],
		assumptions: [],
		limitations: [],
		summary: "LLM designed rule plan.",
	});
	const validated = validateRulePlanForModule({
		plan: validPlan,
		module,
		stageInput,
	});
	assert.equal(
		validated.rules[0]?.artifactPath,
		"/task/rules/lsquic-core-packet-rg.patterns.json",
	);

	assert.throws(
		() =>
			validateRulePlanForModule({
				plan: rulePlanSchema.parse({
					...validPlan,
					rules: [
						{
							...validPlan.rules[0]!,
							fileScopes: ["tests/test_ack_merge.c"],
						},
					],
				}),
				module,
				stageInput,
			}),
		/disallowed fileScope/,
	);

	assert.throws(
		() =>
			validateRulePlanForModule({
				plan: rulePlanSchema.parse({
					...validPlan,
					rules: [
						{
							...validPlan.rules[0]!,
							execution: {
								patterns: ["../"],
								patternMode: "literal",
								semgrepRule: null,
							},
						},
					],
				}),
				module,
				stageInput,
			}),
		/forbidden high-noise/,
	);
});

test("ripgrep rule command respects literal and regex pattern modes", () => {
	const baseRule = rulePlanSchema.parse({
		module: {
			moduleId: "api",
			moduleName: "API",
			modulePath: "/task/inputs/module.json",
		},
		threatModelPath: "/task/inputs/module-threat-model.json",
		rules: [
			{
				ruleId: "api-command-rg",
				engine: "ripgrep",
				riskClass: "command-injection",
				intent: "Find command execution sinks",
				targetKinds: ["sink"],
				priority: "high",
				fileScopes: ["src"],
				artifactPath: null,
				execution: {
					patterns: ["exec("],
					patternMode: "literal",
					semgrepRule: null,
				},
			},
		],
		abstractPatterns: [],
		assumptions: [],
		limitations: [],
		summary: "Rule plan",
	}).rules[0]!;

	const literalCommand = buildRipgrepCommand({
		rule: baseRule,
		scopes: ["src"],
	});
	assert.match(literalCommand, /rg -F --json -n --column/);

	const regexCommand = buildRipgrepCommand({
		rule: {
			...baseRule,
			execution: {
				...baseRule.execution,
				patternMode: "regex",
				patterns: ["exec\\s*\\("],
			},
		},
		scopes: ["src"],
	});
	assert.match(regexCommand, /rg --json -n --column/);
	assert.doesNotMatch(regexCommand, /rg -F --json -n --column/);
});

test("rule stages are runtime-configurable", () => {
	for (const stageId of RULE_SCAN_STAGE_IDS) {
		assert.equal(RUNTIME_STAGE_ID_SET.has(stageId), true);
	}
	assert.deepEqual(RULE_SCAN_STAGE_IDS.slice(0, 5), [
		SCAN_STAGE_IDS.repositoryScan,
		SCAN_STAGE_IDS.moduleThreatModel,
		SCAN_STAGE_IDS.ruleDesign,
		SCAN_STAGE_IDS.ruleScan,
		SCAN_STAGE_IDS.patternScan,
	]);
	assert.deepEqual(RULE_SCAN_STAGE_IDS.slice(5, 6), [
		SCAN_STAGE_IDS.sinkPreAnalyze,
	]);
});

test("rule scan scope prelude expands globs and skips missing scopes", () => {
	const tmpDir = mkdtempSync(path.join(os.tmpdir(), "rule-scope-"));
	try {
		mkdirSync(path.join(tmpDir, "tests"));
		writeFileSync(path.join(tmpDir, "tests", "CMakeLists.txt"), "../x\n");
		writeFileSync(path.join(tmpDir, "tests", "a.c"), "../y\n");
		const script = [
			buildRuleScopeArgsPrelude([
				"tests/CMakeLists.txt",
				"tests/*.c",
				"missing/*.h",
			]),
			'printf "%s\\n" "${scope_args[@]}"',
		].join("\n");
		const result = spawnSync("bash", ["-lc", script], {
			cwd: tmpDir,
			encoding: "utf8",
		});
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(result.stdout.trim().split(/\r?\n/).sort(), [
			"tests/CMakeLists.txt",
			"tests/a.c",
		]);
		assert.match(result.stderr, /skipped missing scope: missing\/\*\.h/);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});
