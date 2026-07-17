import assert from "node:assert/strict";
import test from "node:test";
import { runAfterCompletionClaim } from "./completion-claim";

test("only the completion claimant runs post-completion effects", async () => {
	let claimed = false;
	let effectCount = 0;

	const claim = async () => {
		if (claimed) return false;
		claimed = true;
		return true;
	};
	const run = () =>
		runAfterCompletionClaim(claim, async () => {
			effectCount += 1;
		});

	const results = await Promise.all([run(), run()]);

	assert.deepEqual(results.sort(), [false, true]);
	assert.equal(effectCount, 1);
});

test("a failed completion claim does not run effects", async () => {
	let effectCount = 0;

	const completed = await runAfterCompletionClaim(
		async () => false,
		async () => {
			effectCount += 1;
		},
	);

	assert.equal(completed, false);
	assert.equal(effectCount, 0);
});
