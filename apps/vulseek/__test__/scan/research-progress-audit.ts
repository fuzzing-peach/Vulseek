export type ResearchStageCount = {
	queued: number;
	active: number;
	completed: number;
	failed: number;
	canceled: number;
};

export type ResearchRegistryEntity = {
	key: string;
	revision: number;
	status: string;
};

export type ResearchCycle = {
	kind: "finding-review" | "surface-map";
	key: string;
	cycles: number;
	meaningfulRevision: number;
	progressFingerprint?: string;
};

export type ResearchProgressSnapshot = {
	capturedAt?: string;
	snapshotHash: string;
	stageCounts: Record<string, ResearchStageCount>;
	frontier: string[];
	tracks: ResearchRegistryEntity[];
	findings: ResearchRegistryEntity[];
	primitives: ResearchRegistryEntity[];
	chains: ResearchRegistryEntity[];
	cycles: ResearchCycle[];
	dispatch: {
		pending: number;
		oldestPendingAgeMs: number;
	};
	runtime: {
		registered: boolean;
		jobActive: boolean;
	};
	resources: {
		totalTokens: number;
		artifactBytes: number;
		taskCount: number;
		agentHomeBytesP95: number;
	};
	trackQueue?: {
		queued: number;
		active: number;
		iterationsWithoutDiscovery?: number;
		hasDiscoveryTask?: boolean;
		duplicateKeys?: number;
	};
};

export type ResearchProgressAlert =
	| "finding_review_loop"
	| "surface_map_loop"
	| "queued_track_starvation"
	| "duplicate_track_growth"
	| "pending_dispatch"
	| "dispatch_stalled"
	| "orphan_runtime"
	| "snapshot_drift"
	| "artifact_growth"
	| "agent_home_growth"
	| "token_runaway";

export type ResearchProgressDiff = {
	meaningfulProgress: boolean;
	reasons: string[];
	alerts: ResearchProgressAlert[];
	currentSignature: string;
};

export type ResearchCostStatus = "computed" | "unavailable" | "invalid";

export type ResearchJobCohort = {
	scanJobId: string;
	snapshotHash: string;
};

export type HistoricalResearchJobSnapshot = {
	scanJobId: string;
	snapshotHash: string;
	status: "running" | "paused" | "completed" | "failed" | "canceled";
	deepestStageRank: number;
	openTaskCount: number;
	pendingDispatchCount: number;
	oldestPendingDispatchAgeMs: number;
	effectRevisionMismatchCount: number;
	missingEffectCount: number;
	invalidRouteCount: number;
	totalTokens: number;
	estimatedCost: number;
	pricingConfigured: boolean;
	maxLineageDepth: number;
};

export type HistoricalResearchFinding =
	| "terminal_with_open_tasks"
	| "completed_dispatch_pending"
	| "dispatch_stalled"
	| "registry_revision_mismatch"
	| "registry_effect_missing"
	| "route_integrity_failure"
	| "deep_stage_starvation"
	| "cost_accounting_gap"
	| "lineage_explosion";

export type HistoricalResearchAudit = {
	cohorts: Map<string, string[]>;
	findings: Array<{
		scanJobId: string;
		finding: HistoricalResearchFinding;
	}>;
	deepStageCoverage: {
		jobs: number;
		jobsPastRank: number;
		jobsWithExploitOrReport: number;
	};
};

export const groupResearchJobsBySnapshotHash = (
	jobs: readonly ResearchJobCohort[],
) => {
	const cohorts = new Map<string, string[]>();
	for (const job of jobs) {
		const ids = cohorts.get(job.snapshotHash) ?? [];
		ids.push(job.scanJobId);
		cohorts.set(job.snapshotHash, ids);
	}
	return new Map(
		[...cohorts.entries()].map(([snapshotHash, scanJobIds]) => [
			snapshotHash,
			[...new Set(scanJobIds)].sort(),
		]),
	);
};

