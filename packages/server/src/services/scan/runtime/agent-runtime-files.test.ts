import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	AGENT_RUNTIME_FILE_NAMES,
	initializeAgentRuntimeFiles,
} from "./agent-runtime-files";

test("initializes only the unified driver stdout artifact", async () => {
	const runtimeDir = await mkdtemp(path.join(tmpdir(), "agent-runtime-files-"));
	await initializeAgentRuntimeFiles(runtimeDir);
	assert.deepEqual(
		(await readdir(runtimeDir)).sort(),
		Object.values(AGENT_RUNTIME_FILE_NAMES).sort(),
	);
	assert.equal(await readFile(path.join(runtimeDir, "stdout"), "utf-8"), "");
});
