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
	assert.equal(resolveStageTaskName("delta-scope", null), "delta-scope");
});

test("resolveStageTaskName appends vulnerability class focus", () => {
	assert.equal(
		resolveStageTaskName("identify-target", {
			moduleName: "API",
			vulnerabilityClassFocus: "SQL injection",
		}),
		"API:SQL injection",
	);
	assert.equal(
		resolveStageTaskName("scan-target", {
			targetName: "createIssue",
			vulnerabilityClassFocus: "authorization bypass",
		}),
		"createIssue:authorization bypass",
	);
});

test("resolveStageTaskName gives research tasks descriptive action names", () => {
	assert.equal(
		resolveStageTaskName("research-scope", null),
		"Define research scope",
	);
	assert.equal(
		resolveStageTaskName("research-scope", {
			researchScope: { title: "Pre-authentication attack surface" },
		}),
		"Define research scope: Pre-authentication attack surface",
	);
	assert.equal(
		resolveStageTaskName("surface-map", null),
		"Map attack surface",
	);
	assert.equal(
		resolveStageTaskName("track-plan", null),
		"Plan research tracks",
	);
	assert.equal(
		resolveStageTaskName("vulnerability-discovery", {
			track: { title: "Authorization boundary" },
		}),
		"Investigate track: Authorization boundary",
	);
	assert.equal(
		resolveStageTaskName("track-review", {
			track: {
				objective: "Trace attacker-controlled outbound URLs across trust boundaries",
			},
		}),
		"Review track: Trace attacker-controlled outbound URLs across trust boundaries",
	);
	assert.equal(
		resolveStageTaskName("finding-validation", {
			finding: { title: "Unvalidated redirect target" },
		}),
		"Validate finding: Unvalidated redirect target",
	);
	assert.equal(
		resolveStageTaskName("finding-review", {
			findingId: "track-a:root-cause",
		}),
		"Review finding: track-a:root-cause",
	);
	assert.equal(
		resolveStageTaskName("chain-review", {
			chain: { title: "Upload to code execution" },
		}),
		"Review chain: Upload to code execution",
	);
	assert.equal(
		resolveStageTaskName("exploit-validation", {
			chain: { chainId: "chain-7" },
		}),
		"Validate exploit chain: chain-7",
	);
});

test("resolveStageTaskName uses research fallback names without stage labels", () => {
	assert.equal(
		resolveStageTaskName("vulnerability-discovery", {}),
		"Investigate research track",
	);
	assert.equal(
		resolveStageTaskName("chain-synthesis", {}),
		"Synthesize exploit chains",
	);
	assert.equal(
		resolveStageTaskName("research-report", {}),
		"Write research report",
	);
	assert.equal(resolveStageTaskName("finding-validation", {}), "Validate finding");
	assert.equal(resolveStageTaskName("finding-review", {}), "Review finding");
});
