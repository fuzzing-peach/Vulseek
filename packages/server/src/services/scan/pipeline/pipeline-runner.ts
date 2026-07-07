import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execAsync } from "../../../utils/process/execAsync";
import { findScanJobByIdRepo } from "../persistence/scan-job.repo";
import { stopSandboxAgentServerInContainer } from "../../sandbox-agent/runtime";
import {
	CANDIDATE_PRODUCER_STAGE_NAMES,
	syncVulnerabilityCandidatesFromProducerTask,
} from "../persistence/candidate.repo";
import {
	bindStageLaneRuntimeRepo,
	claimIdleStageLaneRuntimeRepo,
	claimSpecificStageLaneRuntimeRepo,
	createStageGroupInstanceRepo,
	ensureStageGroupLaneMembershipRepo,
	findStageGroupInstanceByIdRepo,
	findStageGroupLaneMembershipRepo,
	findStageLaneRuntimeByActiveTaskIdRepo,
	findStageLaneRuntimeRepo,
	listActiveStageGroupLaneMembershipsForStageRepo,
	listStageGroupLaneMembershipsRepo,
	listStageLaneRuntimesByScanJobIdRepo,
	markStageGroupInstanceExitedRepo,
	releaseStageLaneRuntimeRepo,
	resetClaimedStageLaneRuntimeForFreshStartRepo,
	resetStageLaneRuntimesByScanJobIdRepo,
	resetStageLaneRuntimeByLaneForExitRepo,
	resetStageLaneRuntimeForExitRepo,
	resetStageLaneRuntimeSessionForExitRepo,
	type StageLaneRuntime,
} from "../persistence/stage-lane-runtime.repo";
import {
	countActiveTasksByScanJobAndStageRepo,
	countOpenTasksByScanJobIdRepo,
	countTasksByScanJobStageAndStatusRepo,
	findTaskByIdRepo,
	listActiveTasksByScanJobAndStageRepo,
	listTasksByScanJobIdRepo,
	transitionTaskStatusRepo,
	updateTaskRepo,
} from "../persistence/task.repo";
import { buildKnownQueueJobIdsForTask } from "../queue-job-ids";
import { removeContainer } from "../runtime/run-single-turn-agent";
import {
	extractPromptResponseUsage,
	hasEndTurnInJsonlContent,
	SANDBOX_AGENT_RUNTIME_FILE_NAMES,
	summarizeSandboxAgentTokenUsage,
} from "../runtime/sandbox-agent-shared";
import { buildEffectiveDisabledStageSet } from "../runtime-settings";
import {
	createStageContext,
	type PipelineContext,
	type StageContext,
} from "../stages/full-scan-stage.runtime";
import { resolveStageTaskName } from "../stage-task-name";
import { SCAN_STAGE_IDS } from "../stage-metadata";
import {
	type FirstStageInputOf,
	getDownstreamEdges,
	getStageGroup,
	getStageLeaderGroup,
	getStageRouteOutputSchemas,
	isStageInGroup,
	type PipelineDefinition,
	selectDownstreamEdgesForRoute,
	validatePipelineRouteConfiguration,
} from "./pipeline-definition";
import {
	isFanoutStage,
	type StageDefinition,
	type StageExecution,
	type StageQueueScope,
} from "./stage-definition";

type PipelineRefreshContext = {
	refreshPipelineState?: () => Promise<void>;
};

type PipelineScanJobContext = PipelineContext & {
	scanJob: {
		scanJobId: string;
		repositoryTaskId?: string | null;
		applicationId: string | null;
		composeId: string | null;
	};
};

const hasPipelineScanJobContext = (
	ctx: PipelineContext,
): ctx is PipelineScanJobContext =>
	"scanJob" in ctx &&
	Boolean((ctx as PipelineScanJobContext).scanJob?.scanJobId);

const refreshPipelineState = async (ctx: unknown) => {
	await (ctx as PipelineRefreshContext).refreshPipelineState?.();
};

const schedulePipelineStateRefresh = (ctx: unknown) => {
	void refreshPipelineState(ctx).catch((error) => {
		logPipelineEvent("pipeline_state.refresh_failed", {
			errorMessage: getErrorMessage(error),
		});
	});
};

const getErrorMessage = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

const asRecord = (value: unknown): Record<string, unknown> | null =>
	value && typeof value === "object"
		? (value as Record<string, unknown>)
		: null;

const stringField = (
	record: Record<string, unknown> | null,
	key: string,
): string | null => {
	const value = record?.[key];
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: null;
};

const extractJsonRpcErrorMessage = (record: unknown): string | null => {
	const envelope = asRecord(record);
	const payload = asRecord(envelope?.payload) ?? envelope;
	const error = asRecord(payload?.error);
	if (!error) {
		return null;
	}

	const data = asRecord(error.data);
	const dataMessage = stringField(data, "message");
	const errorInfo =
		stringField(data, "codex_error_info") ||
		stringField(data, "error_info") ||
		stringField(data, "type");
	const rpcMessage = stringField(error, "message");
	const code =
		typeof error.code === "number" || typeof error.code === "string"
			? String(error.code)
			: null;

	if (errorInfo && dataMessage) {
		return `ACP JSON-RPC error: ${errorInfo}: ${dataMessage}`;
	}
	if (dataMessage) {
		return `ACP JSON-RPC error: ${dataMessage}`;
	}
	if (errorInfo && rpcMessage) {
		return `ACP JSON-RPC error: ${errorInfo}: ${rpcMessage}`;
	}
	if (rpcMessage && code) {
		return `ACP JSON-RPC error ${code}: ${rpcMessage}`;
	}
	if (rpcMessage) {
		return `ACP JSON-RPC error: ${rpcMessage}`;
	}
	if (code) {
		return `ACP JSON-RPC error ${code}`;
	}
	return null;
};

const readLastJsonRpcErrorMessageFromJsonl = async (jsonlPath: string) => {
	const content = await fs.readFile(jsonlPath, "utf-8").catch(() => "");
	const lines = content.split(/\r?\n/);
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index]?.trim();
		if (!line) {
			continue;
		}
		try {
			const message = extractJsonRpcErrorMessage(JSON.parse(line));
			if (message) {
				return message;
			}
		} catch {}
	}
	return null;
};

const MAX_TRANSIENT_LAUNCH_RETRIES = 5;

const isTransientRuntimeLaunchError = (error: unknown) => {
	const message = getErrorMessage(error);
	return (
		message.includes("failed to create task for container") ||
		message.includes("OCI runtime create failed") ||
		message.includes("can't get final child's PID from pipe: EOF") ||
		message.includes("container stopped before reporting THREAD_ID")
	);
};

const logPipelineEvent = (event: string, details: Record<string, unknown>) => {
	console.log(
		"[scan-pipeline]",
		JSON.stringify({
			event,
			...details,
		}),
	);
};

const SCAN_JOB_CANCELLED_ERROR_NAME = "ScanJobCancelledError";
const STALE_RUNNING_STDOUT_WINDOW_MS = 10 * 60 * 1000;
const RUNNING_OUTPUT_WITHOUT_END_TURN_LOG_INTERVAL_MS = 5 * 60 * 1000;
const LOOP_TICK_LOG_INTERVAL_MS = 60 * 1000;
const JOB_LOOP_IDLE_SLEEP_MS = 1000;
const lastLoopTickLogAtByJob = new Map<string, number>();

class ScanJobCancelledError extends Error {
	constructor(scanJobId: string) {
		super(`Scan job ${scanJobId} was cancelled`);
		this.name = SCAN_JOB_CANCELLED_ERROR_NAME;
	}
}

const assertScanJobNotCancelled = async (ctx: PipelineContext) => {
	const scanJob = await findScanJobByIdRepo(ctx.scanJobId).catch(() => null);
	if (scanJob && scanJob.status === "canceled") {
		throw new ScanJobCancelledError(ctx.scanJobId);
	}
};

const isScanJobPaused = async (ctx: PipelineContext) => {
	const scanJob = await findScanJobByIdRepo(ctx.scanJobId).catch(() => null);
	return scanJob?.status === "paused";
};

const shouldStopForPausedScanJob = async <TPipelineContext extends PipelineContext>(
	runtime: JobRuntime<TPipelineContext>,
) => {
	if (!(await isScanJobPaused(runtime.ctx))) {
		return false;
	}
	runtime.stopRequested = true;
	logPipelineEvent("loop.paused", {
		scanJobId: runtime.ctx.scanJobId,
		pipelineName: runtime.pipeline.name,
	});
	return true;
};

const SANDBOX_AGENT_DRIVER_TASK_DIR_NAME = "sandbox-agent-driver-tasks";

const normalizeJsonOutput = (rawOutput: string) => {
	const trimmed = rawOutput.trim();
	const fencedJson = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	return fencedJson?.[1]?.trim() || trimmed;
};

const defaultValidateOutput = async <TOutput>(
	stageName: string,
	rawOutput: string,
): Promise<TOutput> => {
	try {
		return JSON.parse(normalizeJsonOutput(rawOutput)) as TOutput;
	} catch (error) {
		throw new Error(
			`Stage ${stageName} returned invalid JSON output: ${getErrorMessage(error)}`,
		);
	}
};

const ensureTaskRuntimeDirectory = async (ctx: StageContext) => {
	const taskDirPath = await ctx.taskDir();
	await fs.mkdir(taskDirPath, { recursive: true });
	if (ctx.laneIndex !== null) {
		await ctx.laneDir();
	}
	return {
		taskDir: taskDirPath,
		taskDirContainer: await ctx.taskDirContainer(),
	};
};

const getTaskRuntimePaths = async (ctx: StageContext) => {
	const taskDir = await ctx.taskDir();
	const runtimeBase = SANDBOX_AGENT_RUNTIME_FILE_NAMES.jsonl.replace(
		/\.jsonl$/i,
		"",
	);
	return {
		taskDir,
		jsonlPath: path.join(taskDir, SANDBOX_AGENT_RUNTIME_FILE_NAMES.jsonl),
		textPath: path.join(taskDir, SANDBOX_AGENT_RUNTIME_FILE_NAMES.text),
		stderrPath: path.join(taskDir, SANDBOX_AGENT_RUNTIME_FILE_NAMES.stderr),
		stdoutPath: path.join(taskDir, SANDBOX_AGENT_RUNTIME_FILE_NAMES.stdout),
		usagePath: path.join(taskDir, SANDBOX_AGENT_RUNTIME_FILE_NAMES.usage),
		statePath: path.join(taskDir, `.${runtimeBase}-state.json`),
		outputPath: path.join(taskDir, "output.json"),
	};
};

const copyPersistentLaneArtifactsToTaskDir = async (ctx: StageContext) => {
	if (!ctx.persistent || ctx.laneIndex === null) {
		return;
	}
	const [laneDir, taskDir] = await Promise.all([ctx.laneDir(), ctx.taskDir()]);
	if (laneDir === taskDir) {
		return;
	}
	const skipEntries = new Set([
		"inputs",
		"parent-session-store",
		"parent-runtime",
		SANDBOX_AGENT_DRIVER_TASK_DIR_NAME,
		"sandbox-agent-driver.pid",
		"sandbox-agent-driver.mjs",
		"sandbox-agent-driver-launch.sh",
		"output.json",
		SANDBOX_AGENT_RUNTIME_FILE_NAMES.jsonl,
		SANDBOX_AGENT_RUNTIME_FILE_NAMES.text,
		SANDBOX_AGENT_RUNTIME_FILE_NAMES.stderr,
		SANDBOX_AGENT_RUNTIME_FILE_NAMES.stdout,
		SANDBOX_AGENT_RUNTIME_FILE_NAMES.usage,
	]);
	const entries = await fs.readdir(laneDir, { withFileTypes: true }).catch(
		() => [],
	);
	await fs.mkdir(taskDir, { recursive: true });
	for (const entry of entries) {
		if (skipEntries.has(entry.name)) {
			continue;
		}
		const fromPath = path.join(laneDir, entry.name);
		const toPath = path.join(taskDir, entry.name);
		await fs.rm(toPath, { recursive: true, force: true }).catch(() => {});
		await fs.cp(fromPath, toPath, { recursive: true, force: true });
		if (entry.name === "session-store") {
			await fs
				.rm(path.join(toPath, ".persist.lock"), {
					recursive: true,
					force: true,
				})
				.catch(() => {});
		}
	}
};

const updateTaskDefault = async (
	taskId: string,
	patch: {
		status?:
			| "pending"
			| "launching"
			| "launched"
			| "starting"
			| "running"
			| "completed"
			| "failed"
			| "exited"
			| "canceled";
		errorMessage?: string;
		exitReason?: "agent_exit" | "leader_exit" | null;
		exitNote?: string | null;
		containerName?: string;
		threadId?: string;
		output?: unknown;
	},
) => {
	const taskPatch = {
		...(patch.containerName ? { containerName: patch.containerName } : {}),
		...(patch.threadId ? { threadId: patch.threadId } : {}),
		...(patch.output !== undefined ? { output: patch.output } : {}),
		...(patch.status
			? {
					status: patch.status,
					errorMessage: patch.errorMessage,
					exitReason: patch.exitReason,
					exitNote: patch.exitNote,
					...(patch.status === "launching" ||
					patch.status === "launched" ||
					patch.status === "starting" ||
					patch.status === "running"
						? {
								startedAt: new Date().toISOString(),
								completedAt: null,
							}
						: {}),
					...(patch.status === "completed" ||
					patch.status === "failed" ||
					patch.status === "exited" ||
					patch.status === "canceled"
						? { completedAt: new Date().toISOString() }
						: {}),
				}
			: {}),
	};
	await updateTaskRepo(taskId, taskPatch);
};

const sleep = async (ms: number) =>
	await new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});

const readFileIfExists = async (filePath: string) =>
	await fs.readFile(filePath, "utf-8").catch(() => "");

const sha1 = (value: string) =>
	crypto.createHash("sha1").update(value).digest("hex");

const statFileIfExists = async (filePath: string) => {
	const stat = await fs.stat(filePath).catch(() => null);
	return stat
		? {
				exists: true,
				size: stat.size,
				mtimeMs: stat.mtimeMs,
				mtimeIso: stat.mtime.toISOString(),
			}
		: { exists: false, size: 0, mtimeMs: null, mtimeIso: null };
};

const summarizeOutputJson = (content: string) => {
	if (!content.trim()) {
		return {
			exists: false,
			validJson: false,
			validEnvelope: false,
			route: null,
			exit: null,
			error: null,
		};
	}
	try {
		const parsed = JSON.parse(content) as Record<string, unknown>;
		return {
			exists: true,
			validJson: true,
			validEnvelope:
				parsed &&
				typeof parsed === "object" &&
				!Array.isArray(parsed) &&
				"route" in parsed &&
				(parsed.route === null || typeof parsed.route === "string") &&
				typeof parsed.exit === "boolean" &&
				"output" in parsed,
			route: typeof parsed.route === "string" ? parsed.route : null,
			exit: typeof parsed.exit === "boolean" ? parsed.exit : null,
			error: null,
		};
	} catch (error) {
		return {
			exists: true,
			validJson: false,
			validEnvelope: false,
			route: null,
			exit: null,
			error: getErrorMessage(error),
		};
	}
};

