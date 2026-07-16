import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const run = (command, args, options) =>
	new Promise((resolve, reject) => {
		const child = spawn(command, args, options);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});

const waitFor = async (predicate, timeoutMs = 10_000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`Condition was not met within ${timeoutMs}ms`);
};

const readEvents = async (filePath) =>
	(await readFile(filePath, "utf-8"))
		.trim()
		.split("\n")
		.filter(Boolean)
		.map(JSON.parse);

test("ACP driver creates a session and writes normalized snapshots", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "vulseek-acp-driver-"));
	const adapterPath = path.join(dir, "fake-adapter.mjs");
	const inputPath = path.join(dir, "input.json");
	const outputPath = path.join(dir, "output.json");
	const stdoutPath = path.join(dir, "stdout");

	await writeFile(
		adapterPath,
		`
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, fork: {}, close: {} } } } });
  if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "thread-1" } });
  if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "thread-1", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Inspecting" } } } });
    for (let used = 1; used <= 64; used += 1) {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "thread-1", update: { sessionUpdate: "usage_update", used, size: 1000 } } });
    }
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "thread-1", update: { sessionUpdate: "usage_update", used: 42, size: 1000 } } });
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
  if (message.method === "session/close") { send({ jsonrpc: "2.0", id: message.id, result: {} }); process.exit(0); }
});
`,
		"utf-8",
	);
	await writeFile(
		inputPath,
		JSON.stringify({
			taskId: "task-1",
			provider: "codex",
			cwd: dir,
			prompt: "Inspect the repository",
			adapterCommand: process.execPath,
			adapterArgs: [adapterPath],
			stdoutPath,
			structuredOutputResultPathInContainer: outputPath,
			nullableOutput: true,
			persistent: false,
		}),
		"utf-8",
	);

	const result = await run(
		process.execPath,
		[
			path.resolve(
				process.cwd(),
				"packages/server/src/services/dockerfiles/vulseek-acp-driver.mjs",
			),
			inputPath,
		],
		{
			cwd: process.cwd(),
			env: {
				...process.env,
				VULSEEK_AGENT_EVENTS_PATH: path.resolve(
					process.cwd(),
					"vendor/claude-replay/src/agent-events.mjs",
				),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);

	assert.equal(result.code, 0, result.stderr);
	const events = await readEvents(stdoutPath);
	assert.equal(events.some((event) => event.type === "start"), true);
	assert.equal(
		events.some(
			(event) =>
				event.type === "thread" && event.threadId === "thread-1",
		),
		true,
	);
	assert.equal(events.some((event) => event.type === "activity"), true);
	assert.deepEqual(
		events.findLast((event) => event.type === "usage")?.usage,
		{ used: 42, contextSize: 1000 },
	);
	assert.deepEqual(
		events.findLast((event) => event.type === "task_done"),
		{
			type: "task_done",
			taskId: "task-1",
			status: "completed",
			stopReason: "end_turn",
		},
	);
	assert.equal(events.findLast((event) => event.type === "exit")?.code, undefined);
	assert.equal(JSON.parse(await readFile(outputPath, "utf-8")).output, null);
});

for (const scenario of [
	{
		name: "resumes the current task session before considering fork",
		input: {
			threadId: "current-thread",
			sessionMode: "fork",
			parentSessionId: "parent-thread",
		},
		expectedMethod: "session/resume",
		expectedSessionId: "current-thread",
	},
	{
		name: "forks the parent when no current session exists",
		input: { sessionMode: "fork", parentSessionId: "parent-thread" },
		expectedMethod: "session/fork",
		expectedSessionId: "forked-thread",
	},
]) {
	test(`ACP driver ${scenario.name}`, async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "vulseek-acp-session-"));
		const adapterPath = path.join(dir, "fake-adapter.mjs");
		const requestLogPath = path.join(dir, "requests.jsonl");
		const inputPath = path.join(dir, "input.json");
		await writeFile(
			adapterPath,
			`
import fs from "node:fs";
import readline from "node:readline";
const requestLogPath = process.argv[2];
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(requestLogPath, JSON.stringify({ method: message.method, params: message.params }) + "\\n");
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, fork: {}, close: {} } } } });
  if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "new-thread" } });
  if (message.method === "session/resume") send({ jsonrpc: "2.0", id: message.id, result: {} });
  if (message.method === "session/fork") send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "forked-thread" } });
  if (message.method === "session/prompt") send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  if (message.method === "session/close") { send({ jsonrpc: "2.0", id: message.id, result: {} }); process.exit(0); }
});
`,
			"utf-8",
		);
		await writeFile(
			inputPath,
			JSON.stringify({
				taskId: "task-session",
				provider: "codex",
				cwd: dir,
				prompt: "continue",
				adapterCommand: process.execPath,
				adapterArgs: [adapterPath, requestLogPath],
				stdoutPath: path.join(dir, "stdout"),
				structuredOutputResultPathInContainer: path.join(dir, "output.json"),
				persistent: false,
				...scenario.input,
			}),
			"utf-8",
		);

		const result = await run(
			process.execPath,
			[
				path.resolve(
					process.cwd(),
					"packages/server/src/services/dockerfiles/vulseek-acp-driver.mjs",
				),
				inputPath,
			],
			{
				cwd: process.cwd(),
				env: {
					...process.env,
					VULSEEK_AGENT_EVENTS_PATH: path.resolve(
						process.cwd(),
						"vendor/claude-replay/src/agent-events.mjs",
					),
				},
				stdio: ["ignore", "pipe", "pipe"],
			},
		);

		assert.equal(result.code, 0, result.stderr);
		assert.equal(result.stdout, "");
		const requests = (await readFile(requestLogPath, "utf-8"))
			.trim()
			.split("\n")
			.map(JSON.parse);
		assert.equal(
			requests.some((request) => request.method === scenario.expectedMethod),
			true,
		);
		assert.equal(
			requests.some((request) => request.method === "session/new"),
			false,
		);
		if (scenario.expectedMethod === "session/resume") {
			assert.equal(
				requests.some((request) => request.method === "session/fork"),
				false,
			);
		}
	});
}

