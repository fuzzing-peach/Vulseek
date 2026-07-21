import {
	 type ScanRuntimeSettings,
	type ScanStageSettings,
	ScanRuntimeSettingsSchema,
} from "../../db/schema/shared";
import { loadScanPipelineDefinitions } from "./pipeline/scan-pipeline-definitions";
import { getPipelineIdForScanType } from "./scan-type";

export const FULL_SCAN_STAGE_IDS = [
	"repository-profile",
	"attack-surface-model",
	"identify-target",
	"scan-target",
	"analyze-finding",
	"critique-finding",
	"verify-finding",
	"triage-finding",
];

export const DELTA_SCAN_STAGE_IDS = [
	"delta-scope",
	"scan-target",
	"analyze-finding",
	"critique-finding",
	"verify-finding",
	"triage-finding",
];

export const RESEARCH_SCAN_STAGE_IDS = [
	"research-scope",
	"surface-map",
	"track-plan",
	"vulnerability-discovery",
	"track-review",
	"finding-validation",
	"finding-review",
	"chain-synthesis",
	"chain-review",
	"exploit-validation",
	"exploit-review",
	"research-report",
];

const RUNTIME_STAGE_IDS = [
	...FULL_SCAN_STAGE_IDS,
	...DELTA_SCAN_STAGE_IDS,
	...RESEARCH_SCAN_STAGE_IDS,
];

export const FULL_SCAN_STAGE_ID_SET = new Set<string>(FULL_SCAN_STAGE_IDS);
export const RUNTIME_STAGE_ID_SET = new Set<string>(RUNTIME_STAGE_IDS);

const loadRuntimeDefinitions = () => loadScanPipelineDefinitions();

export const isRuntimeStageDisableable = (stageName: string) =>
	loadRuntimeDefinitions().stages.find((stage) => stage.id === stageName)
		?.disableable ?? true;

export const getRuntimeStageConcurrency = (stageName: string) =>
	loadRuntimeDefinitions().stages.find((stage) => stage.id === stageName)
		?.concurrency ?? 1;

export type ScanRuntimeStageState = {
	disabled: boolean;
	effectiveDisabled: boolean;
	concurrency: number | null;
	agentProfileId: string | null;
};

export const normalizeScanRuntimeSettings = (
	value: unknown,
): ScanRuntimeSettings => {
	const definitions = loadRuntimeDefinitions();
	const runtimeStageIds = new Set([
		...definitions.pipelines.full.stageIds,
		...definitions.pipelines.delta.stageIds,
		...definitions.pipelines.research.stageIds,
	]);
	const parsed = ScanRuntimeSettingsSchema.catch({}).parse(value);
	const stages: NonNullable<ScanRuntimeSettings["stages"]> = {};
	for (const [stageName, setting] of Object.entries(parsed.stages ?? {})) {
		if (!runtimeStageIds.has(stageName)) {
			continue;
		}
		stages[stageName] = {
			disabled: isRuntimeStageDisableable(stageName)
				? setting.disabled === true
				: false,
			concurrency:
				typeof setting.concurrency === "number" ? setting.concurrency : null,
			agentProfileId: setting.agentProfileId || null,
		};
	}
	return { stages };
};

export const buildCompleteScanRuntimeSettings = (input: {
	scanType: "delta" | "full" | "research";
	targetStageSettings?: ScanStageSettings | null;
	runtimeOverrides?: ScanRuntimeSettings | null;
}): ScanRuntimeSettings => {
	const stageIds = loadRuntimeDefinitions().pipelines[
		getPipelineIdForScanType(input.scanType)
	].stageIds;
	const overrides = normalizeScanRuntimeSettings(input.runtimeOverrides ?? {});
	const stages: NonNullable<ScanRuntimeSettings["stages"]> = {};
	const definitions = loadRuntimeDefinitions();
	const stageById = new Map(definitions.stages.map((stage) => [stage.id, stage]));

	for (const stageName of stageIds) {
		const stageDefinition = stageById.get(stageName);
		const targetSetting = input.targetStageSettings?.[stageName] ?? {};
		const override = overrides.stages?.[stageName] ?? {};
		stages[stageName] = {
			disabled: isRuntimeStageDisableable(stageName)
				? override.disabled === true
				: false,
			agentProfileId:
				override.agentProfileId ||
				targetSetting.agentProfileId ||
				stageDefinition?.runtimeConfig?.agentProfile ||
				null,
			concurrency:
				override.concurrency ||
				targetSetting.concurrency ||
				stageDefinition?.concurrency ||
				1,
		};
	}

	return normalizeScanRuntimeSettings({ stages });
};

export const getRuntimeStageSetting = (
	settings: unknown,
	stageName: string,
) => normalizeScanRuntimeSettings(settings).stages?.[stageName] ?? {};

export const buildEffectiveDisabledStageSet = (input: {
	settings: unknown;
	edges: Array<{ source: string; target: string }>;
	stageNames?: string[];
	rootStageName?: string;
}) => {
	const definitions = loadRuntimeDefinitions();
	const settings = normalizeScanRuntimeSettings(input.settings);
	const stageNames = input.stageNames ?? [
		...definitions.pipelines.full.stageIds,
		...definitions.pipelines.delta.stageIds,
		...definitions.pipelines.research.stageIds,
	];
	const rootStageName = input.rootStageName ?? stageNames[0] ?? "";
	const explicitDisabled = new Set(
		Object.entries(settings.stages ?? {})
			.filter(([, setting]) => setting.disabled === true)
			.map(([stageName]) => stageName),
	);
	for (const stageName of Array.from(explicitDisabled)) {
		if (!isRuntimeStageDisableable(stageName)) {
			explicitDisabled.delete(stageName);
		}
	}

	const bySource = new Map<string, string[]>();
	for (const edge of input.edges) {
		if (explicitDisabled.has(edge.source) || explicitDisabled.has(edge.target)) {
			continue;
		}
		bySource.set(edge.source, [...(bySource.get(edge.source) ?? []), edge.target]);
	}

	const reachable = new Set<string>();
	const queue: string[] = [rootStageName];
	while (queue.length > 0) {
		const stageName = queue.shift();
		if (!stageName || reachable.has(stageName) || explicitDisabled.has(stageName)) {
			continue;
		}
		reachable.add(stageName);
		for (const next of bySource.get(stageName) ?? []) {
			if (!reachable.has(next)) {
				queue.push(next);
			}
		}
	}

	return new Set(
		stageNames.filter(
			(stageName) => explicitDisabled.has(stageName) || !reachable.has(stageName),
		),
	);
};