const summarizeTaskState = (content: string) => {
	if (!content.trim()) {
		return {
			exists: false,
			promptFinished: null,
			endTurnReceived: null,
			completedAt: null,
			eventCount: null,
			lastEventAgeMs: null,
			lastEventSummary: null,
			activeToolCalls: [],
		};
	}
	try {
		const parsed = JSON.parse(content) as Record<string, unknown>;
		return {
			exists: true,
			promptFinished:
				typeof parsed.promptFinished === "boolean"
					? parsed.promptFinished
					: null,
			endTurnReceived:
				typeof parsed.endTurnReceived === "boolean"
					? parsed.endTurnReceived
					: null,
			completedAt:
				typeof parsed.completedAt === "string" && parsed.completedAt.trim()
					? parsed.completedAt
					: null,
			eventCount:
				typeof parsed.eventCount === "number" ? parsed.eventCount : null,
			lastEventAgeMs:
				typeof parsed.lastEventAgeMs === "number"
					? parsed.lastEventAgeMs
					: null,
			lastEventSummary:
				parsed.lastEventSummary && typeof parsed.lastEventSummary === "object"
					? parsed.lastEventSummary
					: null,
			activeToolCalls: Array.isArray(parsed.activeToolCalls)
				? parsed.activeToolCalls
				: [],
		};
	} catch (error) {
		return {
			exists: true,
			promptFinished: null,
			endTurnReceived: null,
			completedAt: null,
			eventCount: null,
			lastEventAgeMs: null,
			lastEventSummary: null,
			activeToolCalls: [],
			error: getErrorMessage(error),
		};
	}
};

const summarizeLastJsonlEvent = (content: string) => {
	const lines = content
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length === 0) {
		return null;
	}
	const lastLine = lines[lines.length - 1] || "";
	try {
		const parsed = JSON.parse(lastLine) as Record<string, unknown>;
		const payload =
			parsed.payload && typeof parsed.payload === "object"
				? (parsed.payload as Record<string, unknown>)
				: {};
		const params =
			payload.params && typeof payload.params === "object"
				? (payload.params as Record<string, unknown>)
				: {};
		const update =
			params.update && typeof params.update === "object"
				? (params.update as Record<string, unknown>)
				: {};
		return {
			lineCount: lines.length,
			eventIndex:
				typeof parsed.eventIndex === "number" ? parsed.eventIndex : null,
			createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : null,
			createdAtIso:
				typeof parsed.createdAt === "number"
					? new Date(parsed.createdAt).toISOString()
					: null,
			sender: typeof parsed.sender === "string" ? parsed.sender : null,
			method: typeof payload.method === "string" ? payload.method : null,
			sessionUpdate:
				typeof update.sessionUpdate === "string" ? update.sessionUpdate : null,
			kind: typeof update.kind === "string" ? update.kind : null,
			status: typeof update.status === "string" ? update.status : null,
			toolCallId:
				typeof update.toolCallId === "string" ? update.toolCallId : null,
		};
	} catch (error) {
		return {
			lineCount: lines.length,
			parseError: getErrorMessage(error),
		};
	}
};

const tailText = (content: string, maxLength = 4000) => {
	if (content.length <= maxLength) {
		return content;
	}
	return `<truncated ${content.length - maxLength} chars>\n${content.slice(-maxLength)}`;
};

const inspectContainerForFailure = async (
	containerName: string | null | undefined,
) => {
	if (!containerName) {
		return null;
	}
	const [inspectResult, logsResult] = await Promise.all([
		execAsync(`docker inspect ${containerName} --format '{{json .State}}'`)
			.then(({ stdout }) => ({
				ok: true,
				state: JSON.parse(stdout.trim() || "{}") as unknown,
			}))
			.catch((error) => ({
				ok: false,
				error: getErrorMessage(error),
			})),
		execAsync(`docker logs --tail 120 ${containerName}`)
			.then(({ stdout, stderr }) => ({
				ok: true,
				stdoutTail: tailText(stdout),
				stderrTail: tailText(stderr),
			}))
			.catch((error) => ({
				ok: false,
				error: getErrorMessage(error),
			})),
	]);
	return {
		containerName,
		inspect: inspectResult,
		logs: logsResult,
	};
};

const buildTaskFailureDiagnostics = async (ctx: StageContext) => {
	const {
		taskDir,
		jsonlPath,
		textPath,
		stderrPath,
		stdoutPath,
		statePath,
		outputPath,
	} = await getTaskRuntimePaths(ctx);
	const [
		task,
		jsonlContent,
		textContent,
		stderrContent,
		stdoutContent,
		stateContent,
		outputContent,
		jsonlStat,
		textStat,
		stderrStat,
		stdoutStat,
		stateStat,
		outputStat,
	] = await Promise.all([
		findTaskByIdRepo(ctx.taskId).catch(() => null),
		readFileIfExists(jsonlPath),
		readFileIfExists(textPath),
		readFileIfExists(stderrPath),
		readFileIfExists(stdoutPath),
		readFileIfExists(statePath),
		readFileIfExists(outputPath),
		statFileIfExists(jsonlPath),
		statFileIfExists(textPath),
		statFileIfExists(stderrPath),
		statFileIfExists(stdoutPath),
		statFileIfExists(statePath),
		statFileIfExists(outputPath),
	]);
	const containerDiagnostics = await inspectContainerForFailure(
		task?.containerName,
	);
	return {
		taskDir,
		containerName: task?.containerName || null,
		threadId: task?.threadId || null,
		runtimeFiles: {
			jsonl: jsonlStat,
			text: textStat,
			stderr: stderrStat,
			stdout: stdoutStat,
			state: stateStat,
			output: outputStat,
		},
		output: summarizeOutputJson(outputContent),
		state: summarizeTaskState(stateContent),
		lastJsonlEvent: summarizeLastJsonlEvent(jsonlContent),
		tails: {
			stderr: tailText(stderrContent),
			stdout: tailText(stdoutContent),
			text: tailText(textContent),
			jsonl: tailText(jsonlContent),
			output: tailText(outputContent),
			state: tailText(stateContent),
		},
		container: containerDiagnostics,
	};
};

const appendTaskFailureDiagnostics = async (
	ctx: StageContext,
	reason: string,
	diagnostics: unknown,
) => {
	const { stderrPath } = await getTaskRuntimePaths(ctx);
	await fs
		.appendFile(
			stderrPath,
			`\n[task-failure-diagnostics] ${new Date().toISOString()} ${JSON.stringify(
				{
					reason,
					diagnostics,
				},
			)}\n`,
			"utf-8",
		)
		.catch(() => {});
};

const readTaskTokenUsage = async (ctx: StageContext) => {
	const { jsonlPath, usagePath } = await getTaskRuntimePaths(ctx);
	const [jsonlContent, promptUsageContent] = await Promise.all([
		readFileIfExists(jsonlPath),
		readFileIfExists(usagePath),
	]);
	const summary = summarizeSandboxAgentTokenUsage(jsonlContent);
	const promptUsage = extractPromptResponseUsage(promptUsageContent);
	const totalTokens = promptUsage?.totalTokens ?? summary?.totalTokens ?? null;
	const cachedReadTokens =
		promptUsage?.cachedReadTokens ?? summary?.cachedReadTokens ?? null;
	return {
		inputTokens: promptUsage?.inputTokens ?? null,
		outputTokens: promptUsage?.outputTokens ?? null,
		thoughtTokens: promptUsage?.thoughtTokens ?? null,
		totalTokens,
		cachedReadTokens,
		cachedWriteTokens: promptUsage?.cachedWriteTokens ?? null,
	};
};

const readPersistentQueueFailureForTask = async (
	task: Awaited<ReturnType<typeof findTaskByIdRepo>>,
	taskDir: string,
) => {
	const lane = await findStageLaneRuntimeByActiveTaskIdRepo(task.taskId).catch(
		() => null,
	);
	if (!lane) {
		return null;
	}
	const stageRoot = path.dirname(path.dirname(taskDir));
	const taskQueueDir = path.join(
		stageRoot,
		"lanes",
		`lane-${lane.laneIndex}`,
		SANDBOX_AGENT_DRIVER_TASK_DIR_NAME,
	);
	const entries = await fs.readdir(taskQueueDir).catch(() => []);
	for (const entry of entries.filter((value) =>
		value.endsWith(".failed.reason.json"),
	)) {
		const reasonPath = path.join(taskQueueDir, entry);
		const content = await readFileIfExists(reasonPath);
		if (!content.trim()) {
			continue;
		}
		try {
			const parsed = JSON.parse(content) as Record<string, unknown>;
			if (parsed.taskId !== task.taskId) {
				continue;
			}
			return {
				laneIndex: lane.laneIndex,
				taskQueueDir,
				reasonPath,
				queueEntry:
					typeof parsed.queueEntry === "string" ? parsed.queueEntry : null,
				runningPath:
					typeof parsed.runningPath === "string" ? parsed.runningPath : null,
				failedPath:
					typeof parsed.failedPath === "string" ? parsed.failedPath : null,
				rawBytes: typeof parsed.rawBytes === "number" ? parsed.rawBytes : null,
				error: typeof parsed.error === "string" ? parsed.error : null,
				failedAt: typeof parsed.failedAt === "string" ? parsed.failedAt : null,
			};
		} catch (error) {
			logPipelineEvent("stage.queue_failure_marker_invalid", {
				scanJobId: task.scanJobId,
				stageName: task.stageName,
				taskId: task.taskId,
				reasonPath,
				errorMessage: getErrorMessage(error),
			});
		}
	}
	return null;
};

const extractDriverExitCode = (stderrContent: string) => {
	const match = stderrContent.match(/\[sandbox-agent-driver\] exit_code=(\d+)/);
	return match ? Number.parseInt(match[1] || "", 10) : null;
};

const hasDriverCompletedWithoutOutput = (stderrContent: string) =>
	stderrContent.includes("[sandbox-agent-driver] prompt completed without output");

const extractThreadIdFromStdout = (stdoutContent: string) => {
	const threadLine = stdoutContent
		.split("\n")
		.map((line) => line.trim())
		.reverse()
		.find((line) => line.startsWith("THREAD_ID:"));
	const threadId = threadLine?.slice("THREAD_ID:".length).trim();
	return threadId || null;
};

const cleanupTaskContainer = async (taskId: string) => {
	const task = await findTaskByIdRepo(taskId).catch(() => null);
	if (!task?.containerName) {
		return;
	}
	await removeContainer(task.containerName).catch(() => {});
};

const stopReusableSandboxAgentForTask = async (taskId: string) => {
	const task = await findTaskByIdRepo(taskId).catch(() => null);
	if (!task?.containerName) {
		return;
	}
	await stopSandboxAgentServerInContainer({
		containerName: task.containerName,
	});
};

const shouldRemoveContainerAfterTask = (
	stage: Pick<StageDefinition<PipelineContext, unknown, unknown>, "reuseContainer">,
) => !(stage.reuseContainer ?? true);

const cleanupFailedTaskRuntime = async (taskId: string) => {
	const [task, lane] = await Promise.all([
		findTaskByIdRepo(taskId).catch(() => null),
		findStageLaneRuntimeByActiveTaskIdRepo(taskId).catch(() => null),
	]);
	const containerNames = new Set<string>();
	if (task?.containerName) {
		containerNames.add(task.containerName);
	}
	if (lane?.containerName) {
		containerNames.add(lane.containerName);
	}
	await Promise.all(
		[...containerNames].map((containerName) =>
			removeContainer(containerName).catch(() => {}),
		),
	);
	if (lane) {
		await resetStageLaneRuntimeForExitRepo({ taskId }).catch(() => {});
	}
};

const markTaskExited = async (input: {
	taskId: string;
	exitReason: "agent_exit" | "leader_exit";
	exitNote?: string | null;
}) =>
	await transitionTaskStatusRepo({
		taskId: input.taskId,
		from: ["pending", "launching", "launched", "starting", "running"],
		to: "exited",
		patch: {
			exitReason: input.exitReason,
			exitNote: input.exitNote ?? null,
			errorMessage: null,
		},
	}).catch(() => null);

const isStageGroupLeaderTask = async (
	task: {
		taskId: string;
		stageName: string;
		stageGroupInstanceId?: string | null;
	} | null,
) => {
	if (!task?.stageGroupInstanceId) {
		return false;
	}
	const group = await findStageGroupInstanceByIdRepo(task.stageGroupInstanceId);
	return (
		Boolean(group) &&
		group?.status !== "exited" &&
		group?.leaderTaskId === task.taskId &&
		group?.leaderStageName === task.stageName
	);
};

const cleanupStageGroupForLeaderExit = async <
	TPipelineContext extends PipelineContext,
>(
	leaderTaskId: string,
	runtime?: JobRuntime<TPipelineContext>,
) => {
	const leaderTask = await findTaskByIdRepo(leaderTaskId).catch(() => null);
	const groupInstanceId = leaderTask?.stageGroupInstanceId;
	if (!groupInstanceId) {
		return;
	}
	const group = await findStageGroupInstanceByIdRepo(groupInstanceId);
	if (
		!group ||
		group.leaderTaskId !== leaderTaskId ||
		leaderTask.stageName !== group.leaderStageName ||
		group.status === "exited"
	) {
		return;
	}
	await markStageGroupInstanceExitedRepo(groupInstanceId).catch(() => null);
	await cleanupStageGroupQueues(runtime, groupInstanceId);
	const memberships = await listStageGroupLaneMembershipsRepo(
		groupInstanceId,
	).catch(() => []);
	const groupTasks = await listTasksByScanJobIdRepo(group.scanJobId).catch(
		() => [],
	);
	for (const membership of memberships) {
		if (membership.role === "leader") {
			continue;
		}
		const lane = await findStageLaneRuntimeRepo({
			scanJobId: group.scanJobId,
			stageName: membership.stageName,
			laneIndex: membership.laneIndex,
		}).catch(() => null);
		if (lane?.containerName) {
			await removeContainer(lane.containerName).catch(() => {});
		}
		await resetStageLaneRuntimeByLaneForExitRepo({
			scanJobId: group.scanJobId,
			stageName: membership.stageName,
			laneIndex: membership.laneIndex,
			taskId: lane?.activeTaskId ?? null,
		}).catch(() => {});
	}
	for (const task of groupTasks) {
		if (
			task.stageGroupInstanceId !== groupInstanceId ||
			task.stageName === group.leaderStageName ||
			(task.status !== "pending" &&
				task.status !== "launching" &&
				task.status !== "launched" &&
				task.status !== "starting" &&
				task.status !== "running")
		) {
			continue;
		}
		if (task.containerName) {
			await removeContainer(task.containerName).catch(() => {});
		}
		await markTaskExited({
			taskId: task.taskId,
			exitReason: "leader_exit",
			exitNote: `跟随 leader task ${leaderTaskId} exit`,
		});
	}
};

const cleanupPersistentLaneForTask = async <
	TPipelineContext extends PipelineContext,
>(
	taskId: string,
	runtime?: JobRuntime<TPipelineContext>,
) => {
	await cleanupStageGroupForLeaderExit(taskId, runtime).catch(() => {});
	const lane = await findStageLaneRuntimeByActiveTaskIdRepo(taskId);
	if (!lane) {
		return;
	}
	if (lane.containerName) {
		await removeContainer(lane.containerName).catch(() => {});
	}
	await resetStageLaneRuntimeForExitRepo({ taskId }).catch(() => {});
};

const releasePersistentLaneForTask = async (taskId: string) => {
	await releaseStageLaneRuntimeRepo(taskId).catch(() => {});
};

const cleanupTerminalJobRuntime = async (scanJobId: string) => {
	const scanJob = await findScanJobByIdRepo(scanJobId).catch(() => null);
	if (scanJob?.status !== "finished" && scanJob?.status !== "failed") {
		return {
			cleaned: false,
			reason: "job_not_terminal",
			containerCount: 0,
		};
	}
	const openCount = await countOpenTasksByScanJobIdRepo(scanJobId).catch(
		() => null,
	);
	if (openCount !== 0) {
		return {
			cleaned: false,
			reason: "open_tasks_present",
			containerCount: 0,
		};
	}

	const [tasks, lanes] = await Promise.all([
		listTasksByScanJobIdRepo(scanJobId).catch(() => []),
		listStageLaneRuntimesByScanJobIdRepo(scanJobId).catch(() => []),
	]);
	const containerNames = new Set<string>();
	for (const task of tasks) {
		if (task.containerName) {
			containerNames.add(task.containerName);
		}
	}
	for (const lane of lanes) {
		if (lane.containerName) {
			containerNames.add(lane.containerName);
		}
	}

	await Promise.all(
		[...containerNames].map((containerName) =>
			removeContainer(containerName).catch(() => {}),
		),
	);
	await resetStageLaneRuntimesByScanJobIdRepo(scanJobId).catch(() => []);

	return {
		cleaned: true,
		reason: null,
		containerCount: containerNames.size,
	};
};

