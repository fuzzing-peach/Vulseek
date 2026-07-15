import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	AGENT_RUNTIME_FILE_NAMES,
	initializeAgentRuntimeFiles,
} from "./agent-runtime-files";

test("initializes only ACP snapshot and driver log artifacts", async () => {
	const runtimeDir = await mkdtemp(path.join(tmpdir(), "agent-runtime-files-"));
	await initializeAgentRuntimeFiles(runtimeDir);
	assert.deepEqual(
		(await readdir(runtimeDir)).sort(),
		Object.values(AGENT_RUNTIME_FILE_NAMES).sort(),
	);
	assert.equal(
		await readFile(path.join(runtimeDir, "usage.json"), "utf-8"),
		"null\n",
	);
	assert.equal(
		await readFile(path.join(runtimeDir, "task-state.json"), "utf-8"),
		"{}\n",
	);
});
