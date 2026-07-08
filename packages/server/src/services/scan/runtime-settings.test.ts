import assert from "node:assert/strict";
import test from "node:test";
import {
	buildCompleteScanRuntimeSettings,
	buildEffectiveDisabledStageSet,
	DELTA_SCAN_STAGE_IDS,
	FULL_SCAN_STAGE_IDS,
	getRuntimeStageConcurrency,
	isRuntimeStageDisableable,
	normalizeScanRuntimeSettings,
} from "./runtime-settings";

test("runtime stage ids and defaults are derived from YAML definitions", () => {
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
	assert.equal(getRuntimeStageConcurrency("scan-target"), 4);
	assert.equal(getRuntimeStageConcurrency("triage-finding"), 1);
	assert.equal(getRuntimeStageConcurrency("unknown-stage"), 1);
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

test("buildCompleteScanRuntimeSettings snapshots target settings and YAML defaults", () => {
	const settings = buildCompleteScanRuntimeSettings({
		scanType: "full",
		targetStageSettings: {
			"scan-target": {
				agentProfileId: "target-scan-profile",
				concurrency: 9,
			},
			"analyze-finding": {
				agentProfileId: "target-analysis-profile",
			},
		},
		runtimeOverrides: {
			stages: {
				"scan-target": {
					disabled: true,
					agentProfileId: null,
					concurrency: 11,
				},
				"verify-finding": {
					agentProfileId: "override-verify-profile",
				},
				"unknown-stage": {
					agentProfileId: "ignored",
					concurrency: 99,
				},
			},
		},
	});

	assert.deepEqual(Object.keys(settings.stages ?? {}), FULL_SCAN_STAGE_IDS);
	assert.deepEqual(settings.stages?.["repository-profile"], {
		disabled: false,
		agentProfileId: null,
		concurrency: 1,
	});
	assert.deepEqual(settings.stages?.["scan-target"], {
		disabled: true,
		agentProfileId: "target-scan-profile",
		concurrency: 11,
	});
	assert.deepEqual(settings.stages?.["analyze-finding"], {
		disabled: false,
		agentProfileId: "target-analysis-profile",
		concurrency: 2,
	});
	assert.deepEqual(settings.stages?.["verify-finding"], {
		disabled: false,
		agentProfileId: "override-verify-profile",
		concurrency: 1,
	});
});

test("buildCompleteScanRuntimeSettings uses only the selected pipeline stages", () => {
	const settings = buildCompleteScanRuntimeSettings({
		scanType: "delta",
		targetStageSettings: {
			"repository-profile": {
				agentProfileId: "repo-profile",
				concurrency: 7,
			},
			"delta-scope": {
				agentProfileId: "delta-profile",
				concurrency: 3,
			},
		},
		runtimeOverrides: {
			stages: {
				"delta-scope": {
					disabled: true,
				},
			},
		},
	});

	assert.deepEqual(Object.keys(settings.stages ?? {}), DELTA_SCAN_STAGE_IDS);
	assert.deepEqual(settings.stages?.["delta-scope"], {
		disabled: false,
		agentProfileId: "delta-profile",
		concurrency: 3,
	});
	assert.equal(settings.stages?.["repository-profile"], undefined);
});
