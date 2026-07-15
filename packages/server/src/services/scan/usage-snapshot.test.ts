import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAgentUsageSnapshot } from "./usage-snapshot";

test("parses ACP cumulative usage snapshots", () => {
	assert.deepEqual(parseAgentUsageSnapshot({ used: 42, contextSize: 1000 }), {
		totalTokens: 42,
		cachedReadTokens: 0,
	});
});

test("parses adapter token usage snapshots", () => {
	assert.deepEqual(
		parseAgentUsageSnapshot({
			inputTokens: 20,
			outputTokens: 7,
			cacheReadInputTokens: 5,
		}),
		{ totalTokens: 27, cachedReadTokens: 5 },
	);
});

test("returns zeroes for invalid snapshots", () => {
	assert.deepEqual(parseAgentUsageSnapshot(null), {
		totalTokens: 0,
		cachedReadTokens: 0,
	});
});
