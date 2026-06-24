import assert from "node:assert/strict";
import test from "node:test";
import { resolveNextScanPipelineState } from "./scan-state-machine";

const baseFinishedInput = {
	scanJobStatus: "running" as const,
	repositoryTaskStatus: "completed" as const,
	modulePendingCount: 0,
	functionPendingCount: 0,
	moduleFailed: 0,
	functionFailed: 0,
	analysisPendingCount: 0,
	analysisFailed: 0,
	verificationPendingCount: 0,
	verificationFailed: 0,
	triagePendingCount: 0,
	triageFailed: 0,
};

test("scan job remains running while any stage task is still open", () => {
	assert.deepEqual(
		resolveNextScanPipelineState({
			...baseFinishedInput,
			openTaskCount: 1,
		}),
		{ status: "running" },
	);
});

test("scan job can finish when no stage tasks or candidate work remain", () => {
	assert.deepEqual(resolveNextScanPipelineState(baseFinishedInput), {
		status: "finished",
	});
});

test("repository task failure marks scan job failed", () => {
	assert.deepEqual(
		resolveNextScanPipelineState({
			...baseFinishedInput,
			repositoryTaskStatus: "failed",
		}),
		{
			status: "failed",
			errorMessage: "Repository scanning failed",
		},
	);
});