const isOpenTaskStatus = (status: string) =>
	status === "pending" ||
	status === "launching" ||
	status === "launched" ||
	status === "starting" ||
	status === "running";

const cleanupStageGroupQueues = async <
	TPipelineContext extends PipelineContext,
>(
	runtime: JobRuntime<TPipelineContext> | null | undefined,
	groupInstanceId: string,
) => {
	if (!runtime) {
		return;
	}
	let removedQueues = 0;
	for (const stage of runtime.pipeline.stages) {
		if (!stage.queue) {
			continue;
		}
		await stage.queue.obliterateGroup(groupInstanceId).catch(() => {});
		removedQueues += 1;
	}
	logPipelineEvent("stage.group_queues_deleted", {
		scanJobId: runtime.ctx.scanJobId,
		pipelineName: runtime.pipeline.name,
		groupInstanceId,
		queueCount: removedQueues,
	});
};

const listReservedLaneIndexesForStage = async (input: {
	scanJobId: string;
	stageName: string;
	allowedGroupInstanceId?: string | null;
	runtime?: JobRuntime<PipelineContext>;
}) => {
	const memberships = await listActiveStageGroupLaneMembershipsForStageRepo({
		scanJobId: input.scanJobId,
		stageName: input.stageName,
	}).catch(() => []);
	if (memberships.length === 0) {
		return [];
	}
	const tasks = await listTasksByScanJobIdRepo(input.scanJobId).catch(() => []);
	const staleGroupInstanceIds = new Set<string>();
	for (const membership of memberships) {
		if (staleGroupInstanceIds.has(membership.groupInstanceId)) {
			continue;
		}
		const hasOpenTask = tasks.some(
			(task) =>
				task.stageGroupInstanceId === membership.groupInstanceId &&
				isOpenTaskStatus(task.status),
		);
		if (hasOpenTask) {
			continue;
		}
		staleGroupInstanceIds.add(membership.groupInstanceId);
		const group = await findStageGroupInstanceByIdRepo(
			membership.groupInstanceId,
		).catch(() => null);
		await markStageGroupInstanceExitedRepo(membership.groupInstanceId).catch(
			() => null,
		);
		await cleanupStageGroupQueues(input.runtime, membership.groupInstanceId);
		logPipelineEvent("stage.group_exited", {
			scanJobId: input.scanJobId,
			groupName: group?.groupName ?? null,
			groupInstanceId: membership.groupInstanceId,
			leaderStageName: group?.leaderStageName ?? null,
			leaderLaneIndex: group?.leaderLaneIndex ?? null,
			reason: "stale_active_group_without_open_tasks",
		});
	}
	return memberships
		.filter(
			(membership) =>
				!staleGroupInstanceIds.has(membership.groupInstanceId) &&
				(!input.allowedGroupInstanceId ||
					membership.groupInstanceId !== input.allowedGroupInstanceId),
		)
		.map((membership) => membership.laneIndex);
};

const maybeMarkTaskStageGroupExited = async <
	TPipelineContext extends PipelineContext,
>(
	taskId: string,
	runtime?: JobRuntime<TPipelineContext>,
) => {
	const task = await findTaskByIdRepo(taskId).catch(() => null);
	const groupInstanceId = task?.stageGroupInstanceId;
	if (!task || !groupInstanceId) {
		return;
	}
	const group = await findStageGroupInstanceByIdRepo(groupInstanceId).catch(
		() => null,
	);
	if (!group || group.status !== "active") {
		return;
	}
	const groupTasks = await listTasksByScanJobIdRepo(group.scanJobId).catch(
		() => [],
	);
	const hasOpenTask = groupTasks.some(
		(groupTask) =>
			groupTask.stageGroupInstanceId === groupInstanceId &&
			isOpenTaskStatus(groupTask.status),
	);
	if (hasOpenTask) {
		return;
	}
	await markStageGroupInstanceExitedRepo(groupInstanceId).catch(() => null);
	await cleanupStageGroupQueues(runtime, groupInstanceId);
	logPipelineEvent("stage.group_exited", {
		scanJobId: group.scanJobId,
		groupName: group.groupName,
		groupInstanceId,
		leaderStageName: group.leaderStageName,
		leaderLaneIndex: group.leaderLaneIndex,
	});
};

const isContainerAlive = async (
	containerName: string | null | undefined,
): Promise<boolean> => {
	if (!containerName) {
		return false;
	}

	try {
		const { stdout } = await execAsync(
			`docker inspect -f '{{.State.Running}}' ${containerName}`,
		);
		return stdout.trim() === "true";
	} catch {
		return false;
	}
};

const createStageContextForTask = async <
	TPipelineContext extends PipelineContext,
>(
	runtime: JobRuntime<TPipelineContext>,
	task: {
		stageName: string;
		taskId: string;
		name: string;
		input?: unknown;
		containerIndex?: number | null;
		runtimeMode?: "new_session" | "fork_session" | null;
		forkedFromTaskId?: string | null;
		forkedFromThreadId?: string | null;
	},
) => {
	const scanJobRef = hasPipelineScanJobContext(runtime.ctx)
		? runtime.ctx.scanJob
		: null;
	const laneRuntime = await findStageLaneRuntimeByActiveTaskIdRepo(
		task.taskId,
	).catch(() => null);
	const groupedPersistent = Boolean(
		laneRuntime && getStageGroup(runtime.pipeline, task.stageName),
	);
	const stageDefinition = runtime.stageStates.get(task.stageName)?.stage;
	return createStageContext({
		base: runtime.ctx,
		stageName: task.stageName,
		scanJob: scanJobRef || {
			scanJobId: runtime.ctx.scanJobId,
			applicationId: null,
			composeId: null,
		},
		taskId: task.taskId,
		taskName: task.name || resolveStageTaskName(task.stageName, task.input),
		persistent: Boolean(stageDefinition?.persistent ?? Boolean(laneRuntime)),
		reuseContainer: stageDefinition?.reuseContainer ?? true,
		groupedPersistent,
		allowAgentExit: task.stageName === SCAN_STAGE_IDS.analysis,
		containerIndex: laneRuntime?.laneIndex ?? task.containerIndex ?? null,
		laneIndex: laneRuntime?.laneIndex ?? null,
		laneThreadId: laneRuntime?.threadId ?? null,
		sessionMode: task.runtimeMode === "fork_session" ? "fork" : "new",
		parentSessionId: task.forkedFromThreadId ?? null,
		parentTaskId: task.forkedFromTaskId ?? null,
		routeOutputSchemas: getStageRouteOutputSchemas(
			runtime.pipeline,
			task.stageName,
		),
	});
};

const inspectHalfStartedRunningTask = async <
	TPipelineContext extends PipelineContext,
>(
	runtime: JobRuntime<TPipelineContext>,
	task: Awaited<ReturnType<typeof findTaskByIdRepo>>,
) => {
	if (task.status !== "running") {
		return null;
	}

	const stageCtx = await createStageContextForTask(runtime, task);
	const {
		taskDir,
		jsonlPath,
		textPath,
		stderrPath,
		stdoutPath,
		statePath,
		outputPath,
	} = await getTaskRuntimePaths(stageCtx);
	const [
		jsonlContent,
		textContent,
		stderrContent,
		stdoutContent,
		stateContent,
		outputContent,
		outputStat,
	] = await Promise.all([
		readFileIfExists(jsonlPath),
		readFileIfExists(textPath),
		readFileIfExists(stderrPath),
		readFileIfExists(stdoutPath),
		readFileIfExists(statePath),
		readFileIfExists(outputPath),
		statFileIfExists(outputPath),
	]);

	const now = Date.now();
	const hasEndTurn =
		hasEndTurnInJsonlContent(jsonlContent) ||
		summarizeTaskState(stateContent).endTurnReceived === true;
	const outputSummary = summarizeOutputJson(outputContent);
	const stateSummary = summarizeTaskState(stateContent);
	const lastJsonlEvent = summarizeLastJsonlEvent(jsonlContent);
	const diagnostics = {
		jsonlBytes: Buffer.byteLength(jsonlContent),
		textBytes: Buffer.byteLength(textContent),
		stderrBytes: Buffer.byteLength(stderrContent),
		stdoutBytes: Buffer.byteLength(stdoutContent),
		stateBytes: Buffer.byteLength(stateContent),
		outputBytes: Buffer.byteLength(outputContent),
		output: {
			...outputSummary,
			mtimeIso: outputStat.mtimeIso,
			size: outputStat.size,
		},
		state: stateSummary,
		lastJsonlEvent,
		hasEndTurn,
		threadId: task.threadId || null,
		containerName: task.containerName || null,
	};
	const queueFailure = await readPersistentQueueFailureForTask(task, taskDir);
	if (queueFailure) {
		return {
			reason: "queue_task_read_failed",
			diagnostics: {
				...diagnostics,
				queueFailure,
			},
		} as const;
	}
	const previousSnapshot = runtime.runningStdoutSnapshots.get(task.taskId);
	const diagnosticKey = outputSummary.exists
		? sha1(
				JSON.stringify({
					outputMtimeMs: outputStat.mtimeMs,
					outputSize: outputStat.size,
					outputValidEnvelope: outputSummary.validEnvelope,
					outputRoute: outputSummary.route,
					hasEndTurn,
					activeToolCallIds: stateSummary.activeToolCalls
						.map((item) =>
							item && typeof item === "object" && "toolCallId" in item
								? String((item as Record<string, unknown>).toolCallId)
								: "",
						)
						.filter(Boolean),
				}),
			)
		: previousSnapshot?.lastDiagnosticKey;
	const runtimeOutputHash = sha1(
		[
			`jsonl:${jsonlContent}`,
			`text:${textContent}`,
			`stderr:${stderrContent}`,
			`stdout:${stdoutContent}`,
			`state:${stateContent}`,
			`output:${outputContent}`,
		].join("\n"),
	);
	if (!previousSnapshot || previousSnapshot.hash !== runtimeOutputHash) {
		const lastRunningOutputWithoutEndTurnLoggedAt =
			previousSnapshot?.lastRunningOutputWithoutEndTurnLoggedAt;
		const runningOutputWithoutEndTurnLogIntervalElapsed =
			!lastRunningOutputWithoutEndTurnLoggedAt ||
			now - lastRunningOutputWithoutEndTurnLoggedAt >=
				RUNNING_OUTPUT_WITHOUT_END_TURN_LOG_INTERVAL_MS;
		const shouldLogRunningOutputWithoutEndTurn =
			outputSummary.exists &&
			!hasEndTurn &&
			runningOutputWithoutEndTurnLogIntervalElapsed;
		runtime.runningStdoutSnapshots.set(task.taskId, {
			hash: runtimeOutputHash,
			lastChangedAt: now,
			lastDiagnosticKey: diagnosticKey,
			lastRunningOutputWithoutEndTurnDiagnosticKey:
				shouldLogRunningOutputWithoutEndTurn
					? diagnosticKey
					: previousSnapshot?.lastRunningOutputWithoutEndTurnDiagnosticKey,
			lastRunningOutputWithoutEndTurnLoggedAt:
				shouldLogRunningOutputWithoutEndTurn
					? now
					: previousSnapshot?.lastRunningOutputWithoutEndTurnLoggedAt,
		});
		if (shouldLogRunningOutputWithoutEndTurn) {
			logPipelineEvent("stage.running_output_without_end_turn", {
				scanJobId: runtime.ctx.scanJobId,
				pipelineName: runtime.pipeline.name,
				stageName: task.stageName,
				taskId: task.taskId,
				taskName: task.name,
				diagnostics,
			});
		}
		return null;
	}

	if (now - previousSnapshot.lastChangedAt < STALE_RUNNING_STDOUT_WINDOW_MS) {
		return null;
	}

	return {
		reason: task.threadId
			? "silent_stuck_after_start"
			: "silent_stuck_before_start",
		diagnostics: {
			...diagnostics,
			unchangedForMs: now - previousSnapshot.lastChangedAt,
			staleWindowMs: STALE_RUNNING_STDOUT_WINDOW_MS,
		},
	} as const;
};

const failSilentStuckTask = async <TPipelineContext extends PipelineContext>(
	runtime: JobRuntime<TPipelineContext>,
	task: Awaited<ReturnType<typeof findTaskByIdRepo>>,
	reason: string,
	diagnostics?: Record<string, unknown>,
	stageCtx?: StageContext,
) => {
	const currentTask = await findTaskByIdRepo(task.taskId).catch(() => null);
	if (!currentTask || currentTask.status !== "running") {
		logPipelineEvent("stage.stale_failure_ignored", {
			scanJobId: runtime.ctx.scanJobId,
			pipelineName: runtime.pipeline.name,
			stageName: task.stageName,
			taskId: task.taskId,
			taskName: task.name,
			currentStatus: currentTask?.status,
			errorMessage: `Task became silently stuck: ${reason}`,
		});
		return;
	}

	const failureDiagnostics = stageCtx
		? await buildTaskFailureDiagnostics(stageCtx)
				.then((runtimeDiagnostics) => ({
					stuckDetection: diagnostics || {},
					runtime: runtimeDiagnostics,
				}))
				.catch((diagnosticError) => ({
					stuckDetection: diagnostics || {},
					error: `Unable to collect task failure diagnostics: ${getErrorMessage(
						diagnosticError,
					)}`,
				}))
		: diagnostics;
	if (stageCtx) {
		await appendTaskFailureDiagnostics(
			stageCtx,
			reason,
			failureDiagnostics || {},
		).catch(() => {});
	}
	runtime.runningStdoutSnapshots.delete(task.taskId);
	await updateTaskRepo(task.taskId, {
		status: "failed",
		errorMessage: `Task became silently stuck: ${reason}`,
		completedAt: new Date().toISOString(),
	});
	await cleanupFailedTaskRuntime(task.taskId);
	logPipelineEvent("stage.silent_stuck_failed", {
		scanJobId: runtime.ctx.scanJobId,
		pipelineName: runtime.pipeline.name,
		stageName: task.stageName,
		taskId: task.taskId,
		taskName: task.name,
		reason,
		...(failureDiagnostics ? { diagnostics: failureDiagnostics } : {}),
	});
	logPipelineEvent("loop.task_failed", {
		scanJobId: runtime.ctx.scanJobId,
		pipelineName: runtime.pipeline.name,
		stageName: task.stageName,
		taskId: task.taskId,
		taskName: task.name,
		errorMessage: `Task became silently stuck: ${reason}`,
	});
	await maybeMarkTaskStageGroupExited(task.taskId, runtime);
	await refreshPipelineState(runtime.ctx).catch(() => {});
	runtime.wakeSignal.notify();
};

type ScanJobLike = {
	scanJobId: string;
	applicationId: string | null;
	composeId: string | null;
};

const resolveStageScanJob = (
	input: Record<string, unknown> | null | undefined,
	ctx: PipelineContext,
): ScanJobLike => {
	const record = input || {};
	const direct = record.scanJob as ScanJobLike | undefined;
	if (direct?.scanJobId) {
		return direct;
	}

	const candidateScanJob = (
		record.candidate as { scanJob?: ScanJobLike } | undefined
	)?.scanJob;
	if (candidateScanJob?.scanJobId) {
		return candidateScanJob;
	}

	const analysisResultScanJob = (
		record.analysisResult as { scanJob?: ScanJobLike } | undefined
	)?.scanJob;
	if (analysisResultScanJob?.scanJobId) {
		return analysisResultScanJob;
	}

	const pipelineScanJob = (ctx as PipelineScanJobContext).scanJob;
	if (pipelineScanJob?.scanJobId) {
		return {
			scanJobId: pipelineScanJob.scanJobId,
			applicationId: pipelineScanJob.applicationId,
			composeId: pipelineScanJob.composeId,
		};
	}

	throw new Error("Unable to resolve scanJob from stage input");
};

