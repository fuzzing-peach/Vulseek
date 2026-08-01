import assert from "node:assert/strict";
import test from "node:test";
import {
	getPollableStageNames,
	groupActiveTasksByStage,
	type RuntimeLoopSnapshot,
} from "./runtime-loop-snapshot";

const snapshot = (
	input: Partial<RuntimeLoopSnapshot>,
): RuntimeLoopSnapshot => ({
	status: "running",
	activeCountByStage: new Map(),
	activeTasksByStage: new Map(),
	pendingTargets: [],
	pendingTaskMetadata: [],
	stagePolicies: new Map(),
	statusCounts: [],
	...input,
});

test("does not poll any stage when the job has no pending tasks", () => {
	assert.deepEqual(
		getPollableStageNames(
			snapshot({
				stagePolicies: new Map([
					["research-scope", { stageName: "research-scope", disabled: false, concurrency: 1 }],
				]),
			}),
		),
		[],
	);
});

test("polls only pending stages with available concurrency", () => {
	assert.deepEqual(
		getPollableStageNames(
			snapshot({
				activeCountByStage: new Map([
					["surface-map", 1],
					["vulnerability-discovery", 1],
				]),
				pendingTargets: [
					{ taskId: "one", stageName: "surface-map", groupInstanceId: null },
					{ taskId: "two", stageName: "vulnerability-discovery", groupInstanceId: null },
				],
				stagePolicies: new Map([
					["surface-map", { stageName: "surface-map", disabled: false, concurrency: 1 }],
					["vulnerability-discovery", { stageName: "vulnerability-discovery", disabled: false, concurrency: 8 }],
					["track-review", { stageName: "track-review", disabled: false, concurrency: 1 }],
				]),
			}),
		),
		["vulnerability-discovery"],
	);
});

test("groups active tasks with one database result", () => {
	const grouped = groupActiveTasksByStage([
		{ taskId: "one", stageName: "research-scope" },
		{ taskId: "two", stageName: "research-scope" },
		{ taskId: "three", stageName: "track-review" },
	]);

	assert.deepEqual(
		[...grouped.entries()].map(([stageName, tasks]) => [
			stageName,
			tasks.map((task) => task.taskId),
		]),
		[
			["research-scope", ["one", "two"]],
			["track-review", ["three"]],
		],
	);
});
