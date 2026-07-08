import {
	type ScanRuntimeSettings,
	ScanRuntimeSettingsSchema,
} from "../../db/schema/shared";
import { SCAN_PIPELINE_CATALOG } from "./pipeline/scan-pipeline-catalog";
import { SCAN_STAGE_IDS, SCAN_STAGE_METADATA } from "./stage-metadata";

export const FULL_SCAN_STAGE_IDS =
	SCAN_PIPELINE_CATALOG.pipelines.full.stageIds;

export const DELTA_SCAN_STAGE_IDS =
	SCAN_PIPELINE_CATALOG.pipelines.delta.stageIds;

const RUNTIME_STAGE_IDS = [
	...FULL_SCAN_STAGE_IDS,
	SCAN_STAGE_IDS.deltaScope,
];

export const FULL_SCAN_STAGE_ID_SET = new Set<string>(FULL_SCAN_STAGE_IDS);
export const RUNTIME_STAGE_ID_SET = new Set<string>(RUNTIME_STAGE_IDS);
const RUNTIME_STAGE_BY_ID = new Map(
	SCAN_PIPELINE_CATALOG.stages.map((stage) => [stage.id, stage]),
);

export const isRuntimeStageDisableable = (stageName: string) =>
	RUNTIME_STAGE_BY_ID.get(stageName)?.disableable ?? true;

export const getRuntimeStageDefaultConcurrency = (stageName: string) =>
	RUNTIME_STAGE_BY_ID.get(stageName)?.defaultConcurrency ?? 1;

export type ScanRuntimeStageState = {
	disabled: boolean;
	effectiveDisabled: boolean;
	concurrency: number | null;
	agentProfileId: string | null;
};

export const normalizeScanRuntimeSettings = (
	value: unknown,
): ScanRuntimeSettings => {
	const parsed = ScanRuntimeSettingsSchema.catch({}).parse(value);
	const stages: NonNullable<ScanRuntimeSettings["stages"]> = {};
	for (const [stageName, setting] of Object.entries(parsed.stages ?? {})) {
		if (!RUNTIME_STAGE_ID_SET.has(stageName)) {
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
	const settings = normalizeScanRuntimeSettings(input.settings);
	const stageNames = input.stageNames ?? FULL_SCAN_STAGE_IDS;
	const rootStageName = input.rootStageName ?? SCAN_STAGE_IDS.repositoryScan;
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