const getStageConcurrencyLimit = async <
	TPipelineContext extends PipelineContext,
	TInput,
	TOutput,
>(
	stage: StageDefinition<TPipelineContext, TInput, TOutput, StageContext>,
	ctx: TPipelineContext,
) =>
	isFanoutStage(stage)
		? Math.max(1, (await stage.getDesiredConcurrency?.(ctx)) || 1)
		: 1;

const isRuntimeStageActive = async <TPipelineContext extends PipelineContext>(
	runtime: JobRuntime<TPipelineContext>,
	stageName: string,
) => {
	const scanJob = await findScanJobByIdRepo(runtime.ctx.scanJobId).catch(
		() => null,
	);
	if (!scanJob) {
		return true;
	}
	const disabledStages = buildEffectiveDisabledStageSet({
		settings: scanJob.scanRuntimeSettings,
		stageNames: runtime.pipeline.stages.map((stage) => stage.id),
		edges: runtime.pipeline.edges.map((edge) => ({
			source: edge.from.id,
			target: edge.to.id,
		})),
		rootStageName: runtime.pipeline.stages[0]?.id,
	});
	return !disabledStages.has(stageName);
};

const validateSelectedDownstreamOutput = <
	TPipelineContext extends PipelineContext,
>(
	runtime: JobRuntime<TPipelineContext>,
	stageName: string,
	stageOutput: unknown,
	routeKey?: string | null,
) => {
	const downstreamEdges = getDownstreamEdges(runtime.pipeline, stageName);
	if (!downstreamEdges.some((edge) => edge.route)) {
		return;
	}
	const routedEdges = downstreamEdges.filter((edge) => edge.route);
	if (routeKey == null) {
		throw new Error(`Stage ${stageName} output.json route is required`);
	}
	const selected = routedEdges.find((edge) => edge.route?.key === routeKey);
	if (!selected) {
		throw new Error(`Invalid route key ${routeKey} for stage ${stageName}`);
	}
	if (selected.outputSchema) {
		selected.outputSchema.parse(stageOutput);
	}
};

const resolveStageTaskId = (
	stageName: string,
	ctx: PipelineContext,
	input: unknown,
	polledTaskId?: string,
) => {
	if (polledTaskId) {
		return polledTaskId;
	}
	const inputTaskId =
		input && typeof input === "object" && "taskId" in input
			? (input as { taskId?: unknown }).taskId
			: null;
	if (typeof inputTaskId === "string" && inputTaskId.length > 0) {
		return inputTaskId;
	}

	const pipelineScanJob = (ctx as PipelineScanJobContext).scanJob;
	if (pipelineScanJob?.scanJobId) {
		if (
			stageName === SCAN_STAGE_IDS.repositoryScan ||
			stageName === SCAN_STAGE_IDS.deltaScope
		) {
			return pipelineScanJob.repositoryTaskId || pipelineScanJob.scanJobId;
		}
		return pipelineScanJob.scanJobId;
	}

	throw new Error(`Unable to resolve taskId for stage ${stageName}`);
};

const createTaskStageContext = <
	TPipelineContext extends PipelineContext,
	TInput,
	TOutput,
	TStageContext extends StageContext,
>(
	stage: StageDefinition<TPipelineContext, TInput, TOutput, TStageContext>,
	ctx: TPipelineContext,
	input: TInput,
	taskIdOverride?: string,
	taskRuntime?: {
		runtimeMode?: "new_session" | "fork_session" | null;
		forkedFromTaskId?: string | null;
		forkedFromThreadId?: string | null;
		laneRuntime?: StageLaneRuntime | null;
		containerIndex?: number | null;
		routeOutputSchemas?: StageContext["routeOutputSchemas"];
		taskName?: string | null;
		groupedPersistent?: boolean;
		allowAgentExit?: boolean;
	} | null,
) => {
	const taskId = resolveStageTaskId(stage.id, ctx, input, taskIdOverride);
	const scanJob = resolveStageScanJob(
		(input as Record<string, unknown> | null | undefined) || undefined,
		ctx,
	);
	const taskName =
		taskRuntime?.taskName || resolveStageTaskName(stage.id, input);
	const stageCtx = createStageContext({
		base: ctx,
		stageName: stage.id,
		scanJob,
		taskId,
		taskName,
		routeOutputSchemas: taskRuntime?.routeOutputSchemas,
		persistent: stage.persistent ?? true,
		reuseContainer: stage.reuseContainer ?? true,
		nullableOutput: stage.nullableOutput ?? false,
		groupedPersistent: taskRuntime?.groupedPersistent ?? false,
		allowAgentExit:
			taskRuntime?.allowAgentExit ?? stage.id === SCAN_STAGE_IDS.analysis,
		containerIndex:
			taskRuntime?.containerIndex ?? taskRuntime?.laneRuntime?.laneIndex ?? null,
		laneIndex: taskRuntime?.laneRuntime?.laneIndex ?? null,
		laneThreadId: taskRuntime?.laneRuntime?.threadId ?? null,
		sessionMode: taskRuntime?.laneRuntime?.threadId
			? "new"
			: taskRuntime?.runtimeMode === "fork_session"
				? "fork"
				: "new",
		parentSessionId: taskRuntime?.forkedFromThreadId ?? null,
		parentTaskId: taskRuntime?.forkedFromTaskId ?? null,
	}) as unknown as TStageContext;
	return {
		taskId,
		scanJob,
		taskName,
		stageCtx,
	};
};

type OutputEnvelope = {
	route: string | null;
	exit: boolean;
	output: unknown;
};

const isOutputEnvelope = (value: unknown): value is OutputEnvelope => {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const record = value as Record<string, unknown>;
	return (
		"route" in record &&
		(record.route === null || typeof record.route === "string") &&
		typeof record.exit === "boolean" &&
		"output" in record
	);
};

const resolveStageRawOutput = async (ctx: StageContext) => {
	const { jsonlPath, textPath, stderrPath, stdoutPath, statePath, outputPath } =
		await getTaskRuntimePaths(ctx);
	const [
		jsonlContent,
		textContent,
		stderrContent,
		stdoutContent,
		stateContent,
		outputContent,
	] = await Promise.all([
		readFileIfExists(jsonlPath),
		readFileIfExists(textPath),
		readFileIfExists(stderrPath),
		readFileIfExists(stdoutPath),
		readFileIfExists(statePath),
		readFileIfExists(outputPath),
	]);
	const progressSignature = sha1(
		[
			jsonlContent,
			textContent,
			stderrContent,
			stdoutContent,
			stateContent,
			outputContent,
		].join("\n"),
	);
	const hasAgentOutput =
		jsonlContent.trim().length > 0 || textContent.trim().length > 0;
	const stateSummary = summarizeTaskState(stateContent);
	if (!stateSummary.completedAt) {
		return {
			rawOutput: null,
			stderrContent,
			progressSignature,
			hasAgentOutput,
			hasExitSignal: false,
			routeKey: null,
		};
	}
	if (!outputContent.trim()) {
		throw new Error("Sandbox agent prompt completed without output.json");
	}
	if (outputContent.trim()) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(outputContent);
		} catch (error) {
			throw new Error(
				`Task output.json is invalid JSON: ${getErrorMessage(error)}`,
			);
		}
		if (!isOutputEnvelope(parsed)) {
			throw new Error(
				"Task output.json must be an object with route, exit, and output fields",
			);
		}
		if (!ctx.routeOutputSchemas?.length && parsed.route !== null) {
			throw new Error(
				"Task output.json route must be null for non-routed stages",
			);
		}
		return {
			rawOutput: JSON.stringify(parsed.output, null, 2),
			stderrContent,
			progressSignature,
			hasAgentOutput,
			hasExitSignal: ctx.allowAgentExit ? parsed.exit : false,
			routeKey: parsed.route,
		};
	}

	return {
		rawOutput: null,
		stderrContent,
		progressSignature,
		hasAgentOutput,
		hasExitSignal: false,
		routeKey: null,
	};
};

type StageLifecycleSuccess<TOutput, TStageContext extends StageContext> = {
	taskId: string;
	taskName: string;
	stageCtx: TStageContext;
	output: TOutput;
	rawOutput: string;
};

const isCandidateProducerStage = (stageId: string) =>
	(CANDIDATE_PRODUCER_STAGE_NAMES as readonly string[]).includes(stageId);

const prepareStageSuccess = async <
	TPipelineContext extends PipelineContext,
	TInput,
	TOutput,
	TStageContext extends StageContext,
>(
	stage: StageDefinition<TPipelineContext, TInput, TOutput, TStageContext>,
	_ctx: TPipelineContext,
	stageCtx: TStageContext,
	input: TInput,
	rawOutput: string,
) => {
	const currentTask = await findTaskByIdRepo(stageCtx.taskId).catch(() => null);
	if (
		currentTask &&
		currentTask.status !== "launching" &&
		currentTask.status !== "starting" &&
		currentTask.status !== "running"
	) {
		logPipelineEvent("stage.stale_completion_ignored", {
			scanJobId: stageCtx.scanJobId,
			stageName: stage.id,
			taskId: stageCtx.taskId,
			taskName: stageCtx.taskName,
			currentStatus: currentTask.status,
		});
		throw new Error(
			`Task ${stageCtx.taskId} is no longer running; ignoring stale completion`,
		);
	}
	await assertScanJobNotCancelled(stageCtx);
	const output = stage.validateOutput
		? stage.nullableOutput && rawOutput.trim() === "null"
			? (null as TOutput)
			: await stage.validateOutput(stageCtx, input, rawOutput)
		: await defaultValidateOutput<TOutput>(stage.id, rawOutput);
	await updateTaskDefault(stageCtx.taskId, { output });
	if (isCandidateProducerStage(stage.id)) {
		await syncVulnerabilityCandidatesFromProducerTask(stageCtx.taskId);
	}
	await stage.onSuccess?.(stageCtx, input, output);
	return output;
};

const persistTerminalSuccess = async <
	TPipelineContext extends PipelineContext,
	TInput,
	TOutput,
	TStageContext extends StageContext,
>(
	stage: StageDefinition<TPipelineContext, TInput, TOutput, TStageContext>,
	_ctx: TPipelineContext,
	stageCtx: TStageContext,
	rawOutput: string,
	options?: {
		exitLane?: boolean;
		exitReason?: "agent_exit";
		runtime?: JobRuntime<TPipelineContext>;
	},
) => {
	const persistStartedAt = Date.now();
	const logPersistTiming = (
		step: string,
		startedAt: number,
		extra: Record<string, unknown> = {},
	) => {
		logPipelineEvent("stage.persist_success_timing", {
			scanJobId: stageCtx.scanJobId,
			stageName: stage.id,
			taskId: stageCtx.taskId,
			taskName: stageCtx.taskName,
			step,
			elapsedMs: Date.now() - startedAt,
			totalElapsedMs: Date.now() - persistStartedAt,
			...extra,
		});
	};
	let stepStartedAt = Date.now();
	const currentTask = await findTaskByIdRepo(stageCtx.taskId).catch(() => null);
	logPersistTiming("find_current_task", stepStartedAt);
	if (
		currentTask &&
		currentTask.status !== "launching" &&
		currentTask.status !== "starting" &&
		currentTask.status !== "running"
	) {
		logPipelineEvent("stage.stale_completion_ignored", {
			scanJobId: stageCtx.scanJobId,
			stageName: stage.id,
			taskId: stageCtx.taskId,
			taskName: stageCtx.taskName,
			currentStatus: currentTask.status,
		});
		return false;
	}
	stepStartedAt = Date.now();
	const usagePatch = await readTaskTokenUsage(stageCtx).catch(() => ({
		inputTokens: null,
		outputTokens: null,
		thoughtTokens: null,
		totalTokens: null,
		cachedReadTokens: null,
		cachedWriteTokens: null,
	}));
	logPersistTiming("read_token_usage", stepStartedAt);
	stepStartedAt = Date.now();
	const shouldMarkTaskExited =
		Boolean(options?.exitReason) && (await isStageGroupLeaderTask(currentTask));
	logPersistTiming("check_group_leader_exit", stepStartedAt, {
		shouldMarkTaskExited,
	});
	stepStartedAt = Date.now();
	const updated = await transitionTaskStatusRepo({
		taskId: stageCtx.taskId,
		from: ["launching", "starting", "running"],
		to: shouldMarkTaskExited ? "exited" : "completed",
		patch: options?.exitReason
			? {
					exitReason: options.exitReason,
					exitNote: shouldMarkTaskExited
						? "Agent requested group leader exit"
						: "Agent requested lane exit",
					errorMessage: null,
					...usagePatch,
				}
			: usagePatch,
	});
	logPersistTiming("transition_task_status", stepStartedAt, {
		updated: Boolean(updated),
	});
	if (!updated) {
		return false;
	}
	stepStartedAt = Date.now();
	await copyPersistentLaneArtifactsToTaskDir(stageCtx);
	logPersistTiming("copy_persistent_lane_artifacts_to_task_dir", stepStartedAt);
	if (!(stage.persistent ?? true) && (stage.reuseContainer ?? true)) {
		stepStartedAt = Date.now();
		await stopReusableSandboxAgentForTask(stageCtx.taskId);
		logPersistTiming("stop_reusable_sandbox_agent", stepStartedAt);
	}
	stepStartedAt = Date.now();
	if (stageCtx.laneIndex !== null) {
		if (options?.exitLane) {
			if (shouldRemoveContainerAfterTask(stage)) {
				await cleanupPersistentLaneForTask(stageCtx.taskId, options.runtime);
			} else {
				await resetStageLaneRuntimeSessionForExitRepo({
					taskId: stageCtx.taskId,
				}).catch(() => {});
			}
		} else {
			if (stage.persistent ?? true) {
				await releasePersistentLaneForTask(stageCtx.taskId);
			} else {
				await resetStageLaneRuntimeSessionForExitRepo({
					taskId: stageCtx.taskId,
				}).catch(() => {});
			}
		}
	} else {
		if (shouldRemoveContainerAfterTask(stage)) {
			await cleanupTaskContainer(stageCtx.taskId);
		}
	}
	logPersistTiming("cleanup_or_release_runtime", stepStartedAt, {
		laneIndex: stageCtx.laneIndex,
	});
	logPipelineEvent("loop.task_completed", {
		scanJobId: stageCtx.scanJobId,
		stageName: stage.id,
		taskId: stageCtx.taskId,
		taskName: stageCtx.taskName,
		rawOutputLength: rawOutput.length,
	});
	if (options?.exitReason) {
		logPipelineEvent("loop.task_exited", {
			scanJobId: stageCtx.scanJobId,
			stageName: stage.id,
			taskId: stageCtx.taskId,
			taskName: stageCtx.taskName,
			exitReason: options.exitReason,
			taskStatus: shouldMarkTaskExited ? "exited" : "completed",
		});
	}
	return true;
};

const persistTerminalFailure = async <
	TPipelineContext extends PipelineContext,
	TInput,
	TOutput,
	TStageContext extends StageContext,
