import assert from "node:assert/strict";
import test from "node:test";
import { createTaskIdForDispatchKey } from "../task-id";

test("dispatch keys produce deterministic child task ids", () => {
	const key = "scan-1:parent-1:scan-target-to-analyze-finding:default:3";
	assert.equal(createTaskIdForDispatchKey(key), createTaskIdForDispatchKey(key));
	assert.notEqual(
		createTaskIdForDispatchKey(key),
		createTaskIdForDispatchKey(`${key}:different`),
	);
});

test("dispatch key fan-out indexes distinguish zero-input branches", () => {
	const base = "scan-1:parent-1:edge:default";
	assert.notEqual(
		createTaskIdForDispatchKey(`${base}:0`),
		createTaskIdForDispatchKey(`${base}:1`),
	);
});
