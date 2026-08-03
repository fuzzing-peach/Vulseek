import assert from "node:assert/strict";
import test from "node:test";
import type { TaskAgentProfileSnapshot } from "@vulseek/server/db/schema";
import {
	computePatchedTaskCost,
	computeTaskCost,
	type TaskCostSource,
} from "./cost";

const profile: TaskAgentProfileSnapshot = {
	agentProfileId: null,
	name: "GPT-5.6 Luna",
	provider: "codex",
	authMode: "api_key",
	homePath: null,
	baseUrl: null,
	model: "gpt-5.6-luna",
	pricingProvider: "openai",
	thinkingLevel: null,
};

const usage = (overrides: Partial<TaskCostSource> = {}): TaskCostSource => ({
	inputTokens: 0,
	outputTokens: 0,
	cachedReadTokens: 0,
	cachedWriteTokens: 0,
	agentProfile: profile,
	...overrides,
});

const assertClose = (actual: number | null, expected: number) => {
	assert.notEqual(actual, null);
	assert.ok(Math.abs((actual ?? 0) - expected) < 1e-12);
};

test("prices uncached, cache-read, and cache-write tokens separately", () => {
	assertClose(
		computeTaskCost(
			usage({
				inputTokens: 1_000,
				outputTokens: 100,
				cachedReadTokens: 1_000,
				cachedWriteTokens: 1_000,
			}),
		),
		0.00295,
	);
});

test("bills cache writes as regular input when no write price exists", () => {
	const profileWithoutCacheWritePrice = {
		...profile,
		model: "gpt-4o",
	};
	const cacheWriteCost = computeTaskCost(
		usage({
			inputTokens: 0,
			cachedWriteTokens: 1_000,
			agentProfile: profileWithoutCacheWritePrice,
		}),
	);
	const regularInputCost = computeTaskCost(
		usage({
			inputTokens: 1_000,
			agentProfile: profileWithoutCacheWritePrice,
		}),
	);

	assert.equal(cacheWriteCost, regularInputCost);
});

test("computes each task before aggregating costs", () => {
	const firstTask = computeTaskCost(usage({ inputTokens: 200_000 }));
	const secondTask = computeTaskCost(usage({ inputTokens: 200_000 }));
	const incorrectlyAggregated = computeTaskCost(
		usage({ inputTokens: 400_000 }),
	);

	assertClose(firstTask, 0.2);
	assertClose(secondTask, 0.2);
	assertClose(incorrectlyAggregated, 0.8);
	assertClose((firstTask ?? 0) + (secondTask ?? 0), 0.4);
});

test("recalculates from the merged task patch", () => {
	const current = usage({
		inputTokens: 1_000,
		outputTokens: 100,
		cachedReadTokens: 500,
	});

	const patched = computePatchedTaskCost(current, {
		outputTokens: 200,
		cachedWriteTokens: 250,
	});
	const expected = computeTaskCost(
		usage({
			inputTokens: 1_000,
			outputTokens: 200,
			cachedReadTokens: 500,
			cachedWriteTokens: 250,
		}),
	);

	assert.equal(patched, expected);
});

test("honors explicit nulls in a patch", () => {
	const current = usage({
		inputTokens: 1_000,
		outputTokens: 100,
		cachedReadTokens: 500,
	});

	const patched = computePatchedTaskCost(current, {
		outputTokens: null,
		cachedReadTokens: null,
	});

	assertClose(patched, 0.001);
});

test("returns null when the task pricing snapshot is unavailable", () => {
	assert.equal(
		computeTaskCost(
			usage({
				agentProfile: {
					...profile,
					pricingProvider: null,
				},
			}),
		),
		null,
	);
});

test("normalizes invalid token counts to zero", () => {
	assertClose(
		computeTaskCost(
			usage({
				inputTokens: Number.NaN,
				outputTokens: -1,
				cachedReadTokens: Number.POSITIVE_INFINITY,
			}),
		),
		0,
	);
});
