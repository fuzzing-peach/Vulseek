import assert from "node:assert/strict";
import test from "node:test";
import {
	buildEffectiveDisabledStageSet,
	DELTA_SCAN_STAGE_IDS,
	FULL_SCAN_STAGE_IDS,
	getRuntimeStageDefaultConcurrency,
	isRuntimeStageDisableable,
	normalizeScanRuntimeSettings,
} from "./runtime-settings";

test("runtime stage ids and defaults are derived from the YAML catalog", () => {
	assert.deepEqual(FULL_SCAN_STAGE_IDS, [
		"repository-profile",
		"attack-surface-model",
		"identify-target",
		"scan-target",
		"analyze-finding",
		"critique-finding",
		"verify-finding",
		"triage-finding",
	]);
	assert.deepEqual(DELTA_SCAN_STAGE_IDS, [
		"delta-scope",
		"scan-target",
		"analyze-finding",
		"critique-finding",
		"verify-finding",
		"triage-finding",
	]);
	assert.equal(getRuntimeStageDefaultConcurrency("scan-target"), 4);
	assert.equal(getRuntimeStageDefaultConcurrency("triage-finding"), 1);
	assert.equal(getRuntimeStageDefaultConcurrency("unknown-stage"), 1);
});

test("normalizeScanRuntimeSettings honors disableable=false from YAML", () => {
	const normalized = normalizeScanRuntimeSettings({
		stages: {
			"repository-profile": { disabled: true, concurrency: 3 },
			"delta-scope": { disabled: true, concurrency: 2 },
			"scan-target": { disabled: true, concurrency: 7 },
			"unknown-stage": { disabled: true, concurrency: 99 },
		},
	});

	assert.equal(isRuntimeStageDisableable("repository-profile"), false);
	assert.equal(isRuntimeStageDisableable("delta-scope"), false);
	assert.equal(isRuntimeStageDisableable("scan-target"), true);
	assert.deepEqual(normalized.stages, {
		"repository-profile": {
			disabled: false,
			concurrency: 3,
			agentProfileId: null,
		},
		"delta-scope": {
			disabled: false,
			concurrency: 2,
			agentProfileId: null,
		},
		"scan-target": {
			disabled: true,
			concurrency: 7,
			agentProfileId: null,
		},
	});
});

test("buildEffectiveDisabledStageSet uses YAML root and disableable settings", () => {
	const disabled = buildEffectiveDisabledStageSet({
		settings: {
			stages: {
				"repository-profile": { disabled: true },
				"scan-target": { disabled: true },
			},
		},
		edges: [
			{ source: "repository-profile", target: "scan-target" },
			{ source: "scan-target", target: "analyze-finding" },
		],
		stageNames: ["repository-profile", "scan-target", "analyze-finding"],
		rootStageName: "repository-profile",
	});

	assert.deepEqual([...disabled].sort(), [
		"analyze-finding",
		"scan-target",
	]);
});
