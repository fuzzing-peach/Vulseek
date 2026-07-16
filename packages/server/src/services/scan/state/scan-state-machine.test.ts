import assert from "node:assert/strict";
import test from "node:test";
import {
	isTerminalScanTaskStatus,
	resolveTerminalScanJobStatus,
} from "./scan-state-machine";

test("scan job finishes when the task graph has no failures", () => {
	assert.equal(
		resolveTerminalScanJobStatus({ rootFailed: false, failedTaskCount: 0, canceled: false }),
		"finished",
	);
});

test("non-root task failures produce a partial terminal status", () => {
	assert.equal(
		resolveTerminalScanJobStatus({ rootFailed: false, failedTaskCount: 2, canceled: false }),
		"partially_finished",
	);
});

test("root failures and cancellation retain their stronger terminal status", () => {
	assert.equal(
		resolveTerminalScanJobStatus({ rootFailed: true, failedTaskCount: 2, canceled: false }),
		"failed",
	);
	assert.equal(
		resolveTerminalScanJobStatus({ rootFailed: false, failedTaskCount: 2, canceled: true }),
		"canceled",
	);
});

test("task status policy distinguishes open and terminal states", () => {
	for (const status of ["pending", "launching", "launched", "starting", "running"]) {
		assert.equal(isTerminalScanTaskStatus(status), false);
	}
	for (const status of ["completed", "failed", "exited", "canceled"]) {
		assert.equal(isTerminalScanTaskStatus(status), true);
	}
});
