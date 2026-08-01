import test from "node:test";
import assert from "node:assert/strict";
import { resolveLaunchDisposition } from "./launch-disposition";

test("cancellation wins over an in-flight launch", () => {
	assert.equal(
		resolveLaunchDisposition({
			scanJobStatus: "canceled",
			taskStatus: "launching",
		}),
		"cancel",
	);
	assert.equal(
		resolveLaunchDisposition({
			scanJobStatus: "running",
			taskStatus: "canceled",
		}),
		"cancel",
	);
});

test("pause defers an in-flight launch without canceling the task", () => {
	assert.equal(
		resolveLaunchDisposition({
			scanJobStatus: "paused",
			taskStatus: "launching",
		}),
		"defer",
	);
});

test("a running job keeps a launching task eligible", () => {
	assert.equal(
		resolveLaunchDisposition({
			scanJobStatus: "running",
			taskStatus: "launching",
		}),
		"continue",
	);
});
