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
		"AnalysisStage",
		"FuzzBuildStage",
		"FuzzRunStage",
		"AnalysisCriticStage",
	]) {
		assert.equal(
			resolveStageTaskName(stageName, candidateInput),
			"Potential underflow in DTLS header availability check",
		);
	}
});