>(
	stage: StageDefinition<TPipelineContext, TInput, TOutput, TStageContext>,
	ctx: TPipelineContext,
	stageCtx: TStageContext,
	input: TInput,
	error: unknown,
	_options?: { exitLane?: boolean },
) => {
	const currentTask = await findTaskByIdRepo(stageCtx.taskId).catch(() => null);
	if (
		currentTask &&
		currentTask.status !== "launching" &&
		currentTask.status !== "starting" &&
		currentTask.status !== "running"
	) {
		logPipelineEvent("stage.stale_failure_ignored", {
			scanJobId: stageCtx.scanJobId,
			stageName: stage.id,
			taskId: stageCtx.taskId,
			taskName: stageCtx.taskName,
			currentStatus: currentTask.status,
			errorMessage: getErrorMessage(error),
		});
		return false;
	}
	const usagePatch = await readTaskTokenUsage(stageCtx).catch(() => ({
		inputTokens: null,
		outputTokens: null,
		thoughtTokens: null,
		totalTokens: null,
		cachedReadTokens: null,
		cachedWriteTokens: null,
	}));
	const updated = await transitionTaskStatusRepo({
		taskId: stageCtx.taskId,
		from: ["launching", "starting", "running"],
		to: "failed",
		patch: { errorMessage: getErrorMessage(error), ...usagePatch },
	}).catch(() => null);
	if (!updated) {
		return false;
	}
	const failureDiagnostics = await buildTaskFailureDiagnostics(stageCtx).catch(
		(diagnosticError) => ({
			error: `Unable to collect task failure diagnostics: ${getErrorMessage(
				diagnosticError,
			)}`,
		}),
	);
	await appendTaskFailureDiagnostics(
		stageCtx,
		getErrorMessage(error),
		failureDiagnostics,
	).catch(() => {});
	await refreshPipelineState(ctx).catch(() => {});
	await cleanupFailedTaskRuntime(stageCtx.taskId);
	await stage.onFailure?.(stageCtx, input, error);
	logPipelineEvent("stage.failed", {
		scanJobId: stageCtx.scanJobId,
		stageName: stage.id,
		taskId: stageCtx.taskId,
		taskName: stageCtx.taskName,
		errorMessage: getErrorMessage(error),
		diagnostics: failureDiagnostics,
	});
	logPipelineEvent("loop.task_failed", {
		scanJobId: stageCtx.scanJobId,
		stageName: stage.id,
		taskId: stageCtx.taskId,
		taskName: stageCtx.taskName,
		errorMessage: getErrorMessage(error),
	});
	return true;
};

const runStageTaskLifecycle = async <
	TPipelineContext extends PipelineContext,
	TInput,
	TOutput,
	TStageContext extends StageContext,
>(
	stage: StageDefinition<TPipelineContext, TInput, TOutput, TStageContext>,
	ctx: TPipelineContext,
	input: TInput,
	options?: {
		taskIdOverride?: string;
		resumeOnly?: boolean;
	},
): Promise<StageLifecycleSuccess<TOutput, TStageContext>> => {
	const { taskId, taskName, stageCtx } = createTaskStageContext(
		stage,
		ctx,
		input,
		options?.taskIdOverride,
		await findTaskByIdRepo(
			resolveStageTaskId(stage.id, ctx, input, options?.taskIdOverride),
		).catch(() => null),
	);
	logPipelineEvent(options?.resumeOnly ? "stage.resume" : "stage.start", {
		scanJobId: stageCtx.scanJobId,
		stageName: stage.id,
		taskId,
		taskName,
	});
	try {
		await ensureTaskRuntimeDirectory(stageCtx);
		await assertScanJobNotCancelled(stageCtx);

		if (!options?.resumeOnly && stage.validateInput) {
			const isValid = await stage.validateInput(stageCtx, input);
			if (!isValid) {
				throw new Error(`Stage ${stage.id} rejected input ${taskId}`);
			}
		}

		if (!options?.resumeOnly) {
			await updateTaskDefault(taskId, { status: "launching" });
		}

		if (options?.resumeOnly) {
			throw new Error("Task polling is handled by the job loop");
		}
		const runResult = await stage.run(stageCtx, input);
		if (runResult.completion === "deferred") {
			throw new Error("Deferred stage launch is handled by the job loop");
		}
		const rawOutput = runResult.rawOutput;

		const output = await prepareStageSuccess(
			stage,
			ctx,
			stageCtx,
			input,
			rawOutput,
		);
		return {
			taskId,
			taskName,
			stageCtx,
			output,
			rawOutput,
		};
	} catch (error) {
		throw Object.assign(
			error instanceof Error ? error : new Error(String(error)),
			{
				stageCtx,
				taskId,
				taskName,
			},
		);
	}
};

export const runPipeline = async <
	TPipelineContext extends PipelineContext,
	TPipelineStages extends PipelineDefinition<TPipelineContext>["stages"],
>(
	pipeline: PipelineDefinition<TPipelineContext, TPipelineStages>,
	ctx: TPipelineContext,
	firstStageInput?: FirstStageInputOf<TPipelineStages>,
) => {
	const stageNames = pipeline.stages.map((stage) => stage.id);
	if (stageNames.length === 0) {
		return;
	}

	await assertScanJobNotCancelled(ctx);
	logPipelineEvent("pipeline.start", {
		pipelineName: pipeline.name,
		scanJobId: ctx.scanJobId,
		stageNames,
		hasFirstStageInput: firstStageInput !== undefined,
	});

	try {
		const runtime = startPipelineRuntime(pipeline, ctx);
		if (firstStageInput !== undefined) {
			const firstStage = pipeline.stages[0];
			if (!firstStage) {
				return;
			}
			const firstStageState = runtime.stageStates.get(firstStage.id);
			if (!firstStageState) {
				throw new Error(`Runtime state missing for stage ${firstStage.name}`);
			}
			await launchStageExecution(
				runtime,
				firstStageState as RuntimeStageState<
					TPipelineContext,
					FirstStageInputOf<TPipelineStages>,
					unknown
				>,
				{
					taskId: resolveStageTaskId(firstStage.id, ctx, firstStageInput),
					input: firstStageInput,
				},
			);
		}

		await runtime.completionPromise;
		logPipelineEvent("pipeline.completed", {
			pipelineName: pipeline.name,
			scanJobId: ctx.scanJobId,
		});
	} catch (error) {
		logPipelineEvent("pipeline.failed", {
			pipelineName: pipeline.name,
			scanJobId: ctx.scanJobId,
			errorMessage: getErrorMessage(error),
		});
		throw error;
	}
};

export const runStageOnce = async <
	TPipelineContext extends PipelineContext,
	TInput,
	TOutput,
	TStageContext extends StageContext,
>(
	stage: StageDefinition<TPipelineContext, TInput, TOutput, TStageContext>,
	ctx: TPipelineContext,
	input: TInput,
	taskIdOverride?: string,
): Promise<TOutput> => {
	try {
		const result = await runStageTaskLifecycle(stage, ctx, input, {
			taskIdOverride,
		});
		await persistTerminalSuccess(stage, ctx, result.stageCtx, result.rawOutput);
		await refreshPipelineState(ctx).catch(() => {});
		return result.output;
	} catch (error) {
		const { stageCtx } = createTaskStageContext(
			stage,
			ctx,
			input,
			taskIdOverride,
		);
		await persistTerminalFailure(stage, ctx, stageCtx, input, error);
		throw error;
	}
};

type RuntimeStageState<
	TPipelineContext extends PipelineContext,
	TInput = unknown,
	TOutput = unknown,
> = {
	stageName: string;
	stage: StageDefinition<TPipelineContext, TInput, TOutput, StageContext>;
};

type JobRuntime<TPipelineContext extends PipelineContext> = {
	key: string;
	pipeline: PipelineDefinition<TPipelineContext>;
	ctx: TPipelineContext;
	stageStates: Map<string, RuntimeStageState<TPipelineContext>>;
	runningStdoutSnapshots: Map<
		string,
		{
			hash: string;
			lastChangedAt: number;
			lastDiagnosticKey?: string;
			lastRunningOutputWithoutEndTurnDiagnosticKey?: string;
			lastRunningOutputWithoutEndTurnLoggedAt?: number;
		}
	>;
	wakeSignal: WakeSignal;
	stopRequested: boolean;
	failure: unknown;
	completionPromise: Promise<void>;
};

class WakeSignal {
	private version = 0;
	private waiters = new Set<(version: number) => void>();

	current() {
		return this.version;
	}

	notify() {
		this.version += 1;
		const nextVersion = this.version;
		const waiters = [...this.waiters];
		this.waiters.clear();
		for (const waiter of waiters) {
			waiter(nextVersion);
		}
	}

	wait(previousVersion: number) {
		if (this.version !== previousVersion) {
			return Promise.resolve(this.version);
		}
		return new Promise<number>((resolve) => {
			this.waiters.add(resolve);
		});
	}
}

const pipelineSupervisorJobs = new Map<string, JobRuntime<PipelineContext>>();

export const stopPipelineRuntimesForScanJob = (scanJobId: string) => {
	let stoppedRuntimes = 0;
	for (const runtime of pipelineSupervisorJobs.values()) {
		if (runtime.ctx.scanJobId !== scanJobId) {
			continue;
		}
		runtime.stopRequested = true;
		runtime.wakeSignal.notify();
		stoppedRuntimes += 1;
	}
	return stoppedRuntimes;
};

const getJobRuntimeKey = (pipelineName: string, scanJobId: string) =>
	`${pipelineName}:${scanJobId}`;

const handleJobRuntimeFailure = <TPipelineContext extends PipelineContext>(
	runtime: JobRuntime<TPipelineContext>,
	error: unknown,
) => {
	if (error instanceof Error && error.name === SCAN_JOB_CANCELLED_ERROR_NAME) {
		logPipelineEvent("loop.cancelled", {
			scanJobId: runtime.ctx.scanJobId,
			pipelineName: runtime.pipeline.name,
			errorMessage: error.message,
		});
		runtime.stopRequested = true;
		runtime.wakeSignal.notify();
		return;
	}
	if (!runtime.failure) {
		runtime.failure = error;
	}
	runtime.stopRequested = true;
	runtime.wakeSignal.notify();
};

const isJobRuntimeQuiescent = async <TPipelineContext extends PipelineContext>(
	runtime: JobRuntime<TPipelineContext>,
) => {
	for (const stageState of runtime.stageStates.values()) {
		const activeCount = await countActiveTasksByScanJobAndStageRepo({
			scanJobId: runtime.ctx.scanJobId,
			stageName: stageState.stageName,
		});
		if (activeCount > 0) {
			return false;
		}
		const queue = stageState.stage.queue?.queue;
		if (!queue) {
			continue;
		}
		const counts = await queue.getJobCounts(
			"waiting",
			"prioritized",
			"delayed",
		);
		if (
			(counts.waiting || 0) +
				(counts.prioritized || 0) +
				(counts.delayed || 0) >
			0
		) {
			return false;
		}
	}
	return true;
};

const claimReusableContainerIndexForStage = async (input: {
	scanJobId: string;
	stageName: string;
	containerCount: number;
}) => {
	const activeTasks = await listActiveTasksByScanJobAndStageRepo({
		scanJobId: input.scanJobId,
		stageName: input.stageName,
	});
	const usedIndexes = new Set(
		activeTasks
			.map((task) => task.containerIndex)
			.filter((value): value is number => typeof value === "number"),
	);
	for (let index = 0; index < input.containerCount; index += 1) {
		if (!usedIndexes.has(index)) {
			return index;
		}
	}
	return null;
};

const launchStageExecution = async <
	TPipelineContext extends PipelineContext,
	TInput,
	TOutput,
