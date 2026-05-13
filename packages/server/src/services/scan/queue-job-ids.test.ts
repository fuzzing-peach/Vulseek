import assert from "node:assert/strict";
import test from "node:test";
import {
	buildKnownQueueJobIdsForTask,
	buildQueueTaskJobId,
} from "./queue-job-ids";

test("buildQueueTaskJobId uses queue name as the canonical job id prefix", () => {
	assert.equal(
		buildQueueTaskJobId("scan:job-1:module", "task-1"),
		"scan:job-1:module:task-1",
	);
});

test("buildKnownQueueJobIdsForTask includes legacy and canonical ids for retry cleanup", () => {
	assert.deepEqual(
		buildKnownQueueJobIdsForTask(
			{ name: "scan:job-1:analysis" },
			{
				stageName: "AnalysisStage",
				taskId: "analysis-1",
				scanJobId: "job-1",
			},
		),
		["scan:job-1:analysis:analysis-1", "analysis:analysis-1"],
	);

	assert.deepEqual(
		buildKnownQueueJobIdsForTask(
			{ name: "scan:job-1:repository" },
			{
				stageName: "RepositoryScanningStage",
				taskId: "job-1",
				scanJobId: "job-1",
			},
		),
		["scan:job-1:repository:job-1", "repository:job-1"],
	);
});
