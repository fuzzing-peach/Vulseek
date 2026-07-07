import {
	type ScanRuntimeSettings,
	ScanRuntimeSettingsSchema,
} from "@vulseek/server/db/schema";
import { SCAN_STAGE_IDS, SCAN_STAGE_METADATA } from "./stage-metadata";

export const FULL_SCAN_STAGE_IDS = [
	SCAN_STAGE_IDS.repositoryScan,
	SCAN_STAGE_IDS.attackSurfaceModel,
	SCAN_STAGE_IDS.moduleScan,
	SCAN_STAGE_IDS.functionScan,
	SCAN_STAGE_IDS.analysis,
	SCAN_STAGE_IDS.analysisCritic,
	SCAN_STAGE_IDS.verification,
	SCAN_STAGE_IDS.triage,
] as const;

export const RULE_SCAN_STAGE_IDS = [
	SCAN_STAGE_IDS.repositoryScan,
	SCAN_STAGE_IDS.moduleThreatModel,
	SCAN_STAGE_IDS.ruleDesign,
	SCAN_STAGE_IDS.ruleScan,
	SCAN_STAGE_IDS.patternScan,
	SCAN_STAGE_IDS.sinkPreAnalyze,
	SCAN_STAGE_IDS.analysis,
	SCAN_STAGE_IDS.fuzzBuild,
	SCAN_STAGE_IDS.fuzzRun,
	SCAN_STAGE_IDS.analysisCritic,
	SCAN_STAGE_IDS.verification,
	SCAN_STAGE_IDS.triage,
] as const;

export const DELTA_SCAN_STAGE_IDS = [
	SCAN_STAGE_IDS.deltaScope,
	SCAN_STAGE_IDS.functionScan,
	SCAN_STAGE_IDS.analysis,
	SCAN_STAGE_IDS.analysisCritic,
	SCAN_STAGE_IDS.verification,
	SCAN_STAGE_IDS.triage,
] as const;

const RUNTIME_STAGE_IDS = [
	...FULL_SCAN_STAGE_IDS,
	...RULE_SCAN_STAGE_IDS,
	SCAN_STAGE_IDS.deltaScope,
] as const;

export const FULL_SCAN_STAGE_ID_SET = new Set<string>(FULL_SCAN_STAGE_IDS);
export const RUNTIME_STAGE_ID_SET = new Set<string>(RUNTIME_STAGE_IDS);

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
			disabled:
				stageName === SCAN_STAGE_IDS.repositoryScan ||
				stageName === SCAN_STAGE_IDS.deltaScope
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
	explicitDisabled.delete(SCAN_STAGE_IDS.repositoryScan);
	explicitDisabled.delete(SCAN_STAGE_IDS.deltaScope);

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
