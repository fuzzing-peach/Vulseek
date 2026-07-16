import assert from "node:assert/strict";
import test from "node:test";
import {
	isTerminalScanTaskStatus,
	resolveTerminalScanJobStatus,
} from "./scan-state-machine";

test("settlement policy returns finished without failures", () => {
	assert.equal(
		resolveTerminalScanJobStatus({
			rootFailed: false,
			failedTaskCount: 0,
			canceled: false,
		}),
		"finished",
	);
});

test("settlement policy returns partially_finished for non-root failures", () => {
	assert.equal(
		resolveTerminalScanJobStatus({
			rootFailed: false,
			failedTaskCount: 1,
			canceled: false,
		}),
		"partially_finished",
	);
});

test("root failure and cancellation take precedence", () => {
	assert.equal(
		resolveTerminalScanJobStatus({ rootFailed: true, failedTaskCount: 1, canceled: false }),
		"failed",
	);
	assert.equal(
		resolveTerminalScanJobStatus({ rootFailed: true, failedTaskCount: 1, canceled: true }),
		"canceled",
	);
});

test("settlement only treats terminal task statuses as closed", () => {
	assert.equal(isTerminalScanTaskStatus("running"), false);
	assert.equal(isTerminalScanTaskStatus("completed"), true);
});
