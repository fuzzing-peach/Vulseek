import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAgentUsageSnapshot } from "./usage-snapshot";

test("parses ACP cumulative usage snapshots", () => {
	assert.deepEqual(parseAgentUsageSnapshot({ used: 42, contextSize: 1000 }), {
		inputTokens: 0,
		outputTokens: 0,
		thoughtTokens: 0,
		totalTokens: 42,
		cachedReadTokens: 0,
		cachedWriteTokens: 0,
	});
});

test("parses adapter token usage snapshots", () => {
	assert.deepEqual(
		parseAgentUsageSnapshot({
			totalTokens: 112893,
			inputTokens: 211,
			cachedReadTokens: 112512,
			outputTokens: 170,
			thoughtTokens: 94,
		}),
		{
			totalTokens: 112893,
			inputTokens: 211,
			outputTokens: 170,
			thoughtTokens: 94,
			cachedReadTokens: 112512,
			cachedWriteTokens: 0,
		},
	);
});

test("returns zeroes for invalid snapshots", () => {
	assert.deepEqual(parseAgentUsageSnapshot(null), {
		inputTokens: 0,
		outputTokens: 0,
		thoughtTokens: 0,
		totalTokens: 0,
		cachedReadTokens: 0,
		cachedWriteTokens: 0,
	});
});
