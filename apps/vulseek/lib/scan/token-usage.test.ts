import assert from "node:assert/strict";
import test from "node:test";
import { cachedInputPercent } from "./token-usage";

test("calculates cache read as a percentage of all input tokens", () => {
	assert.equal(cachedInputPercent(211, 112512)?.toFixed(2), "99.81");
	assert.equal(cachedInputPercent(0, 0), null);
});
