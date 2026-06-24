import assert from "node:assert/strict";
import test from "node:test";
import type { FuzzRunResult } from "../artifacts/contracts/domain-object.contract";
import {
	resolveFuzzRunBudgetSeconds,
	SHORT_FUZZING_BUDGET_SECONDS,
	shouldPromoteShortFuzzRun,
	type FuzzRunStageInput,
} from "./fuzz-run.stage";

const baseResult: FuzzRunResult = {
	id: "run-1",
	buildResultId: "build-1",
	runtimeSeconds: 90,
	commandRun: "./fuzzer",
	exitStatus: "timeout",
	crashSignal: null,
	usedLibAflMonitor: true,
	progressJsonlPath: "/task/fuzz-progress.jsonl",
	progressJsonlRecords: 2,
	foundTriggeringInput: false,
	triggeringInputPath: null,
	corpusPath: "/task/corpus",
	crashArtifactsPath: null,
	logsPath: "/task/logs.txt",
	observedBehavior: "Corpus grew.",
	negativeEvidence: [],
	coverageProximity: "Reached parser dispatch.",
	newPathsOrStatesReached: ["parser:dispatch"],
	inputClassesDiscovered: [],
	confidenceImpact: "supports reachability",
	promotionDecision: {
		shouldPromote: true,
		reasons: ["corpus grew"],
		metrics: { corpusSize: 4 },
	},
	summary: "Short exploration made progress.",
};

const stageInput = (runMode: FuzzRunStageInput["runMode"]) => ({ runMode });

test("short fuzz runs use the fixed sprint budget", () => {
	assert.equal(
		resolveFuzzRunBudgetSeconds({
			runMode: "short",
			fuzzingBudgetSeconds: 600,
		}),
		SHORT_FUZZING_BUDGET_SECONDS,
	);
});

test("full fuzz runs use the configured scan budget", () => {
	assert.equal(
		resolveFuzzRunBudgetSeconds({
			runMode: "full",
			fuzzingBudgetSeconds: 1200,
		}),
		1200,
	);
});

test("only short runs without a trigger can promote", () => {
	assert.equal(
		shouldPromoteShortFuzzRun({
			stageInput: stageInput("short"),
			stageOutput: baseResult,
		}),
		true,
	);
	assert.equal(
		shouldPromoteShortFuzzRun({
			stageInput: stageInput("full"),
			stageOutput: baseResult,
		}),
		false,
	);
	assert.equal(
		shouldPromoteShortFuzzRun({
			stageInput: stageInput("short"),
			stageOutput: {
				...baseResult,
				foundTriggeringInput: true,
				promotionDecision: {
					...baseResult.promotionDecision,
					shouldPromote: true,
				},
			},
		}),
		false,
	);
	assert.equal(
		shouldPromoteShortFuzzRun({
			stageInput: stageInput("short"),
			stageOutput: {
				...baseResult,
				promotionDecision: {
					...baseResult.promotionDecision,
					shouldPromote: false,
				},
			},
		}),
		false,
	);
});
