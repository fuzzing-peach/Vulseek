import assert from "node:assert/strict";
import test from "node:test";
import { findCompiledStageConcurrency } from "./compiled-stage-concurrency";

test("findCompiledStageConcurrency reads V3 stage concurrency", () => {
	assert.equal(
		findCompiledStageConcurrency(
			{
				version: 3,
				stages: [
					{ id: "goal-craft", concurrency: 1, runtime: { prompt: "craft" } },
					{ id: "goal-hunt", concurrency: 8, runtime: { prompt: "hunt" } },
				],
			},
			"goal-hunt",
		),
		8,
	);
});

test("findCompiledStageConcurrency returns null for missing or invalid stages", () => {
	assert.equal(
		findCompiledStageConcurrency(
			{ version: 3, stages: [{ id: "goal-hunt", concurrency: 0 }] },
			"goal-hunt",
		),
		null,
	);
	assert.equal(
		findCompiledStageConcurrency(
			{ version: 3, stages: [{ id: "goal-craft", concurrency: 1 }] },
			"goal-hunt",
		),
		null,
	);
	assert.equal(findCompiledStageConcurrency({}, "goal-hunt"), null);
});
