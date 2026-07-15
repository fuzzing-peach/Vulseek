import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

export const VULSEEK_ACP_DRIVER_VERSION = "2026-07-15-sdk-1";
const PROMPT_TIMEOUT_MS = 30 * 60 * 1000;
const SNAPSHOT_DEBOUNCE_MS = 150;
const TERMINAL_TOOL_STATUSES = new Set([
	"completed",
	"failed",
	"cancelled",
	"rejected",
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const asRecord = (value) =>
	value && typeof value === "object" && !Array.isArray(value) ? value : {};
const asString = (value) => (typeof value === "string" ? value : "");
const pendingJsonWrites = new Map();

const atomicWriteJson = async (filePath, value) => {
	if (!filePath) return;
	const previousWrite = pendingJsonWrites.get(filePath) || Promise.resolve();
	const currentWrite = previousWrite.catch(() => {}).then(async () => {
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
		await fs.writeFile(
			temporaryPath,
			`${JSON.stringify(value, null, 2)}\n`,
			"utf-8",
		);
		await fs.rename(temporaryPath, filePath);
	});
	pendingJsonWrites.set(filePath, currentWrite);
	try {
		await currentWrite;
	} finally {
		if (pendingJsonWrites.get(filePath) === currentWrite) {
			pendingJsonWrites.delete(filePath);
		}
	}
};

const appendLog = async (filePath, message) => {
	if (!filePath) return;
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.appendFile(
		filePath,
		`[acp-driver] ${new Date().toISOString()} ${message}\n`,
		"utf-8",
	);
};

const resolveNormalizerPath = () =>
	process.env.VULSEEK_AGENT_EVENTS_PATH || "/opt/vulseek-acp/agent-events.mjs";

const activityForEvent = (event) => {
	if (event.kind === "thinking")
		return { kind: "reasoning", label: "Thinking" };
	if (event.kind === "plan") return { kind: "planning", label: "Planning" };
	if (event.kind === "text") return { kind: "writing", label: "Writing" };
	if (event.kind !== "tool") return null;
	const tool = event.tool_call;
	const names = {
		Bash: ["command", "Bash"],
		Edit: ["writing", "Editing"],
		Write: ["writing", "Writing"],
		Read: ["tool", "Reading"],
		Glob: ["tool", "Searching files"],
		Grep: ["tool", "Searching code"],
		WebSearch: ["web", "Web Search"],
		WebFetch: ["web", "Web Fetch"],
	};
	const [kind, label] = names[tool.name] || ["tool", tool.name || "Tool"];
	const input = asRecord(tool.input);
	const detail = asString(
		input.command || input.file_path || input.query || input.url,
	).slice(0, 240);
	return {
		kind,
		label: TERMINAL_TOOL_STATUSES.has(tool.status)
			? `${label} ${tool.is_error ? "failed" : "completed"}`
			: label,
		...(detail ? { detail } : {}),
		toolCallId: tool.tool_use_id,
	};
};

const createSnapshotWriter = (initialInput, sessionIdRef) => {
	let input = initialInput;
	let revision = 0;
	let timer = null;
	let pendingActivity = null;
	const write = async (status, activity) => {
		revision += 1;
		await atomicWriteJson(input.activityPath, {
			version: 1,
			revision,
			taskId: input.taskId || null,
			sessionId: sessionIdRef.current || null,
			status,
			activity,
			updatedAt: new Date().toISOString(),
		});
	};
	return {
		setInput(nextInput) {
			input = nextInput;
			revision = 0;
			pendingActivity = null;
			if (timer) clearTimeout(timer);
			timer = null;
		},
		async immediate(status, activity) {
			if (timer) clearTimeout(timer);
			timer = null;
			pendingActivity = null;
			await write(status, activity);
		},
		schedule(activity) {
			pendingActivity = activity;
			if (timer) return;
			timer = setTimeout(() => {
				timer = null;
				const next = pendingActivity;
				pendingActivity = null;
				if (next) void write("running", next);
			}, SNAPSHOT_DEBOUNCE_MS);
		},
		async flush() {
			if (timer) clearTimeout(timer);
			timer = null;
			const next = pendingActivity;
			pendingActivity = null;
			if (next) await write("running", next);
		},
	};
};

const isPathInside = (candidate, root) =>
	candidate === root || candidate.startsWith(`${root}${path.sep}`);
const resolveAllowedPath = async (requestedPath, roots, forWrite = false) => {
	const absolute = path.resolve(requestedPath);
	const checkPath = forWrite ? path.dirname(absolute) : absolute;
	const real = await fs.realpath(checkPath);
	const allowed = await Promise.all(
		roots.map((root) => fs.realpath(root).catch(() => path.resolve(root))),
	);
	if (!allowed.some((root) => isPathInside(real, root))) {
		throw new Error(
			`ACP filesystem request is outside allowed roots: ${requestedPath}`,
		);
	}
	return absolute;
};

const choosePermission = (params) => {
	const options = Array.isArray(params.options) ? params.options : [];
	const selected =
		options.find((option) => option.kind === "allow_always") ||
		options.find((option) => option.kind === "allow_once");
	return selected
		? { outcome: { outcome: "selected", optionId: selected.optionId } }
		: { outcome: { outcome: "cancelled" } };
};

const withTimeout = async (promise, timeoutMs, onTimeout) => {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(async () => {
					await onTimeout().catch(() => {});
					reject(
						new Error(
							`ACP prompt timed out after ${Math.round(timeoutMs / 1000)}s`,
						),
					);
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
};

const readNextQueuedTask = async (queueDir) => {
	if (!queueDir) return null;
	await fs.mkdir(queueDir, { recursive: true });
	const entry = (await fs.readdir(queueDir))
		.filter((name) => /^[^.]+\.json$/.test(name))
		.sort()[0];
	if (!entry) return null;
	const source = path.join(queueDir, entry);
	const running = `${source}.running`;
	try {
		await fs.rename(source, running);
	} catch {
		return null;
	}
	try {
		return { input: JSON.parse(await fs.readFile(running, "utf-8")), running };
	} catch (error) {
		await fs.rename(running, `${source}.failed`).catch(() => {});
		throw error;
	}
};

const updateTaskAlias = async (input) => {
	const alias = input.taskAliasRootInContainer;
	const target = input.taskStageRootInContainer;
	if (!alias || !target || alias === target) return;
	await fs.mkdir(target, { recursive: true });
	await fs.rm(alias, { recursive: true, force: true });
	await fs.symlink(target, alias, "dir");
};

const writeTaskState = async (input, value) =>
	atomicWriteJson(input.statePath, {
		...value,
		updatedAt: new Date().toISOString(),
	});

const writeNullableOutput = async (input, stopReason) => {
	if (!input.nullableOutput || stopReason !== "end_turn") return;
	const exists = await fs
		.stat(input.structuredOutputResultPathInContainer)
		.then(() => true)
		.catch(() => false);
	if (!exists) {
		await atomicWriteJson(input.structuredOutputResultPathInContainer, {
			route: null,
			exit: false,
			output: null,
		});
	}
};

const assertCapability = (capabilities, name) => {
	const session =
		capabilities?.sessionCapabilities || capabilities?.session || {};
	if (!session[name])
		throw new Error(`ACP adapter does not support session/${name}`);
};

const run = async () => {
	const inputPath = process.argv[2];
	if (!inputPath) throw new Error("ACP driver input path is required");
	const initialInput = JSON.parse(await fs.readFile(inputPath, "utf-8"));
	let activeInput = initialInput;
	await appendLog(initialInput.driverLifecyclePath, "driver_started");
	const heartbeat = setInterval(() => {
		void appendLog(activeInput.driverLifecyclePath, "heartbeat").catch(
			() => {},
		);
	}, 15_000);
	heartbeat.unref();
	const normalizerModule = await import(
		new URL(`file://${resolveNormalizerPath()}`).href
	);
	const normalizer = normalizerModule.createAgentEventNormalizer({
		format: initialInput.provider === "claude" ? "claude-code" : "codex",
	});
	const sessionIdRef = { current: "" };
	const snapshots = createSnapshotWriter(activeInput, sessionIdRef);
	const roots = [
		initialInput.cwd,
		...(initialInput.additionalDirectories || []),
	].filter(Boolean);
	const command =
		initialInput.adapterCommand ||
		(initialInput.provider === "claude" ? "claude-agent-acp" : "codex-acp");
	const child = spawn(command, initialInput.adapterArgs || [], {
		stdio: ["pipe", "pipe", "pipe"],
		env: {
			...process.env,
			...(initialInput.adapterEnv || {}),
			...(initialInput.agentHomePathInContainer
				? initialInput.provider === "claude"
					? { CLAUDE_CONFIG_DIR: initialInput.agentHomePathInContainer }
					: { CODEX_HOME: initialInput.agentHomePathInContainer }
				: {}),
		},
	});
	child.stderr.on("data", (chunk) => {
		void fs.appendFile(activeInput.stderrPath, chunk).catch(() => {});
	});
	const childExit = new Promise((resolve) =>
		child.once("exit", (code, signal) => resolve({ code, signal })),
	);
	let context = null;
	let promptActive = false;
	const cancel = async () => {
		if (context && sessionIdRef.current && promptActive) {
			await context.notify(acp.methods.agent.session.cancel, {
				sessionId: sessionIdRef.current,
			});
		}
	};
	const stop = async (signal) => {
		await cancel().catch(() => {});
		await appendLog(activeInput.stderrPath, `received ${signal}`);
		child.kill("SIGTERM");
	};
	process.once("SIGTERM", () => void stop("SIGTERM"));
	process.once("SIGINT", () => void stop("SIGINT"));

	const stream = acp.ndJsonStream(
		Writable.toWeb(child.stdin),
		Readable.toWeb(child.stdout),
	);
	const client = acp
		.client({ name: "vulseek-acp-driver", version: VULSEEK_ACP_DRIVER_VERSION })
		.onRequest(acp.methods.client.session.requestPermission, (ctx) =>
			choosePermission(ctx.params),
		)
		.onRequest(acp.methods.client.fs.readTextFile, async (ctx) => {
			const filePath = await resolveAllowedPath(ctx.params.path, roots);
			return { content: await fs.readFile(filePath, "utf-8") };
		})
		.onRequest(acp.methods.client.fs.writeTextFile, async (ctx) => {
			const filePath = await resolveAllowedPath(ctx.params.path, roots, true);
			await fs.writeFile(filePath, ctx.params.content, "utf-8");
			return {};
		})
		.onNotification(acp.methods.client.session.update, async (ctx) => {
			if (ctx.params.sessionId !== sessionIdRef.current) return;
			for (const event of normalizer.push(ctx.params)) {
				if (event.kind === "usage") {
					await atomicWriteJson(activeInput.usagePath, {
						used: event.used,
						...(event.size !== undefined ? { contextSize: event.size } : {}),
						updatedAt: new Date().toISOString(),
					});
					continue;
				}
				const activity = activityForEvent(event);
				if (activity) snapshots.schedule(activity);
			}
		});

	const result = await client.connectWith(stream, async (ctx) => {
		context = ctx;
		const initialized = await ctx.request(acp.methods.agent.initialize, {
			protocolVersion: acp.PROTOCOL_VERSION,
			clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
		});
		assertCapability(initialized.agentCapabilities, "resume");
		assertCapability(initialized.agentCapabilities, "close");
		const openSession = async () => {
			const common = {
				cwd: initialInput.cwd,
				mcpServers: initialInput.mcpServers || [],
				additionalDirectories: initialInput.additionalDirectories || [],
			};
			if (initialInput.threadId) {
				await ctx.request(acp.methods.agent.session.resume, {
					...common,
					sessionId: initialInput.threadId,
				});
				return initialInput.threadId;
			}
			if (initialInput.sessionMode === "fork") {
				assertCapability(initialized.agentCapabilities, "fork");
				const forked = await ctx.request(acp.methods.agent.session.fork, {
					...common,
					sessionId: initialInput.parentSessionId,
				});
				return forked.sessionId;
			}
			const created = await ctx.request(acp.methods.agent.session.new, common);
			return created.sessionId;
		};
		sessionIdRef.current = await openSession();
		process.stdout.write(`THREAD_ID:${sessionIdRef.current}\n`);

		const runTask = async (taskInput) => {
			activeInput = taskInput;
			snapshots.setInput(taskInput);
			normalizer.reset();
			await updateTaskAlias(taskInput);
			if (taskInput.stdoutPath)
				await fs.appendFile(
					taskInput.stdoutPath,
					`THREAD_ID:${sessionIdRef.current}\n`,
				);
			await snapshots.immediate("running", {
				kind: "prompt",
				label: "Starting",
			});
			await writeTaskState(taskInput, {
				promptFinished: false,
				sessionId: sessionIdRef.current,
			});
			promptActive = true;
			let response;
			try {
				response = await withTimeout(
					ctx.request(acp.methods.agent.session.prompt, {
						sessionId: sessionIdRef.current,
						prompt: [{ type: "text", text: taskInput.prompt }],
					}),
					Number(taskInput.promptTimeoutMs || PROMPT_TIMEOUT_MS),
					cancel,
				);
			} catch (error) {
				await snapshots.immediate("error", {
					kind: "error",
					label: "Error",
					detail: error.message,
				});
				await writeTaskState(taskInput, {
					promptFinished: false,
					sessionId: sessionIdRef.current,
					error: error.message,
				});
				throw error;
			} finally {
				promptActive = false;
			}
			await snapshots.flush();
			const usage = asRecord(response.usage);
			if (Object.keys(usage).length) {
				await atomicWriteJson(taskInput.usagePath, {
					...usage,
					updatedAt: new Date().toISOString(),
				});
			}
			await writeNullableOutput(taskInput, response.stopReason);
			await writeTaskState(taskInput, {
				promptFinished: true,
				endTurnReceived: response.stopReason === "end_turn",
				stopReason: response.stopReason,
				sessionId: sessionIdRef.current,
				completedAt: new Date().toISOString(),
			});
			const finalStatus =
				response.stopReason === "cancelled" ? "cancelled" : "completed";
			await snapshots.immediate(finalStatus, {
				kind: finalStatus,
				label: finalStatus === "completed" ? "Completed" : "Cancelled",
			});
		};

		await runTask(initialInput);
		while (initialInput.persistent) {
			const queued = await readNextQueuedTask(initialInput.taskQueueDir);
			if (!queued) {
				await sleep(500);
				continue;
			}
			try {
				await runTask({
					...queued.input,
					driverLifecyclePath:
						queued.input.driverLifecyclePath ||
						initialInput.driverLifecyclePath,
				});
				await fs.rename(queued.running, `${queued.running}.done`);
			} catch (error) {
				await fs.writeFile(
					`${queued.running}.failed.reason.json`,
					JSON.stringify(
						{
							taskId: queued.input.taskId,
							error: error.message,
							failedAt: new Date().toISOString(),
						},
						null,
						2,
					),
				);
				await fs
					.rename(queued.running, `${queued.running}.failed`)
					.catch(() => {});
			}
		}
		await ctx.request(acp.methods.agent.session.close, {
			sessionId: sessionIdRef.current,
		});
		return true;
	});

	child.kill("SIGTERM");
	await Promise.race([childExit, sleep(2000)]);
	clearInterval(heartbeat);
	return result;
};

run().catch(async (error) => {
	const inputPath = process.argv[2];
	try {
		const input = inputPath
			? JSON.parse(await fs.readFile(inputPath, "utf-8"))
			: {};
		await appendLog(
			input.stderrPath,
			error instanceof Error ? error.stack || error.message : String(error),
		);
	} catch {}
	fsSync.writeSync(
		process.stderr.fd,
		`${error instanceof Error ? error.stack || error.message : String(error)}\n`,
	);
	process.exit(1);
});