>(
	runtime: JobRuntime<TPipelineContext>,
	stageState: RuntimeStageState<TPipelineContext, TInput, TOutput>,
	execution: StageExecution<TInput>,
	options?: { logEvent?: string },
) => {
	const launchStartedAt = Date.now();
	const logLaunchTiming = (
		step: string,
		startedAt: number,
		extra: Record<string, unknown> = {},
	) => {
		logPipelineEvent("stage.launch_timing", {
			scanJobId: runtime.ctx.scanJobId,
			pipelineName: runtime.pipeline.name,
			stageName: stageState.stageName,
			taskId: execution.taskId,
			step,
			elapsedMs: Date.now() - startedAt,
			totalElapsedMs: Date.now() - launchStartedAt,
			...extra,
		});
	};
	let stepStartedAt = Date.now();
	const limit = await getStageConcurrencyLimit(stageState.stage, runtime.ctx);
	const pendingTask = await findTaskByIdRepo(execution.taskId).catch(
		() => null,
	);
	const queueScope = pendingTask
		? (await resolvePendingTaskQueueScope(pendingTask)) || {}
		: {};
	const group = getStageGroup(runtime.pipeline, stageState.stageName);
	const leaderGroup = getStageLeaderGroup(
		runtime.pipeline,
		stageState.stageName,
	);
	const persistentBacked = stageState.stage.persistent ?? true;
	const reuseContainer = stageState.stage.reuseContainer ?? true;
	logLaunchTiming("load_pending_and_scope", stepStartedAt, {
		concurrencyLimit: limit,
		persistent: persistentBacked,
		reuseContainer,
		hasPendingTask: Boolean(pendingTask),
		groupName: group?.name ?? null,
		leaderGroupName: leaderGroup?.name ?? null,
	});
	stepStartedAt = Date.now();
	const boundMembership =
		pendingTask?.stageGroupInstanceId && persistentBacked
			? await findStageGroupLaneMembershipRepo({
					groupInstanceId: pendingTask.stageGroupInstanceId,
					stageName: stageState.stageName,
				}).catch(() => null)
			: null;
	const reservedLaneIndexes =
		!boundMembership && persistentBacked
			? await listReservedLaneIndexesForStage({
					scanJobId: runtime.ctx.scanJobId,
					stageName: stageState.stageName,
					allowedGroupInstanceId: pendingTask?.stageGroupInstanceId ?? null,
					runtime: runtime as unknown as JobRuntime<PipelineContext>,
				})
			: [];
	let laneRuntime = boundMembership
		? await claimSpecificStageLaneRuntimeRepo({
				scanJobId: runtime.ctx.scanJobId,
				stageName: stageState.stageName,
				laneIndex: boundMembership.laneIndex,
				laneCount: limit,
				taskId: execution.taskId,
			})
		: persistentBacked
			? await claimIdleStageLaneRuntimeRepo({
					scanJobId: runtime.ctx.scanJobId,
					stageName: stageState.stageName,
					laneCount: limit,
					taskId: execution.taskId,
					forkedFromTaskId: pendingTask?.forkedFromTaskId ?? null,
					forkedFromThreadId: pendingTask?.forkedFromThreadId ?? null,
					excludedLaneIndexes: reservedLaneIndexes,
				})
			: null;
	logLaunchTiming("claim_lane", stepStartedAt, {
		laneIndex: laneRuntime?.laneIndex ?? null,
		boundLaneIndex: boundMembership?.laneIndex ?? null,
		reservedLaneIndexes,
	});
	if (persistentBacked && !laneRuntime) {
		await stageState.stage.queue
			?.enqueue(execution.taskId, queueScope)
			.catch(() => {});
		logLaunchTiming("requeue_no_lane", launchStartedAt);
		return false;
	}
	stepStartedAt = Date.now();
	const containerIndex = laneRuntime
		? laneRuntime.laneIndex
		: reuseContainer
			? await claimReusableContainerIndexForStage({
					scanJobId: runtime.ctx.scanJobId,
					stageName: stageState.stageName,
					containerCount: limit,
				})
			: null;
	logLaunchTiming("claim_container", stepStartedAt, {
		containerIndex,
	});
	if (reuseContainer && containerIndex === null) {
		await stageState.stage.queue
			?.enqueue(execution.taskId, queueScope)
			.catch(() => {});
		logLaunchTiming("requeue_no_container", launchStartedAt);
		return false;
	}
	stepStartedAt = Date.now();
	const launched = await transitionTaskStatusRepo({
		taskId: execution.taskId,
		from: ["pending"],
		to: "launching",
		patch: {
			containerIndex,
		},
	});
	logLaunchTiming("transition_launching", stepStartedAt, {
		launched: Boolean(launched),
		containerIndex,
	});
	if (!launched) {
		if (laneRuntime) {
			await releaseStageLaneRuntimeRepo(execution.taskId).catch(() => {});
		}
		return false;
	}

	stepStartedAt = Date.now();
	if (laneRuntime && leaderGroup) {
		const existingGroup = pendingTask?.stageGroupInstanceId
			? await findStageGroupInstanceByIdRepo(
					pendingTask.stageGroupInstanceId,
				).catch(() => null)
			: null;
		const groupInstance =
			existingGroup && existingGroup.status === "active"
				? existingGroup
				: await createStageGroupInstanceRepo({
						scanJobId: runtime.ctx.scanJobId,
						groupName: leaderGroup.name,
						leaderStageName: stageState.stageName,
						leaderLaneIndex: laneRuntime.laneIndex,
						leaderTaskId: execution.taskId,
					});
		await ensureStageGroupLaneMembershipRepo({
			groupInstanceId: groupInstance.groupInstanceId,
			stageName: stageState.stageName,
			laneIndex: laneRuntime.laneIndex,
			role: "leader",
		});
		await updateTaskRepo(execution.taskId, {
			stageGroupInstanceId: groupInstance.groupInstanceId,
		});
	} else if (laneRuntime && pendingTask?.stageGroupInstanceId && group) {
		await ensureStageGroupLaneMembershipRepo({
			groupInstanceId: pendingTask.stageGroupInstanceId,
			stageName: stageState.stageName,
			laneIndex: laneRuntime.laneIndex,
			role: "member",
		});
	}
	logLaunchTiming("stage_group_membership", stepStartedAt, {
		laneIndex: laneRuntime?.laneIndex ?? null,
		stageGroupInstanceId: launched.stageGroupInstanceId ?? null,
	});

	stepStartedAt = Date.now();
	if (
		laneRuntime &&
		(stageState.stage.persistent ?? true) &&
		laneRuntime.threadId &&
		!pendingTask?.stageGroupInstanceId &&
		((laneRuntime.forkedFromTaskId ?? null) !==
			(launched.forkedFromTaskId ?? null) ||
			(laneRuntime.forkedFromThreadId ?? null) !==
				(launched.forkedFromThreadId ?? null))
	) {
		const staleLaneRuntime = laneRuntime;
		if (staleLaneRuntime.containerName) {
			await removeContainer(staleLaneRuntime.containerName).catch(() => {});
		}
		laneRuntime =
			(await resetClaimedStageLaneRuntimeForFreshStartRepo({
				scanJobId: staleLaneRuntime.scanJobId,
				stageName: staleLaneRuntime.stageName,
				laneIndex: staleLaneRuntime.laneIndex,
				forkedFromTaskId: launched.forkedFromTaskId ?? null,
				forkedFromThreadId: launched.forkedFromThreadId ?? null,
			})) ?? staleLaneRuntime;
		logPipelineEvent("stage.persistent_lane_parent_changed", {
			scanJobId: runtime.ctx.scanJobId,
			pipelineName: runtime.pipeline.name,
			stageName: stageState.stageName,
			taskId: execution.taskId,
			laneIndex: laneRuntime.laneIndex,
		});
	}
	logLaunchTiming("stale_lane_check", stepStartedAt, {
		laneIndex: laneRuntime?.laneIndex ?? null,
		threadId: laneRuntime?.threadId ?? null,
	});

	stepStartedAt = Date.now();
	const stageCtx = createTaskStageContext(
		stageState.stage,
		runtime.ctx,
		execution.input,
		execution.taskId,
		{
			...launched,
			laneRuntime,
			containerIndex,
			routeOutputSchemas: getStageRouteOutputSchemas(
				runtime.pipeline,
				stageState.stageName,
			),
			taskName: launched.name,
			groupedPersistent: Boolean(laneRuntime && group),
			allowAgentExit: stageState.stageName === SCAN_STAGE_IDS.analysis,
		},
	).stageCtx;
	logLaunchTiming("create_stage_context", stepStartedAt, {
		laneIndex: laneRuntime?.laneIndex ?? null,
		containerIndex,
	});
	try {
		stepStartedAt = Date.now();
		await ensureTaskRuntimeDirectory(stageCtx);
		await assertScanJobNotCancelled(stageCtx);
		if (stageState.stage.validateInput) {
			const isValid = await stageState.stage.validateInput(
				stageCtx,
				execution.input,
			);
			if (!isValid) {
				throw new Error(
					`Stage ${stageState.stage.id} rejected input ${execution.taskId}`,
				);
			}
			}
			logLaunchTiming("ensure_runtime_and_validate", stepStartedAt);

				const launchStage = stageState.stage.launch;
				if (launchStage) {
					void (async () => {
						const asyncLaunchStartedAt = Date.now();
						try {
							await launchStage(stageCtx, execution.input);
						logLaunchTiming("stage_launch", asyncLaunchStartedAt, {
							laneIndex: laneRuntime?.laneIndex ?? null,
							containerIndex,
						});
						const launchCompleted = await transitionTaskStatusRepo({
							taskId: execution.taskId,
							from: ["launching"],
							to: "launched",
							patch: { errorMessage: null },
						});
						logPipelineEvent("stage.launched", {
							scanJobId: runtime.ctx.scanJobId,
							pipelineName: runtime.pipeline.name,
							stageName: stageState.stageName,
							taskId: execution.taskId,
							taskName: stageCtx.taskName,
							transitioned: Boolean(launchCompleted),
							elapsedMs: Date.now() - asyncLaunchStartedAt,
						});
					} catch (error) {
						const nextAttempt = (launched.attempt ?? 0) + 1;
						if (
							isTransientRuntimeLaunchError(error) &&
							nextAttempt <= MAX_TRANSIENT_LAUNCH_RETRIES
						) {
							const failedTask = await findTaskByIdRepo(execution.taskId).catch(
								() => null,
							);
							const failedContainerName =
								failedTask?.containerName || stageCtx.containerName();
							if (failedContainerName) {
								await removeContainer(failedContainerName).catch(() => {});
							}
							if (laneRuntime) {
								await releaseStageLaneRuntimeRepo(execution.taskId).catch(
									() => {},
								);
							}
							await transitionTaskStatusRepo({
								taskId: execution.taskId,
								from: ["launching"],
								to: "pending",
								patch: {
									attempt: nextAttempt,
									containerName: null,
									containerIndex: null,
									threadId: null,
									errorMessage: `Transient runtime launch failure; retry ${nextAttempt}/${MAX_TRANSIENT_LAUNCH_RETRIES}: ${getErrorMessage(error)}`,
								},
							});
							await stageState.stage.queue
								?.enqueue(execution.taskId, queueScope)
								.catch(() => {});
							logPipelineEvent("stage.launch_retry", {
								scanJobId: runtime.ctx.scanJobId,
								pipelineName: runtime.pipeline.name,
								stageName: stageState.stageName,
								taskId: execution.taskId,
								taskName: stageCtx.taskName,
								attempt: nextAttempt,
								maxAttempts: MAX_TRANSIENT_LAUNCH_RETRIES,
								errorMessage: getErrorMessage(error),
							});
						} else {
							await persistTerminalFailure(
								stageState.stage,
								runtime.ctx,
								stageCtx,
								execution.input,
								error,
							);
							await maybeMarkTaskStageGroupExited(execution.taskId, runtime);
						}
					} finally {
						runtime.wakeSignal.notify();
					}
				})();
				logPipelineEvent("loop.stage_launch_spawned", {
					scanJobId: runtime.ctx.scanJobId,
					pipelineName: runtime.pipeline.name,
					stageName: stageState.stageName,
					taskId: execution.taskId,
					taskName: stageCtx.taskName,
				});
				return true;
			}

			stepStartedAt = Date.now();
			const runResult = await stageState.stage.run(stageCtx, execution.input);
		logLaunchTiming("stage_run", stepStartedAt, {
			completion: runResult.completion,
			threadId: "threadId" in runResult ? runResult.threadId : null,
			laneIndex: laneRuntime?.laneIndex ?? null,
			containerIndex,
		});
		if (runResult.completion === "immediate") {
			stepStartedAt = Date.now();
			const output = await prepareStageSuccess(
				stageState.stage,
				runtime.ctx,
				stageCtx,
				execution.input,
				runResult.rawOutput,
			);
			logLaunchTiming("prepare_immediate_success", stepStartedAt);
			validateSelectedDownstreamOutput(
				runtime,
				stageState.stageName,
				output,
				null,
			);
			stepStartedAt = Date.now();
			const terminalUpdated = await persistTerminalSuccess(
				stageState.stage,
				runtime.ctx,
				stageCtx,
				runResult.rawOutput,
				{ runtime },
			);
			logLaunchTiming("persist_immediate_success", stepStartedAt, {
				terminalUpdated,
			});
			if (terminalUpdated) {
				stepStartedAt = Date.now();
				await dispatchPipelineDownstream(
					runtime,
					stageState.stageName,
					execution.taskId,
					execution.input,
					output,
					null,
				);
				logLaunchTiming("dispatch_immediate_downstream", stepStartedAt);
				await maybeMarkTaskStageGroupExited(execution.taskId, runtime);
				await refreshPipelineState(runtime.ctx).catch(() => {});
			}
		}
	} catch (error) {
		const nextAttempt = (launched.attempt ?? 0) + 1;
		if (
			isTransientRuntimeLaunchError(error) &&
			nextAttempt <= MAX_TRANSIENT_LAUNCH_RETRIES
		) {
			const failedTask = await findTaskByIdRepo(execution.taskId).catch(
				() => null,
			);
			const failedContainerName =
				failedTask?.containerName || stageCtx.containerName();
			if (failedContainerName) {
				await removeContainer(failedContainerName).catch(() => {});
			}
			if (laneRuntime) {
				await releaseStageLaneRuntimeRepo(execution.taskId).catch(() => {});
			}
			await transitionTaskStatusRepo({
				taskId: execution.taskId,
				from: ["launching"],
				to: "pending",
				patch: {
					attempt: nextAttempt,
					containerName: null,
					containerIndex: null,
					threadId: null,
					errorMessage: `Transient runtime launch failure; retry ${nextAttempt}/${MAX_TRANSIENT_LAUNCH_RETRIES}: ${getErrorMessage(error)}`,
				},
			});
			await stageState.stage.queue
				?.enqueue(execution.taskId, queueScope)
				.catch(() => {});
			logPipelineEvent("stage.launch_retry", {
				scanJobId: runtime.ctx.scanJobId,
				pipelineName: runtime.pipeline.name,
				stageName: stageState.stageName,
				taskId: execution.taskId,
				taskName: stageCtx.taskName,
				attempt: nextAttempt,
				maxAttempts: MAX_TRANSIENT_LAUNCH_RETRIES,
				errorMessage: getErrorMessage(error),
			});
			await backfillStageQueue(runtime, stageState);
			return true;
		}
		await persistTerminalFailure(
			stageState.stage,
			runtime.ctx,
			stageCtx,
			execution.input,
			error,
		);
		await maybeMarkTaskStageGroupExited(execution.taskId, runtime);
		await backfillStageQueue(runtime, stageState);
	} finally {
		runtime.wakeSignal.notify();
	}
	if (!options?.logEvent) {
		logPipelineEvent("loop.stage_spawned", {
			scanJobId: runtime.ctx.scanJobId,
			pipelineName: runtime.pipeline.name,
			stageName: stageState.stageName,
			taskId: execution.taskId,
		});
	}
	return true;
};

const startStageRunAsync = <TPipelineContext extends PipelineContext>(
	runtime: JobRuntime<TPipelineContext>,
	stageState: RuntimeStageState<TPipelineContext>,
	task: Awaited<ReturnType<typeof findTaskByIdRepo>>,
	stageCtx: StageContext,
	input: unknown,
) => {
	void (async () => {
		const runStartedAt = Date.now();
		try {
			const runResult = await stageState.stage.run(stageCtx, input);
			logPipelineEvent("stage.run_started", {
				scanJobId: runtime.ctx.scanJobId,
				pipelineName: runtime.pipeline.name,
				stageName: stageState.stageName,
				taskId: task.taskId,
				taskName: stageCtx.taskName,
				completion: runResult.completion,
				threadId: "threadId" in runResult ? runResult.threadId : null,
				elapsedMs: Date.now() - runStartedAt,
			});
			if (runResult.completion === "immediate") {
				const output = await prepareStageSuccess(
					stageState.stage,
					runtime.ctx,
					stageCtx,
					input,
					runResult.rawOutput,
				);
				validateSelectedDownstreamOutput(
					runtime,
					stageState.stageName,
					output,
					null,
				);
				const terminalUpdated = await persistTerminalSuccess(
					stageState.stage,
					runtime.ctx,
					stageCtx,
					runResult.rawOutput,
					{ runtime },
				);
				if (terminalUpdated) {
					await dispatchPipelineDownstream(
						runtime,
						stageState.stageName,
						task.taskId,
						input,
						output,
						null,
					);
					await maybeMarkTaskStageGroupExited(task.taskId, runtime);
					await refreshPipelineState(runtime.ctx).catch(() => {});
				}
				return;
			}
			if (runResult.threadId) {
				const lane = await findStageLaneRuntimeByActiveTaskIdRepo(task.taskId);
				if (lane) {
					await bindStageLaneRuntimeRepo({
						scanJobId: lane.scanJobId,
						stageName: lane.stageName,
						laneIndex: lane.laneIndex,
						containerName: task.containerName,
						threadId: runResult.threadId,
					});
				}
				await transitionTaskStatusRepo({
					taskId: task.taskId,
					from: ["starting"],
					to: "running",
					patch: { threadId: runResult.threadId, errorMessage: null },
				});
				runtime.runningStdoutSnapshots.delete(task.taskId);
				logPipelineEvent("loop.task_running", {
					scanJobId: runtime.ctx.scanJobId,
					pipelineName: runtime.pipeline.name,
					stageName: task.stageName,
					taskId: task.taskId,
					taskName: task.name,
					threadId: runResult.threadId,
				});
			}
		} catch (error) {
			await persistTerminalFailure(
				stageState.stage,
				runtime.ctx,
				stageCtx,
				input,
				error,
			);
			await maybeMarkTaskStageGroupExited(task.taskId, runtime);
		} finally {
			runtime.wakeSignal.notify();
		}
	})();
};

