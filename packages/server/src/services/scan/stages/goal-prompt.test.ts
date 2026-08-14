import assert from "node:assert/strict";
import test from "node:test";
import { buildGoalPrompt } from "./goal-prompt";

test("buildGoalPrompt prefixes /goal and renders input as readable context", () => {
	const prompt = buildGoalPrompt({
		prompt: "Investigate the assigned surface.",
		input: {
			goalSpec: { successCriteria: "Evidence-backed result", nonGoals: ["Crashes only"] },
			focusPaths: ["src/router.ts", "src/parser.ts"],
			trackId: "track-1",
		},
	});

	assert.ok(prompt.startsWith("/goal "));
	assert.match(prompt, /Goal Spec:/);
	assert.match(prompt, /Success Criteria: Evidence-backed result/);
	assert.match(prompt, /Focus Paths:\n  - src\/router\.ts/);
	assert.match(prompt, /Track Id: track-1/);
	assert.doesNotMatch(prompt, /"goalSpec"\s*:/);
});
