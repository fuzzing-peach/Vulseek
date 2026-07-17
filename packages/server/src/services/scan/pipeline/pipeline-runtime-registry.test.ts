import assert from "node:assert/strict";
import test from "node:test";
import {
	deletePipelineRuntime,
	getPipelineRuntimeRegistry,
	setPipelineRuntime,
} from "./pipeline-runtime-registry";

test("pipeline runtime registry is shared through the process global", () => {
	const first = getPipelineRuntimeRegistry<{ id: string }>();
	const second = getPipelineRuntimeRegistry<{ id: string }>();
	const runtime = { id: "runtime-1" };

	setPipelineRuntime("full:job-1", runtime);

	assert.strictEqual(first, second);
	assert.strictEqual(second.get("full:job-1"), runtime);
	deletePipelineRuntime("full:job-1", runtime);
});

test("an old runtime cannot remove a replacement runtime", () => {
	const oldRuntime = { id: "old" };
	const replacement = { id: "replacement" };
	const key = "full:job-replaced";

	setPipelineRuntime(key, oldRuntime);
	setPipelineRuntime(key, replacement);
	deletePipelineRuntime(key, oldRuntime);

	assert.strictEqual(getPipelineRuntimeRegistry().get(key), replacement);
	deletePipelineRuntime(key, replacement);
});
