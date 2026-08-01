import assert from "node:assert/strict";
import test from "node:test";
import { buildResearchDispatchRetryPlan } from "./research-dispatch-recovery";

const task = (overrides: Partial<Parameters<typeof buildResearchDispatchRetryPlan>[0][number]> = {}) => ({
	taskId: "task-1",
	stageName: "track-review",
	downstreamRouteKey: "finding-found",
	input: { trackKey: "track-1" },
	output: { findingIds: ["finding-1"] },
	...overrides,
});

test("recovery preserves the persisted route and ignores duplicate task rows", () => {
	const plan = buildResearchDispatchRetryPlan(
		[task(), task(), task({ taskId: "task-2", stageName: "finding-review" })],
		new Set(["track-review", "finding-review"]),
	);

	assert.deepEqual(
		plan.ready.map((item) => [item.taskId, item.downstreamRouteKey]),
		[
			["task-1", "finding-found"],
			["task-2", "finding-found"],
		],
	);
	assert.deepEqual(plan.skipped.map((item) => item.taskId), ["task-1"]);
});

test("recovery skips tasks from stages absent from the active snapshot", () => {
	const plan = buildResearchDispatchRetryPlan(
		[task({ stageName: "removed-stage" })],
		new Set(["track-review"]),
	);

	assert.equal(plan.ready.length, 0);
	assert.deepEqual(plan.skipped.map((item) => item.stageName), ["removed-stage"]);
});