const inspectActiveStageTask = async <TPipelineContext extends PipelineContext>(
	runtime: JobRuntime<TPipelineContext>,
	stageState: RuntimeStageState<TPipelineContext>,
	task: Awaited<ReturnType<typeof findTaskByIdRepo>>,
) => {
	const inspectStartedAt = Date.now();
	const logInspectTiming = (
		step: string,
		startedAt: number,
		extra: Record<string, unknown> = {},
	) => {
		logPipelineEvent("stage.inspect_timing", {
			scanJobId: runtime.ctx.scanJobId,
			pipelineName: runtime.pipeline.name,
			stageName: stageState.stageName,
			taskId: task.taskId,
			taskName: task.name,
			status: task.status,
			step,
			elapsedMs: Date.now() - startedAt,
			totalElapsedMs: Date.now() - inspectStartedAt,
			...extra,
		});
	};
	let stepStartedAt = Date.now();
	const stageCtx = await createStageContextForTask(runtime, task);
	const input = task.input as unknown;
	const { stdoutPath, stderrPath } = await getTaskRuntimePaths(stageCtx);
	const [stdoutContent, stderrContent] = await Promise.all([
		readFileIfExists(stdoutPath),
		readFileIfExists(stderrPath),
	]);
	logInspectTiming("load_runtime_logs", stepStartedAt);

	if (task.status === "launched") {
		stepStartedAt = Date.now();
		const claimed = await transitionTaskStatusRepo({
			taskId: task.taskId,
			from: ["launched"],
			to: "starting",
			patch: { errorMessage: null },
		});
		logInspectTiming("transition_starting", stepStartedAt, {
			claimed: Boolean(claimed),
		});
		if (claimed) {
			startStageRunAsync(runtime, stageState, claimed, stageCtx, input);
		}
		return true;
	}

	if (task.status === "launching" || task.status === "starting") {
		if (task.status === "launching") {
			logInspectTiming("launching_waiting_for_launch", stepStartedAt, {
				containerName: task.containerName ?? null,
			});
			return false;
		}
		stepStartedAt = Date.now();
		const threadId = extractThreadIdFromStdout(stdoutContent);
		if (threadId) {
			const lane = await findStageLaneRuntimeByActiveTaskIdRepo(task.taskId);
			if (lane) {
				await bindStageLaneRuntimeRepo({
					scanJobId: lane.scanJobId,
					stageName: lane.stageName,
					laneIndex: lane.laneIndex,
					containerName: task.containerName,
					threadId,
				});
			}
			await transitionTaskStatusRepo({
				taskId: task.taskId,
				from: [task.status],
				to: "running",
				patch: { threadId, errorMessage: null },
			});
			runtime.runningStdoutSnapshots.delete(task.taskId);
			logPipelineEvent("loop.task_running", {
				scanJobId: runtime.ctx.scanJobId,
				pipelineName: runtime.pipeline.name,
				stageName: task.stageName,
				taskId: task.taskId,
				taskName: task.name,
				threadId,
			});
			logInspectTiming("transition_running", stepStartedAt, { threadId });
			return true;
		}

		const exitCode = extractDriverExitCode(stderrContent);
		if (exitCode !== null) {
			stepStartedAt = Date.now();
			await persistTerminalFailure(
				stageState.stage,
				runtime.ctx,
				stageCtx,
				input,
				exitCode === 0
					? new Error("Sandbox agent driver exited before reporting THREAD_ID")
					: new Error(
							`Sandbox agent driver exited with code ${exitCode} before reporting THREAD_ID`,
					),
			);
			await maybeMarkTaskStageGroupExited(task.taskId, runtime);
			logInspectTiming("persist_launch_failure", stepStartedAt, { exitCode });
			return true;
		}

		stepStartedAt = Date.now();
		const containerAlive = await isContainerAlive(task.containerName);
		logInspectTiming(`${task.status}_container_alive`, stepStartedAt, {
			containerAlive,
		});
		if (!containerAlive) {
			stepStartedAt = Date.now();
			await persistTerminalFailure(
				stageState.stage,
				runtime.ctx,
				stageCtx,
				input,
				new Error("Task runtime container stopped before reporting THREAD_ID"),
			);
			await maybeMarkTaskStageGroupExited(task.taskId, runtime);
			logInspectTiming("persist_container_stopped_failure", stepStartedAt);
			return true;
		}

		stepStartedAt = Date.now();
		const halfStarted = await inspectHalfStartedRunningTask(runtime, {
			...task,
			status: "running",
		});
		logInspectTiming("inspect_half_started", stepStartedAt, {
			halfStarted: Boolean(halfStarted),
			reason: halfStarted?.reason ?? null,
		});
		if (halfStarted) {
			stepStartedAt = Date.now();
			await persistTerminalFailure(
				stageState.stage,
				runtime.ctx,
				stageCtx,
				input,
				new Error(`Task became silently stuck: ${halfStarted.reason}`),
			);
			await maybeMarkTaskStageGroupExited(task.taskId, runtime);
			logInspectTiming("persist_half_started_failure", stepStartedAt);
			return true;
		}
		return false;
	}

	let resolvedOutput: Awaited<ReturnType<typeof resolveStageRawOutput>>;
	try {
		stepStartedAt = Date.now();
		resolvedOutput = await resolveStageRawOutput(stageCtx);
		logInspectTiming("resolve_stage_raw_output", stepStartedAt, {
			hasRawOutput: resolvedOutput.rawOutput !== null,
			hasExitSignal: resolvedOutput.hasExitSignal,
			routeKey: resolvedOutput.routeKey ?? null,
		});
	} catch (error) {
		stepStartedAt = Date.now();
		await persistTerminalFailure(
			stageState.stage,
			runtime.ctx,
			stageCtx,
			input,
			error,
		);
		await maybeMarkTaskStageGroupExited(task.taskId, runtime);
		logInspectTiming("persist_resolve_failure", stepStartedAt);
		return true;
	}
	const {
		rawOutput,
		stderrContent: rawStderrContent,
		hasExitSignal,
		routeKey,
	} = resolvedOutput;
	if (rawOutput !== null) {
		try {
			stepStartedAt = Date.now();
			const output = await prepareStageSuccess(
				stageState.stage,
				runtime.ctx,
				stageCtx,
				input,
				rawOutput,
			);
			logInspectTiming("prepare_stage_success", stepStartedAt);
			stepStartedAt = Date.now();
			validateSelectedDownstreamOutput(
				runtime,
				stageState.stageName,
				output,
				routeKey,
			);
			logInspectTiming("validate_downstream_output", stepStartedAt);
			stepStartedAt = Date.now();
			const terminalUpdated = await persistTerminalSuccess(
				stageState.stage,
				runtime.ctx,
				stageCtx,
				rawOutput,
				{
					exitLane: hasExitSignal,
					exitReason: hasExitSignal ? "agent_exit" : undefined,
					runtime,
				},
			);
			logInspectTiming("persist_terminal_success", stepStartedAt, {
				terminalUpdated,
			});
			if (terminalUpdated) {
				stepStartedAt = Date.now();
				await dispatchPipelineDownstream(
					runtime,
					stageState.stageName,
					task.taskId,
					input,
					output,
					routeKey,
				);
				logInspectTiming("dispatch_pipeline_downstream", stepStartedAt);
				stepStartedAt = Date.now();
				await maybeMarkTaskStageGroupExited(task.taskId, runtime);
				logInspectTiming("maybe_mark_group_exited", stepStartedAt);
				stepStartedAt = Date.now();
				await refreshPipelineState(runtime.ctx).catch(() => {});
				logInspectTiming("refresh_pipeline_state", stepStartedAt);
			}
		} catch (error) {
			if (hasExitSignal) {
				stepStartedAt = Date.now();
				await updateTaskRepo(task.taskId, {
					errorMessage: getErrorMessage(error),
				}).catch(() => {});
				await persistTerminalSuccess(
					stageState.stage,
					runtime.ctx,
					stageCtx,
					rawOutput,
					{ exitLane: true, exitReason: "agent_exit", runtime },
				);
				logInspectTiming("persist_exit_lane_success_with_error", stepStartedAt);
			} else {
				stepStartedAt = Date.now();
				await persistTerminalFailure(
					stageState.stage,
					runtime.ctx,
					stageCtx,
					input,
					error,
					{ exitLane: hasExitSignal },
				);
				await maybeMarkTaskStageGroupExited(task.taskId, runtime);
				logInspectTiming("persist_success_handling_failure", stepStartedAt);
			}
		}
		return true;
	}

	const exitCode = extractDriverExitCode(rawStderrContent);
	if (exitCode !== null) {
		stepStartedAt = Date.now();
		const { jsonlPath } = await getTaskRuntimePaths(stageCtx);
		const jsonRpcErrorMessage =
			await readLastJsonRpcErrorMessageFromJsonl(jsonlPath);
		const driverExitMessage =
			exitCode === 0
				? "Sandbox agent driver exited before output.json completion"
				: `Sandbox agent driver exited with code ${exitCode}`;
		await persistTerminalFailure(
			stageState.stage,
			runtime.ctx,
			stageCtx,
			input,
			new Error(
				jsonRpcErrorMessage
					? `${driverExitMessage}; ${jsonRpcErrorMessage}`
					: driverExitMessage,
			),
			{ exitLane: hasExitSignal },
		);
		await maybeMarkTaskStageGroupExited(task.taskId, runtime);
		logInspectTiming("persist_driver_exit_failure", stepStartedAt, {
			exitCode,
			jsonRpcErrorMessage,
		});
		return true;
	}

	if (hasDriverCompletedWithoutOutput(rawStderrContent)) {
		stepStartedAt = Date.now();
		await persistTerminalFailure(
			stageState.stage,
			runtime.ctx,
			stageCtx,
			input,
			new Error("Sandbox agent prompt completed without output.json"),
			{ exitLane: hasExitSignal },
		);
		await maybeMarkTaskStageGroupExited(task.taskId, runtime);
		logInspectTiming("persist_completed_without_end_turn_failure", stepStartedAt);
		return true;
	}

	stepStartedAt = Date.now();
	const containerAlive = await isContainerAlive(task.containerName);
	logInspectTiming("running_container_alive", stepStartedAt, { containerAlive });
	if (!containerAlive) {
		stepStartedAt = Date.now();
		await persistTerminalFailure(
			stageState.stage,
			runtime.ctx,
			stageCtx,
			input,
			new Error(
				"Task runtime container stopped before output.json completion",
			),
		);
		await maybeMarkTaskStageGroupExited(task.taskId, runtime);
		logInspectTiming("persist_running_container_stopped_failure", stepStartedAt);
		return true;
	}

	stepStartedAt = Date.now();
	const halfStarted = await inspectHalfStartedRunningTask(runtime, task);
	logInspectTiming("inspect_running_half_started", stepStartedAt, {
		halfStarted: Boolean(halfStarted),
		reason: halfStarted?.reason ?? null,
	});
	if (halfStarted) {
		stepStartedAt = Date.now();
		await failSilentStuckTask(
			runtime,
			task,
			halfStarted.reason,
			halfStarted.diagnostics,
			stageCtx,
		);
		logInspectTiming("persist_running_half_started_failure", stepStartedAt);
		return true;
	}
	return false;
};

const backfillStageQueue = async <
	TPipelineContext extends PipelineContext,
	TInput,
	TOutput,
>(
	runtime: JobRuntime<TPipelineContext>,
	stageState: RuntimeStageState<TPipelineContext, TInput, TOutput>,
	scope?: StageQueueScope,
) => {
	await assertScanJobNotCancelled(runtime.ctx);
	if (await shouldStopForPausedScanJob(runtime)) {
		return 0;
	}
	if (!(await isRuntimeStageActive(runtime, stageState.stageName))) {
		return 0;
	}
	const limit = await getStageConcurrencyLimit(stageState.stage, runtime.ctx);
	let launchedCount = 0;

	while (!runtime.stopRequested) {
		await assertScanJobNotCancelled(runtime.ctx);
		if (await shouldStopForPausedScanJob(runtime)) {
			break;
		}
		if (!(await isRuntimeStageActive(runtime, stageState.stageName))) {
			break;
		}
		const activeCount = await countActiveTasksByScanJobAndStageRepo({
			scanJobId: runtime.ctx.scanJobId,
			stageName: stageState.stageName,
		});
		if (activeCount >= limit) {
			break;
		}
		const execution = await stageState.stage.queue?.poll(runtime.ctx, scope);
		if (execution === undefined) {
			break;
		}

		const launched = await launchStageExecution(
			runtime,
			stageState,
			execution,
			{
				logEvent: "loop.stage_backfill_spawned",
			},
		);
		if (!launched) {
			break;
		}
		launchedCount += 1;
		logPipelineEvent("loop.stage_backfill_spawned", {
			scanJobId: runtime.ctx.scanJobId,
			pipelineName: runtime.pipeline.name,
			stageName: stageState.stageName,
			taskId: execution.taskId,
			concurrencyLimit: limit,
			queueScope: scope?.groupInstanceId ? "group" : "global",
			groupInstanceId: scope?.groupInstanceId ?? null,
		});
	}

	return launchedCount;
};

const resolvePendingTaskQueueScope = async (task: {
	taskId: string;
	stageGroupInstanceId?: string | null;
}): Promise<StageQueueScope | null> => {
	if (!task.stageGroupInstanceId) {
		return {};
	}
	const group = await findStageGroupInstanceByIdRepo(
		task.stageGroupInstanceId,
	).catch(() => null);
	if (!group || group.status !== "active") {
		return null;
	}
	if (group.leaderTaskId === task.taskId) {
		return {};
	}
	return { groupInstanceId: task.stageGroupInstanceId };
};

const reenqueueMissingPendingTasks = async <
	TPipelineContext extends PipelineContext,
>(
	runtime: JobRuntime<TPipelineContext>,
) => {
	const tasks = await listTasksByScanJobIdRepo(runtime.ctx.scanJobId);
	let reenqueueCount = 0;
	for (const task of tasks) {
			if (task.status !== "pending") {
				if (
					task.status !== "launching" &&
					task.status !== "launched" &&
					task.status !== "starting" &&
					task.status !== "running"
				) {
					runtime.runningStdoutSnapshots.delete(task.taskId);
				}
			continue;
		}
		const stageState = runtime.stageStates.get(task.stageName);
		const queueBinding = stageState?.stage.queue;
		if (!stageState || !queueBinding) {
			continue;
		}
		const queueScope = await resolvePendingTaskQueueScope(task);
		if (queueScope === null) {
			continue;
		}
		const scopedQueue = queueBinding.getQueue(queueScope);
		const knownJobIds = buildKnownQueueJobIdsForTask(scopedQueue, task);
		const existingJobs = await Promise.all(
			knownJobIds.map((jobId) => scopedQueue.getJob(jobId).catch(() => null)),
		);
		const existingJob = existingJobs.find(Boolean);
		if (existingJob) {
			continue;
		}
		await queueBinding.enqueue(task.taskId, queueScope);
		logPipelineEvent("loop.pending_task_reenqueued", {
			scanJobId: runtime.ctx.scanJobId,
			pipelineName: runtime.pipeline.name,
			stageName: task.stageName,
			taskId: task.taskId,
			taskName: task.name,
			queueName: scopedQueue.name,
			queueScope: queueScope.groupInstanceId ? "group" : "global",
			groupInstanceId: queueScope.groupInstanceId ?? null,
		});
		reenqueueCount += 1;
	}
	return reenqueueCount;
};

const backfillActiveGroupQueues = async <
	TPipelineContext extends PipelineContext,
