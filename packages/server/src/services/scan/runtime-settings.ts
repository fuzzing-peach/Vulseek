import {
	type ScanRuntimeSettings,
	ScanRuntimeSettingsSchema,
} from "@dokploy/server/db/schema";
import { SCAN_STAGE_IDS, SCAN_STAGE_METADATA } from "./stage-metadata";

export const FULL_SCAN_STAGE_IDS = Object.values(SCAN_STAGE_METADATA).map(
	(stage) => stage.id,
);

export const FULL_SCAN_STAGE_ID_SET = new Set<string>(FULL_SCAN_STAGE_IDS);

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
		if (!FULL_SCAN_STAGE_ID_SET.has(stageName)) {
			continue;
		}
		stages[stageName] = {
			disabled:
				stageName === SCAN_STAGE_IDS.repositoryScan
					? false
					: setting.disabled === true,
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
}) => {
	const settings = normalizeScanRuntimeSettings(input.settings);
	const stageNames = input.stageNames ?? FULL_SCAN_STAGE_IDS;
	const explicitDisabled = new Set(
		Object.entries(settings.stages ?? {})
			.filter(([, setting]) => setting.disabled === true)
			.map(([stageName]) => stageName),
	);
	explicitDisabled.delete(SCAN_STAGE_IDS.repositoryScan);

	const bySource = new Map<string, string[]>();
	for (const edge of input.edges) {
		if (explicitDisabled.has(edge.source) || explicitDisabled.has(edge.target)) {
			continue;
		}
		bySource.set(edge.source, [...(bySource.get(edge.source) ?? []), edge.target]);
	}

	const reachable = new Set<string>();
	const queue: string[] = [SCAN_STAGE_IDS.repositoryScan];
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
