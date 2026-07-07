import assert from "node:assert/strict";
import test from "node:test";
import { backfillVulnerabilityCandidatesFromTasksWithDeps } from "./candidate-backfill";
import { CANDIDATE_PRODUCER_STAGE_NAMES } from "./candidate-sync";

test("backfillVulnerabilityCandidatesFromTasksWithDeps scans all producer stages and continues after warnings", async () => {
	const syncedTaskIds: string[] = [];
	let observedScanJobId: string | undefined;
	let observedStageNames: readonly string[] = [];

	const result = await backfillVulnerabilityCandidatesFromTasksWithDeps(
		{ scanJobId: "scan-job-1" },
		{
			listProducerTaskIds: async ({ scanJobId, stageNames }) => {
				observedScanJobId = scanJobId;
				observedStageNames = stageNames;
				return ["scan-target-task", "function-scan-task", "sink-task"];
			},
			syncProducerTask: async (taskId) => {
				syncedTaskIds.push(taskId);
				if (taskId === "function-scan-task") {
					throw new Error("artifact missing");
				}
				return { synced: taskId === "scan-target-task" ? 2 : 1 };
			},
		},
		CANDIDATE_PRODUCER_STAGE_NAMES,
	);

	assert.equal(observedScanJobId, "scan-job-1");
	assert.deepEqual(observedStageNames, CANDIDATE_PRODUCER_STAGE_NAMES);
	assert.deepEqual(syncedTaskIds, [
		"scan-target-task",
		"function-scan-task",
		"sink-task",
	]);
	assert.deepEqual(result, {
		tasks: 3,
		synced: 3,
		warnings: [
			{
				taskId: "function-scan-task",
				message: "artifact missing",
			},
		],
	});
});