export const auditHistoricalResearchJobs = (
	jobs: readonly HistoricalResearchJobSnapshot[],
	options: { deepStageRank?: number } = {},
): HistoricalResearchAudit => {
	const deepStageRank = options.deepStageRank ?? 9;
	const findings: HistoricalResearchAudit["findings"] = [];
	for (const job of jobs) {
		if (job.status !== "running" && job.openTaskCount > 0) {
			findings.push({
				scanJobId: job.scanJobId,
				finding: "terminal_with_open_tasks",
			});
		}
		if (job.pendingDispatchCount > 0) {
			findings.push({
				scanJobId: job.scanJobId,
				finding: "completed_dispatch_pending",
			});
			if (job.oldestPendingDispatchAgeMs > 30_000) {
				findings.push({
					scanJobId: job.scanJobId,
					finding: "dispatch_stalled",
				});
			}
		}
		if (job.effectRevisionMismatchCount > 0) {
			findings.push({
				scanJobId: job.scanJobId,
				finding: "registry_revision_mismatch",
			});
		}
		if (job.missingEffectCount > 0) {
			findings.push({
				scanJobId: job.scanJobId,
				finding: "registry_effect_missing",
			});
		}
		if (job.invalidRouteCount > 0) {
			findings.push({
				scanJobId: job.scanJobId,
				finding: "route_integrity_failure",
			});
		}
		if (
			job.deepestStageRank >= deepStageRank &&
			job.status !== "completed" &&
			job.maxLineageDepth >= 3
		) {
			findings.push({
				scanJobId: job.scanJobId,
				finding: "deep_stage_starvation",
			});
		}
		if (
			resolveResearchCostStatus({
				totalTokens: job.totalTokens,
				estimatedCost: job.estimatedCost,
				pricingConfigured: job.pricingConfigured,
			}) === "invalid"
		) {
			findings.push({
				scanJobId: job.scanJobId,
				finding: "cost_accounting_gap",
			});
		}
		if (job.maxLineageDepth >= 8) {
			findings.push({
				scanJobId: job.scanJobId,
				finding: "lineage_explosion",
			});
		}
	}
	return {
		cohorts: groupResearchJobsBySnapshotHash(jobs),
		findings,
		deepStageCoverage: {
			jobs: jobs.length,
			jobsPastRank: jobs.filter((job) => job.deepestStageRank >= deepStageRank)
				.length,
			jobsWithExploitOrReport: jobs.filter((job) => job.deepestStageRank >= 10)
				.length,
		},
	};
};

export const resolveResearchCostStatus = (input: {
	totalTokens: number;
	estimatedCost: number;
	pricingConfigured: boolean;
}): ResearchCostStatus => {
	if (!input.pricingConfigured) return "unavailable";
	if (input.totalTokens > 0 && input.estimatedCost <= 0) return "invalid";
	return "computed";
};

const sortStrings = (values: string[]) => [...new Set(values)].sort();

const normalizeEntities = (entities: ResearchRegistryEntity[]) =>
	[...entities]
		.sort((left, right) => left.key.localeCompare(right.key))
		.map(({ key, revision, status }) => ({ key, revision, status }));

export const buildResearchProgressSignature = (
	snapshot: ResearchProgressSnapshot,
) =>
	JSON.stringify({
		snapshotHash: snapshot.snapshotHash,
		frontier: sortStrings(snapshot.frontier),
		tracks: normalizeEntities(snapshot.tracks),
		findings: normalizeEntities(snapshot.findings),
		primitives: normalizeEntities(snapshot.primitives),
		chains: normalizeEntities(snapshot.chains),
	});

const entityMap = (entities: ResearchRegistryEntity[]) =>
	new Map(entities.map((entity) => [entity.key, entity]));

const compareEntities = (
	previous: ResearchRegistryEntity[],
	current: ResearchRegistryEntity[],
	reasons: string[],
) => {
	const previousMap = entityMap(previous);
	const currentMap = entityMap(current);
	for (const [key, entity] of currentMap) {
		const prior = previousMap.get(key);
		if (!prior) {
			reasons.push("new_registry_entity");
			continue;
		}
		if (prior.revision !== entity.revision || prior.status !== entity.status) {
			reasons.push("registry_revision_changed");
		}
	}
	for (const key of previousMap.keys()) {
		if (!currentMap.has(key)) reasons.push("registry_entity_removed");
	}
};

const hasRegistryProgress = (
	previous: ResearchProgressSnapshot,
	current: ResearchProgressSnapshot,
) => {
	const reasons: string[] = [];
	compareEntities(previous.tracks, current.tracks, reasons);
	compareEntities(previous.findings, current.findings, reasons);
	compareEntities(previous.primitives, current.primitives, reasons);
	compareEntities(previous.chains, current.chains, reasons);
	if (
		JSON.stringify(sortStrings(previous.frontier)) !==
		JSON.stringify(sortStrings(current.frontier))
	) {
		reasons.push("frontier_changed");
	}
	return reasons;
};

