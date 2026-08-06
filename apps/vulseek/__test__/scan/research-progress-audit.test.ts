import { describe, expect, it } from "vitest";
import {
	auditHistoricalResearchJobs,
	auditResearchProgressHistory,
	buildResearchProgressSignature,
	diffResearchProgress,
	groupResearchJobsBySnapshotHash,
	type ResearchProgressSnapshot,
	resolveResearchCostStatus,
} from "./research-progress-audit";

const snapshot = (
	overrides: Partial<ResearchProgressSnapshot> = {},
): ResearchProgressSnapshot => ({
	snapshotHash: "definition-a",
	stageCounts: {
		"track-plan": {
			queued: 0,
			active: 1,
			completed: 2,
			failed: 0,
			canceled: 0,
		},
	},
	frontier: ["track-plan:active"],
	tracks: [{ key: "track-a", revision: 1, status: "active" }],
	findings: [],
	primitives: [],
	chains: [],
	cycles: [],
	dispatch: { pending: 0, oldestPendingAgeMs: 0 },
	runtime: { registered: true, jobActive: true },
	resources: {
		totalTokens: 12_000,
		artifactBytes: 1_000,
		taskCount: 2,
		agentHomeBytesP95: 1_000,
	},
	...overrides,
});

describe("research progress audit", () => {
	it("keeps historical findings inside snapshot cohorts and exposes deep progress failures", () => {
		const result = auditHistoricalResearchJobs([
			{
				scanJobId: "job-old",
				snapshotHash: "hash-old",
				status: "failed",
				deepestStageRank: 9,
				openTaskCount: 0,
				pendingDispatchCount: 2,
				oldestPendingDispatchAgeMs: 60_000,
				effectRevisionMismatchCount: 1,
				missingEffectCount: 0,
				invalidRouteCount: 1,
				totalTokens: 10_000,
				estimatedCost: 0.1,
				pricingConfigured: true,
				maxLineageDepth: 4,
			},
			{
				scanJobId: "job-new",
				snapshotHash: "hash-new",
				status: "canceled",
				deepestStageRank: 10,
				openTaskCount: 1,
				pendingDispatchCount: 0,
				oldestPendingDispatchAgeMs: 0,
				effectRevisionMismatchCount: 0,
				missingEffectCount: 1,
				invalidRouteCount: 0,
				totalTokens: 600_000,
				estimatedCost: 0,
				pricingConfigured: true,
				maxLineageDepth: 8,
			},
		]);

		expect([...result.cohorts.keys()]).toEqual(["hash-old", "hash-new"]);
		expect(result.deepStageCoverage).toEqual({
			jobs: 2,
			jobsPastRank: 2,
			jobsWithExploitOrReport: 1,
		});
		expect(result.findings).toEqual(
			expect.arrayContaining([
				{ scanJobId: "job-old", finding: "completed_dispatch_pending" },
				{ scanJobId: "job-old", finding: "dispatch_stalled" },
				{ scanJobId: "job-old", finding: "registry_revision_mismatch" },
				{ scanJobId: "job-old", finding: "route_integrity_failure" },
				{ scanJobId: "job-old", finding: "deep_stage_starvation" },
				{ scanJobId: "job-new", finding: "terminal_with_open_tasks" },
				{ scanJobId: "job-new", finding: "registry_effect_missing" },
				{ scanJobId: "job-new", finding: "cost_accounting_gap" },
				{ scanJobId: "job-new", finding: "lineage_explosion" },
			]),
		);
	});

	it("ignores timestamps, task churn, and token growth when the research state is unchanged", () => {
		const first = snapshot();
		const second = snapshot({
			capturedAt: "2026-07-26T10:05:00.000Z",
			stageCounts: {
				"track-plan": {
					queued: 4,
					active: 0,
					completed: 6,
					failed: 0,
					canceled: 0,
				},
			},
			cycles: [
				{
					kind: "finding-review",
					key: "finding-a",
					cycles: 3,
					meaningfulRevision: 0,
				},
			],
			resources: { ...first.resources, totalTokens: 42_000, taskCount: 8 },
		});

		expect(buildResearchProgressSignature(first)).toBe(
			buildResearchProgressSignature(second),
		);
		expect(diffResearchProgress(first, second).meaningfulProgress).toBe(false);
	});

	it("recognizes entity revisions, new entities, and frontier movement", () => {
		const result = diffResearchProgress(
			snapshot(),
			snapshot({
				frontier: ["vulnerability-discovery:queued"],
				tracks: [{ key: "track-a", revision: 2, status: "exhausted" }],
				findings: [{ key: "finding-a", revision: 0, status: "discovered" }],
			}),
		);

		expect(result.meaningfulProgress).toBe(true);
		expect(result.reasons).toEqual(
			expect.arrayContaining([
				"registry_revision_changed",
				"new_registry_entity",
				"frontier_changed",
			]),
		);
	});

	it("keeps historical comparisons inside definition snapshot cohorts", () => {
		const cohorts = groupResearchJobsBySnapshotHash([
			{ scanJobId: "job-b", snapshotHash: "hash-2" },
			{ scanJobId: "job-a", snapshotHash: "hash-1" },
			{ scanJobId: "job-b", snapshotHash: "hash-2" },
		]);

		expect([...cohorts.entries()]).toEqual([
			["hash-2", ["job-b"]],
			["hash-1", ["job-a"]],
		]);
	});

	it("detects finding and surface loops without evidence progress", () => {
		const result = diffResearchProgress(
			snapshot({
				cycles: [
					{
						kind: "finding-review",
						key: "finding-a",
						cycles: 1,
						meaningfulRevision: 2,
						progressFingerprint: "evidence-unchanged",
					},
				],
			}),
			snapshot({
				cycles: [
					{
						kind: "finding-review",
						key: "finding-a",
						cycles: 3,
						meaningfulRevision: 2,
						progressFingerprint: "evidence-unchanged",
					},
					{
						kind: "surface-map",
						key: "surface-a",
						cycles: 2,
						meaningfulRevision: 0,
						progressFingerprint: "inventory-unchanged",
					},
				],
			}),
		);

		expect(result.alerts).toEqual(
			expect.arrayContaining(["finding_review_loop", "surface_map_loop"]),
		);
	});

	it("does not flag a loop when evidence or surface inventory changes", () => {
		const result = diffResearchProgress(
			snapshot({
				cycles: [
					{
						kind: "finding-review",
						key: "finding-a",
						cycles: 2,
						meaningfulRevision: 2,
						progressFingerprint: "evidence-v1",
					},
				],
			}),
			snapshot({
				cycles: [
					{
						kind: "finding-review",
						key: "finding-a",
						cycles: 3,
						meaningfulRevision: 3,
						progressFingerprint: "evidence-v2",
					},
				],
			}),
		);

		expect(result.alerts).not.toContain("finding_review_loop");
	});

	it("flags queued starvation, pending dispatch, orphan runtime, drift, and resource runaway", () => {
		const result = diffResearchProgress(
			snapshot(),
			snapshot({
				snapshotHash: "definition-b",
				frontier: ["track-plan:queued"],
				trackQueue: {
					queued: 2,
					active: 0,
					iterationsWithoutDiscovery: 3,
					hasDiscoveryTask: false,
					duplicateKeys: 1,
				},
				dispatch: { pending: 2, oldestPendingAgeMs: 20 * 60 * 1000 },
				runtime: { registered: true, jobActive: false },
				resources: {
					totalTokens: 600_000,
					artifactBytes: 40 * 1024 * 1024,
					taskCount: 2,
					agentHomeBytesP95: 30 * 1024 * 1024,
				},
			}),
		);

		expect(result.alerts).toEqual(
			expect.arrayContaining([
				"queued_track_starvation",
				"duplicate_track_growth",
				"pending_dispatch",
				"dispatch_stalled",
				"orphan_runtime",
				"snapshot_drift",
				"artifact_growth",
				"agent_home_growth",
				"token_runaway",
			]),
		);
	});

	it("marks a history stalled only after repeated unchanged semantic signatures", () => {
		const history = [
			snapshot({ capturedAt: "2026-07-26T10:00:00.000Z" }),
			snapshot({
				capturedAt: "2026-07-26T10:15:00.000Z",
				resources: {
					...snapshot().resources,
					totalTokens: 50_000,
					taskCount: 5,
				},
			}),
			snapshot({
				capturedAt: "2026-07-26T10:30:00.000Z",
				resources: {
					...snapshot().resources,
					totalTokens: 90_000,
					taskCount: 9,
				},
			}),
		];

		const result = auditResearchProgressHistory(history, {
			noProgressWindows: 2,
		});
		expect(result.stalled).toBe(true);
		expect(result.unchangedWindows).toBe(2);
	});

	it("distinguishes unavailable pricing from an incorrectly zero calculated cost", () => {
		expect(
			resolveResearchCostStatus({
				totalTokens: 10_000,
				estimatedCost: 0,
				pricingConfigured: false,
			}),
		).toBe("unavailable");
		expect(
			resolveResearchCostStatus({
				totalTokens: 10_000,
				estimatedCost: 0,
				pricingConfigured: true,
			}),
		).toBe("invalid");
		expect(
			resolveResearchCostStatus({
				totalTokens: 10_000,
				estimatedCost: 0.25,
				pricingConfigured: true,
			}),
		).toBe("computed");
	});
});