test("ACP driver reuses one session for persistent queued tasks", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "vulseek-acp-persistent-"));
	const adapterPath = path.join(dir, "fake-adapter.mjs");
	const requestLogPath = path.join(dir, "requests.jsonl");
	const queueDir = path.join(dir, "queue");
	const firstDir = path.join(dir, "first");
	const secondDir = path.join(dir, "second");
	const inputPath = path.join(dir, "input.json");
	await mkdir(queueDir, { recursive: true });
	await writeFile(
		adapterPath,
		`
import fs from "node:fs";
import readline from "node:readline";
const requestLogPath = process.argv[2];
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(requestLogPath, JSON.stringify({ method: message.method, params: message.params }) + "\\n");
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, fork: {}, close: {} } } } });
  if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "persistent-thread" } });
  if (message.method === "session/prompt") send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  if (message.method === "session/cancel") return;
});
`,
		"utf-8",
	);

	const taskInput = (taskId, runtimeDir, prompt) => ({
		taskId,
		provider: "codex",
		cwd: dir,
		prompt,
		adapterCommand: process.execPath,
		adapterArgs: [adapterPath, requestLogPath],
		stdoutPath: path.join(runtimeDir, "stdout"),
		structuredOutputResultPathInContainer: path.join(runtimeDir, "output.json"),
		taskStageRootInContainer: runtimeDir,
		taskAliasRootInContainer: path.join(dir, "task"),
	});
	const initialInput = {
		...taskInput("task-1", firstDir, "first prompt"),
		persistent: true,
		taskQueueDir: queueDir,
	};
	await writeFile(inputPath, JSON.stringify(initialInput), "utf-8");

	const child = spawn(
		process.execPath,
		[
			path.resolve(
				process.cwd(),
				"packages/server/src/services/dockerfiles/vulseek-acp-driver.mjs",
			),
			inputPath,
		],
		{
			cwd: process.cwd(),
			env: {
				...process.env,
				VULSEEK_AGENT_EVENTS_PATH: path.resolve(
					process.cwd(),
					"vendor/claude-replay/src/agent-events.mjs",
				),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	try {
		await waitFor(async () => {
			try {
				return (
					(await readEvents(path.join(firstDir, "stdout"))).some(
						(event) => event.type === "task_done" && event.taskId === "task-1",
					)
				);
			} catch {
				return false;
			}
		});
		await writeFile(
			path.join(queueDir, "0001-task.json.running.failed.reason.json"),
			JSON.stringify({
				taskId: "failed-task",
				error: "previous failure",
				failedAt: new Date().toISOString(),
			}),
			"utf-8",
		);
		await writeFile(
			path.join(queueDir, "0002-task.json"),
			JSON.stringify(taskInput("task-2", secondDir, "second prompt")),
			"utf-8",
		);
		await waitFor(async () => {
			try {
				return (
					(await readEvents(path.join(secondDir, "stdout"))).some(
						(event) => event.type === "task_done" && event.taskId === "task-2",
					)
				);
			} catch {
				return false;
			}
		});
		const requests = (await readFile(requestLogPath, "utf-8"))
			.trim()
			.split("\n")
			.map(JSON.parse);
		assert.equal(
			requests.filter((request) => request.method === "session/new").length,
			1,
		);
		assert.equal(
			requests.filter((request) => request.method === "session/prompt").length,
			2,
		);
		assert.deepEqual(
			requests
				.filter((request) => request.method === "session/prompt")
				.map((request) => request.params.sessionId),
			["persistent-thread", "persistent-thread"],
		);
		assert.equal(
			(await readEvents(path.join(secondDir, "stdout"))).some(
				(event) =>
					event.type === "activity" &&
					event.status === "completed",
			),
			true,
		);
	} finally {
		child.kill("SIGTERM");
		await Promise.race([
			new Promise((resolve) => child.once("close", resolve)),
			new Promise((resolve) => setTimeout(resolve, 3_000)),
		]);
		if (child.exitCode === null) child.kill("SIGKILL");
	}
	assert.doesNotMatch(stderr, /Condition was not met/);
});