const detectLoop = (
	previous: ResearchCycle[],
	current: ResearchCycle[],
	kind: ResearchCycle["kind"],
) =>
	current.some((cycle) => {
		if (cycle.kind !== kind || cycle.cycles < 2) return false;
		const prior = previous.find(
			(candidate) => candidate.kind === kind && candidate.key === cycle.key,
		);
		return (
			!prior ||
			(cycle.cycles > prior.cycles &&
				(cycle.progressFingerprint !== undefined &&
				prior.progressFingerprint !== undefined
					? cycle.progressFingerprint === prior.progressFingerprint
					: cycle.meaningfulRevision === prior.meaningfulRevision))
		);
	});

const addAlert = (
	alerts: ResearchProgressAlert[],
	alert: ResearchProgressAlert,
) => {
	if (!alerts.includes(alert)) alerts.push(alert);
};

export const diffResearchProgress = (
	previous: ResearchProgressSnapshot,
	current: ResearchProgressSnapshot,
): ResearchProgressDiff => {
	const reasons = hasRegistryProgress(previous, current);
	const alerts: ResearchProgressAlert[] = [];
	if (previous.snapshotHash !== current.snapshotHash) {
		addAlert(alerts, "snapshot_drift");
	}
	if (detectLoop(previous.cycles, current.cycles, "finding-review")) {
		addAlert(alerts, "finding_review_loop");
	}
	if (detectLoop(previous.cycles, current.cycles, "surface-map")) {
		addAlert(alerts, "surface_map_loop");
	}
	const trackQueue = current.trackQueue;
	if (
		trackQueue &&
		trackQueue.queued > 0 &&
		trackQueue.active === 0 &&
		(trackQueue.iterationsWithoutDiscovery === undefined ||
			trackQueue.iterationsWithoutDiscovery >= 2) &&
		trackQueue.hasDiscoveryTask !== true
	) {
		addAlert(alerts, "queued_track_starvation");
	}
	if (trackQueue?.duplicateKeys && trackQueue.duplicateKeys > 0) {
		addAlert(alerts, "duplicate_track_growth");
	}
	if (current.dispatch.pending > 0) addAlert(alerts, "pending_dispatch");
	if (
		current.dispatch.pending > 0 &&
		current.dispatch.oldestPendingAgeMs > 30_000
	) {
		addAlert(alerts, "dispatch_stalled");
	}
	if (current.runtime.registered && !current.runtime.jobActive) {
		addAlert(alerts, "orphan_runtime");
	}
	if (
		current.resources.taskCount > 0 &&
		current.resources.artifactBytes / current.resources.taskCount >
			15 * 1024 * 1024
	) {
		addAlert(alerts, "artifact_growth");
	}
	if (current.resources.agentHomeBytesP95 > 25 * 1024 * 1024) {
		addAlert(alerts, "agent_home_growth");
	}
	if (
		current.resources.totalTokens >= 500_000 &&
		reasons.every((reason) => reason === "frontier_changed")
	) {
		addAlert(alerts, "token_runaway");
	}

	return {
		meaningfulProgress: reasons.length > 0,
		reasons: sortStrings(reasons),
		alerts,
		currentSignature: buildResearchProgressSignature(current),
	};
};

export const auditResearchProgressHistory = (
	history: ResearchProgressSnapshot[],
	options: { noProgressWindows?: number } = {},
) => {
	const requiredWindows = options.noProgressWindows ?? 2;
	let unchangedWindows = 0;
	let maximumUnchangedWindows = 0;
	const alerts = new Set<ResearchProgressAlert>();
	for (let index = 1; index < history.length; index += 1) {
		const previous = history[index - 1];
		const current = history[index];
		if (!previous || !current) continue;
		const diff = diffResearchProgress(previous, current);
		for (const alert of diff.alerts) alerts.add(alert);
		if (diff.meaningfulProgress) {
			unchangedWindows = 0;
		} else {
			unchangedWindows += 1;
			maximumUnchangedWindows = Math.max(
				maximumUnchangedWindows,
				unchangedWindows,
			);
		}
	}
	return {
		stalled: maximumUnchangedWindows >= requiredWindows,
		unchangedWindows: maximumUnchangedWindows,
		alerts: [...alerts],
	};
};