>(
	runtime: JobRuntime<TPipelineContext>,
) => {
	const tasks = await listTasksByScanJobIdRepo(runtime.ctx.scanJobId);
	const seen = new Set<string>();
	let launchedCount = 0;
	for (const task of tasks) {
		if (task.status !== "pending" || !task.stageGroupInstanceId) {
			continue;
		}
		const queueScope = await resolvePendingTaskQueueScope(task);
		if (!queueScope?.groupInstanceId) {
			continue;
		}
		const key = `${queueScope.groupInstanceId}:${task.stageName}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		const stageState = runtime.stageStates.get(task.stageName);
		if (!stageState) {
			continue;
		}
		launchedCount += await backfillStageQueue(runtime, stageState, queueScope);
	}
	return launchedCount;
};

const inspectTasks = async <TPipelineContext extends PipelineContext>(
	runtime: JobRuntime<TPipelineContext>,
) => {
	const metrics = {
		progressed: false,
		inspectedCount: 0,
		progressedCount: 0,
		activeCount: 0,
		completedCount: 0,
	};
	for (const stageState of runtime.stageStates.values()) {
		const activeTasks = await listActiveTasksByScanJobAndStageRepo({
			scanJobId: runtime.ctx.scanJobId,
			stageName: stageState.stageName,
		});
		metrics.activeCount += activeTasks.length;
		for (const task of activeTasks) {
			metrics.inspectedCount += 1;
			const wasRunning = task.status === "running";
			const taskProgressed = await inspectActiveStageTask(
				runtime,
				stageState,
				task,
			);
			if (taskProgressed) {
				metrics.progressed = true;
				metrics.progressedCount += 1;
				if (wasRunning) {
					const currentTask = await findTaskByIdRepo(task.taskId).catch(
						() => null,
					);
					if (currentTask?.status === "completed") {
						metrics.completedCount += 1;
					}
				}
			}
		}
	}
	return metrics;
};

const runJobLoop = async <TPipelineContext extends PipelineContext>(
	runtime: JobRuntime<TPipelineContext>,
) => {
	if (await shouldStopForPausedScanJob(runtime)) {
		return;
	}
	await reenqueueMissingPendingTasks(runtime);
	if (await shouldStopForPausedScanJob(runtime)) {
		return;
	}
	await backfillActiveGroupQueues(runtime);
	if (await shouldStopForPausedScanJob(runtime)) {
		return;
	}
	for (const stageState of runtime.stageStates.values()) {
		await backfillStageQueue(runtime, stageState);
		if (await shouldStopForPausedScanJob(runtime)) {
			return;
		}
	}

	let loopIteration = 0;
	while (!runtime.stopRequested) {
		loopIteration += 1;
		const loopStartedAt = Date.now();
		await assertScanJobNotCancelled(runtime.ctx);
		if (await shouldStopForPausedScanJob(runtime)) {
			return;
		}
		if (runtime.failure) {
			throw runtime.failure;
		}
		const lastLoopTickLogAt =
			lastLoopTickLogAtByJob.get(runtime.ctx.scanJobId) ?? 0;
		const now = Date.now();
		if (now - lastLoopTickLogAt >= LOOP_TICK_LOG_INTERVAL_MS) {
			lastLoopTickLogAtByJob.set(runtime.ctx.scanJobId, now);
			logPipelineEvent("loop.tick", {
				scanJobId: runtime.ctx.scanJobId,
				pipelineName: runtime.pipeline.name,
			});
		}

		const statusCountsStartedAt = Date.now();
		const statusCountRows = await countTasksByScanJobStageAndStatusRepo(
			runtime.ctx.scanJobId,
		).catch(() => []);
		const statusCountsElapsedMs = Date.now() - statusCountsStartedAt;
		const statusTotals = statusCountRows.reduce(
			(acc, row) => {
				const countValue = Number(row.count || 0);
				acc.total += countValue;
				if (row.status === "pending") {
					acc.pending += countValue;
				}
					if (row.status === "launching") {
						acc.launching += countValue;
					}
					if (row.status === "launched") {
						acc.launched += countValue;
					}
					if (row.status === "starting") {
						acc.starting += countValue;
					}
					if (row.status === "running") {
						acc.running += countValue;
					}
				if (row.status === "completed") {
					acc.completed += countValue;
				}
				if (row.status === "failed") {
					acc.failed += countValue;
				}
				if (row.status === "exited") {
					acc.exited += countValue;
				}
				if (row.status === "canceled") {
					acc.canceled += countValue;
				}
				return acc;
			},
			{
				total: 0,
					pending: 0,
					launching: 0,
					launched: 0,
					starting: 0,
					running: 0,
				completed: 0,
				failed: 0,
				exited: 0,
				canceled: 0,
			},
		);

		if (runtime.stopRequested || (await shouldStopForPausedScanJob(runtime))) {
			return;
		}
		const inspectStartedAt = Date.now();
		const inspectMetrics = await inspectTasks(runtime);
		const inspectElapsedMs = Date.now() - inspectStartedAt;
		let progressed = inspectMetrics.progressed;

		if (runtime.stopRequested || (await shouldStopForPausedScanJob(runtime))) {
			return;
		}
		const reenqueueStartedAt = Date.now();
		const reenqueueCount = await reenqueueMissingPendingTasks(runtime);
		const reenqueueElapsedMs = Date.now() - reenqueueStartedAt;
		progressed = reenqueueCount > 0 || progressed;

		if (runtime.stopRequested || (await shouldStopForPausedScanJob(runtime))) {
			return;
		}
		const groupBackfillStartedAt = Date.now();
		const groupBackfillLaunchedCount = await backfillActiveGroupQueues(runtime);
		const groupBackfillElapsedMs = Date.now() - groupBackfillStartedAt;
		progressed = groupBackfillLaunchedCount > 0 || progressed;

		const stageBackfillTimings: Array<{
			stageName: string;
			elapsedMs: number;
			launchedCount: number;
		}> = [];
		let stageBackfillLaunchedCount = 0;
		for (const stageState of runtime.stageStates.values()) {
			if (runtime.stopRequested || (await shouldStopForPausedScanJob(runtime))) {
				return;
			}
			const stageBackfillStartedAt = Date.now();
			const launchedCount = await backfillStageQueue(runtime, stageState);
			const elapsedMs = Date.now() - stageBackfillStartedAt;
			stageBackfillTimings.push({
				stageName: stageState.stageName,
				elapsedMs,
				launchedCount,
			});
			stageBackfillLaunchedCount += launchedCount;
			progressed = launchedCount > 0 || progressed;
		}
		const totalLaunchedCount =
			groupBackfillLaunchedCount + stageBackfillLaunchedCount;
		if (await isJobRuntimeQuiescent(runtime)) {
			const openCount = await countOpenTasksByScanJobIdRepo(
				runtime.ctx.scanJobId,
			).catch((error) => {
				logPipelineEvent("pipeline.final_open_task_count_failed", {
					scanJobId: runtime.ctx.scanJobId,
					pipelineName: runtime.pipeline.name,
					errorMessage: getErrorMessage(error),
				});
				return null;
			});
			if (openCount === 0) {
				await refreshPipelineState(runtime.ctx).catch((error) => {
					logPipelineEvent("pipeline.final_refresh_failed", {
						scanJobId: runtime.ctx.scanJobId,
						pipelineName: runtime.pipeline.name,
						errorMessage: getErrorMessage(error),
					});
				});
				const cleanupResult = await cleanupTerminalJobRuntime(
					runtime.ctx.scanJobId,
				).catch((error) => {
					logPipelineEvent("pipeline.finished_runtime_cleanup_failed", {
						scanJobId: runtime.ctx.scanJobId,
						pipelineName: runtime.pipeline.name,
						errorMessage: getErrorMessage(error),
					});
					return null;
				});
				if (cleanupResult) {
					logPipelineEvent("pipeline.finished_runtime_cleanup", {
						scanJobId: runtime.ctx.scanJobId,
						pipelineName: runtime.pipeline.name,
						cleaned: cleanupResult.cleaned,
						reason: cleanupResult.reason,
						containerCount: cleanupResult.containerCount,
					});
				}
			}
			logPipelineEvent("loop.timing", {
				scanJobId: runtime.ctx.scanJobId,
				pipelineName: runtime.pipeline.name,
				iteration: loopIteration,
				totalElapsedMs: Date.now() - loopStartedAt,
				statusCountsElapsedMs,
				statusTotals,
				inspectTasksElapsedMs: inspectElapsedMs,
				inspectTasks: inspectMetrics,
				reenqueueMissingPendingTasksElapsedMs: reenqueueElapsedMs,
				reenqueueMissingPendingTasksCount: reenqueueCount,
				backfillActiveGroupQueuesElapsedMs: groupBackfillElapsedMs,
				backfillActiveGroupQueuesLaunchedCount: groupBackfillLaunchedCount,
				stageBackfillTimings,
				launchedCount: totalLaunchedCount,
				finalOpenTaskCount: openCount,
				progressed,
				quiescent: true,
				slept: false,
				sleepElapsedMs: 0,
			});
			return;
		}
		let slept = false;
		let sleepElapsedMs = 0;
		if (!progressed) {
			const version = runtime.wakeSignal.current();
			const sleepStartedAt = Date.now();
			await Promise.race([
				runtime.wakeSignal.wait(version),
				sleep(JOB_LOOP_IDLE_SLEEP_MS),
			]);
			slept = true;
			sleepElapsedMs = Date.now() - sleepStartedAt;
		}
		logPipelineEvent("loop.timing", {
			scanJobId: runtime.ctx.scanJobId,
			pipelineName: runtime.pipeline.name,
			iteration: loopIteration,
			totalElapsedMs: Date.now() - loopStartedAt,
			statusCountsElapsedMs,
			statusTotals,
			inspectTasksElapsedMs: inspectElapsedMs,
			inspectTasks: inspectMetrics,
			reenqueueMissingPendingTasksElapsedMs: reenqueueElapsedMs,
			reenqueueMissingPendingTasksCount: reenqueueCount,
			backfillActiveGroupQueuesElapsedMs: groupBackfillElapsedMs,
			backfillActiveGroupQueuesLaunchedCount: groupBackfillLaunchedCount,
			stageBackfillTimings,
			launchedCount: totalLaunchedCount,
			progressed,
			quiescent: false,
			slept,
			sleepElapsedMs,
		});
	}
};

const startJobRuntime = <TPipelineContext extends PipelineContext>(
	runtime: JobRuntime<TPipelineContext>,
) => {
	return (async () => {
		try {
			await runJobLoop(runtime);
			if (runtime.failure) {
				throw runtime.failure;
			}
		} catch (error) {
			handleJobRuntimeFailure(runtime, error);
		} finally {
			runtime.stopRequested = true;
			runtime.wakeSignal.notify();
			pipelineSupervisorJobs.delete(runtime.key);
		}

		if (runtime.failure) {
			throw runtime.failure;
		}
	})();
};

const ensureJobRuntime = <TPipelineContext extends PipelineContext>(
	pipeline: PipelineDefinition<TPipelineContext>,
	ctx: TPipelineContext,
): JobRuntime<TPipelineContext> => {
	const key = getJobRuntimeKey(pipeline.name, ctx.scanJobId);
	const existing = pipelineSupervisorJobs.get(key) as
		| JobRuntime<TPipelineContext>
		| undefined;
	if (existing) {
		return existing;
	}

	validatePipelineRouteConfiguration(pipeline);

	const stageStates = new Map<string, RuntimeStageState<TPipelineContext>>();
	for (const stage of pipeline.stages) {
		stageStates.set(stage.id, {
			stageName: stage.id,
			stage: stage as StageDefinition<
				TPipelineContext,
				unknown,
				unknown,
				StageContext
			>,
		});
	}

	const runtime: JobRuntime<TPipelineContext> = {
		key,
		pipeline,
		ctx,
		stageStates,
		runningStdoutSnapshots: new Map(),
		wakeSignal: new WakeSignal(),
		stopRequested: false,
		failure: null,
		completionPromise: Promise.resolve(),
	};
	runtime.completionPromise = startJobRuntime(runtime);
	pipelineSupervisorJobs.set(
		key,
		runtime as unknown as JobRuntime<PipelineContext>,
	);
	return runtime;
};

export const startPipelineRuntime = <TPipelineContext extends PipelineContext>(
	pipeline: PipelineDefinition<TPipelineContext>,
	ctx: TPipelineContext,
) => {
	const runtime = ensureJobRuntime(pipeline, ctx);
	runtime.wakeSignal.notify();
	return runtime;
};

const dispatchPipelineDownstream = async <
	TPipelineContext extends PipelineContext,
	TInput,
	TOutput,
>(
	runtime: JobRuntime<TPipelineContext>,
	stageName: string,
	fromTaskId: string,
	stageInput: TInput,
	stageOutput: TOutput,
	routeKey?: string | null,
) => {
	await assertScanJobNotCancelled(runtime.ctx);
	let effectiveRouteKey = routeKey;
	const downstreamEdges = getDownstreamEdges(runtime.pipeline, stageName);
	const routedEdges = downstreamEdges.filter((edge) => edge.route);
	if (routedEdges.length > 0) {
		const activeRoutedEdges: typeof routedEdges = [];
		for (const edge of routedEdges) {
			if (await isRuntimeStageActive(runtime, edge.to.id)) {
				activeRoutedEdges.push(edge);
			}
		}
		const selectedRouteIsActive =
			effectiveRouteKey == null
				? activeRoutedEdges.some((edge) => edge.route?.default)
				: activeRoutedEdges.some((edge) => edge.route?.key === effectiveRouteKey);
		if (!selectedRouteIsActive) {
			effectiveRouteKey = activeRoutedEdges[0]?.route?.key ?? null;
			logPipelineEvent("downstream.route.runtime_fallback", {
				scanJobId: runtime.ctx.scanJobId,
				pipelineName: runtime.pipeline.name,
				fromStageName: stageName,
				fromTaskId,
				routeKey: routeKey ?? null,
				selectedRouteKey: effectiveRouteKey,
			});
		}
	}
	const selectedDownstream = selectDownstreamEdgesForRoute(
		runtime.pipeline,
		stageName,
		effectiveRouteKey,
	);
	if (selectedDownstream.selectedRouteKey) {
		logPipelineEvent("downstream.route.selected", {
			scanJobId: runtime.ctx.scanJobId,
			pipelineName: runtime.pipeline.name,
			fromStageName: stageName,
			fromTaskId,
			routeKey: routeKey ?? null,
			selectedRouteKey: selectedDownstream.selectedRouteKey,
			edgeName: selectedDownstream.edges[0]?.name ?? null,
			toStageName: selectedDownstream.edges[0]?.to.id ?? null,
			fallback: selectedDownstream.fallback,
		});
	}
	for (const edge of selectedDownstream.edges) {
		if (!(await isRuntimeStageActive(runtime, edge.to.id))) {
			logPipelineEvent("downstream.stage_disabled", {
				scanJobId: runtime.ctx.scanJobId,
				pipelineName: runtime.pipeline.name,
				edgeName: edge.name,
				fromStageName: stageName,
				toStageName: edge.to.id,
			});
			continue;
		}
		const selectedStageOutput = edge.outputSchema
			? edge.outputSchema.parse(stageOutput)
			: stageOutput;
		const downstreamInputs = edge.transformOutput
			? await edge.transformOutput({
					ctx: runtime.ctx,
					stageInput,
					stageOutput: selectedStageOutput,
				})
			: [];
		if (downstreamInputs.length === 0) {
			logPipelineEvent("downstream.tasks.created", {
				scanJobId: runtime.ctx.scanJobId,
				pipelineName: runtime.pipeline.name,
				edgeName: edge.name,
				fromStageName: stageName,
				toStageName: edge.to.id,
				taskCount: 0,
			});
			continue;
		}
		if (!edge.createTasks) {
			continue;
		}

		const taskIds = await edge.createTasks({
			ctx: runtime.ctx,
			fromTaskId,
			stageInput,
			stageOutput: selectedStageOutput,
			nextInputObjects: downstreamInputs,
		});
		const fromTask = await findTaskByIdRepo(fromTaskId).catch(() => null);
		const fromGroup = fromTask?.stageGroupInstanceId
			? await findStageGroupInstanceByIdRepo(
					fromTask.stageGroupInstanceId,
				).catch(() => null)
			: null;
		const downstreamGroupInstanceId =
			fromGroup &&
			fromGroup.status === "active" &&
			runtime.pipeline.groups?.some(
				(group) =>
					group.name === fromGroup.groupName &&
					isStageInGroup(group, stageName) &&
					isStageInGroup(group, edge.to.id),
			)
				? fromGroup.groupInstanceId
				: null;
		if (downstreamGroupInstanceId) {
			await Promise.all(
				taskIds.map((taskId) =>
					updateTaskRepo(taskId, {
						stageGroupInstanceId: downstreamGroupInstanceId,
					}),
				),
			);
		}
		if (edge.fork) {
			await Promise.all(
				taskIds.map((taskId) =>
					updateTaskRepo(taskId, {
						runtimeMode: "fork_session",
						forkedFromTaskId: fromTaskId,
						forkedFromThreadId: fromTask?.threadId ?? null,
					}),
				),
			);
		}
		logPipelineEvent("downstream.tasks.created", {
			scanJobId: runtime.ctx.scanJobId,
			pipelineName: runtime.pipeline.name,
			edgeName: edge.name,
			fromStageName: stageName,
			toStageName: edge.to.id,
			taskCount: taskIds.length,
		});
		schedulePipelineStateRefresh(runtime.ctx);

		const downstreamStageState = runtime.stageStates.get(edge.to.id);
		const downstreamQueue = edge.to.queue;
		if (!downstreamStageState || !downstreamQueue) {
			continue;
		}

		const queueScope: StageQueueScope = {
			groupInstanceId: downstreamGroupInstanceId,
		};
		const queue = downstreamQueue.getQueue(queueScope);
		for (const taskId of taskIds) {
			await downstreamQueue.enqueue(taskId, queueScope);
			logPipelineEvent("loop.downstream_enqueued", {
				scanJobId: runtime.ctx.scanJobId,
				pipelineName: runtime.pipeline.name,
				edgeName: edge.name,
				fromStageName: stageName,
				toStageName: edge.to.id,
				taskId,
				queueName: queue.name,
				queueScope: downstreamGroupInstanceId ? "group" : "global",
				groupInstanceId: downstreamGroupInstanceId,
			});
		}
	}
};
