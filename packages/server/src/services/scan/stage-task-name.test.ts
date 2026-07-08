import assert from "node:assert/strict";
import test from "node:test";
import { resolveStageTaskName } from "./stage-task-name";

const candidateInput = {
	candidate: {
		title: "Potential underflow in DTLS header availability check",
	},
};

test("resolveStageTaskName uses candidate title for analysis-adjacent stages", () => {
	for (const stageName of [
		"analyze-finding",
		"critique-finding",
		"triage-finding",
	]) {
		assert.equal(
			resolveStageTaskName(stageName, candidateInput),
			"Potential underflow in DTLS header availability check",
		);
	}

	assert.equal(
		resolveStageTaskName("verify-finding", {
			analysisResult: {
				candidate: candidateInput.candidate,
			},
		}),
		"Potential underflow in DTLS header availability check",
	);
});

test("resolveStageTaskName uses a stable delta scope root task name", () => {
	assert.equal(resolveStageTaskName("delta-scope", null), "delta-scoping");
});
