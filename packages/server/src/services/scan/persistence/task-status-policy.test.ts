import assert from "node:assert/strict";
import test from "node:test";
import {
	getAllowedJobStatusesForTaskTransition,
	isTaskCompletionAllowed,
	isTaskLaunchAllowed,
} from "./task-status-policy";

test("only running jobs may launch, requeue, or create child work", () => {
	assert.equal(isTaskLaunchAllowed("running"), true);
	for (const status of ["pending", "paused", "failed", "canceled"] as const) {
		assert.equal(isTaskLaunchAllowed(status), false);
	}
});

test("paused jobs allow active task completion but not new work", () => {
	assert.equal(isTaskCompletionAllowed("paused"), true);
	assert.deepEqual(getAllowedJobStatusesForTaskTransition("completed"), [
		"running",
		"paused",
	]);
	assert.deepEqual(getAllowedJobStatusesForTaskTransition("launching"), [
		"running",
	]);
});

test("cancellation is allowed only before a terminal job state", () => {
	assert.deepEqual(getAllowedJobStatusesForTaskTransition("canceled"), [
		"pending",
		"running",
		"paused",
	]);
});
