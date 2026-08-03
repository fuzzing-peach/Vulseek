import assert from "node:assert/strict";
import test from "node:test";
import {
	CODEX_NATIVE_GOAL_MAX_CHARS,
	buildTobGoalHuntNativePrompt,
	buildTobGoalHuntOutputContract,
	composeTobGoalHuntObjective,
	tryBuildTobGoalHuntNativePrompt,
} from "./tob-goal-native-prompt";

test("buildTobGoalHuntNativePrompt prefixes /goal and stays within codex-acp limit", () => {
	const prompt = buildTobGoalHuntNativePrompt({
		goalSpec: {
			title: "Find one critical remote RCE in WordPress core",
			goalPrompt:
				"Find exactly one previously unreported critical remote RCE in WordPress core reachable by a remote unauthenticated attacker under default configuration.",
			successCriteria:
				"One candidate with precise location, attacker-controlled input, path, and evidence — or justified exhaustion.",
			nonGoals: [
				"Do not require admin privileges",
				"Do not treat crashes alone as RCE",
			],
			attackerModel: "Remote unauthenticated network attacker",
			stopCondition: "One candidate or justified exhaustion",
			persistenceLanguage: "No bugs found is intermediate, not success",
		},
		huntGoal: {
			huntGoalId: "hg-1",
			title: "XML-RPC auth surface",
			objective: "Hunt auth bypass / injection on XML-RPC endpoints",
			focusPaths: ["xmlrpc.php", "wp-includes/class-wp-xmlrpc-server.php"],
		},
	});

	assert.ok(prompt.startsWith("/goal "));
	assert.ok(prompt.length <= CODEX_NATIVE_GOAL_MAX_CHARS + "/goal ".length);
	assert.match(prompt, /XML-RPC/);
	assert.match(prompt, /\/task\/output\.json/);
	assert.match(prompt, /\/task\/output\.schema\.json/);
	assert.match(prompt, /jsonschema/i);
	assert.match(prompt, /output\.exhaustion/);
	assert.match(prompt, /exhausted:true/);
});

test("composeTobGoalHuntObjective truncates long goalPrompt while keeping schema validation contract", () => {
	const objective = composeTobGoalHuntObjective({
		goalSpec: {
			goalPrompt: "X".repeat(5000),
			title: "title",
		},
		huntGoal: {
			title: "surface",
			objective: "obj",
		},
		maxChars: 1200,
	});
	assert.ok(objective.length <= 1200);
	assert.match(objective, /\/task\/output\.json/);
	assert.match(objective, /\/task\/output\.schema\.json/);
	assert.match(objective, /jsonschema/i);
	assert.match(objective, /Structured JSON output requirement/);
});

test("buildTobGoalHuntOutputContract requires schema validation like other stages", () => {
	const contract = buildTobGoalHuntOutputContract();
	assert.match(contract, /output\.schema\.json/);
	assert.match(contract, /jsonschema/i);
	assert.match(contract, /FINAL CHECK/);
	assert.match(contract, /Do not add extra fields/);
	assert.match(contract, /route must be "candidate" or "exhausted"/);
});

test("tryBuildTobGoalHuntNativePrompt returns null without goal data", () => {
	assert.equal(tryBuildTobGoalHuntNativePrompt({}), null);
	assert.equal(tryBuildTobGoalHuntNativePrompt(null), null);
	const prompt = tryBuildTobGoalHuntNativePrompt({
		goalSpec: { goalPrompt: "Find one bug with evidence" },
		huntGoal: { title: "auth", objective: "focus auth" },
	});
	assert.ok(prompt?.startsWith("/goal "));
	assert.match(prompt ?? "", /output\.schema\.json/);
});
