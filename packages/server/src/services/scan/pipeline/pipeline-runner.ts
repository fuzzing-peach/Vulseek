import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execAsync } from "../../../utils/process/execAsync";
import { findScanJobByIdRepo } from "../persistence/scan-job.repo";
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
	markStageGroupInstanceExitedRepo,
	releaseStageLaneRuntimeRepo,
	resetClaimedStageLaneRuntimeForFreshStartRepo,
	resetStageLaneRuntimeByLaneForExitRepo,
	resetStageLaneRuntimeForExitRepo,
	type StageLaneRuntime,
} from "../persistence/stage-lane-runtime.repo";
import {
	countActiveTasksByScanJobAndStageRepo,
	findTaskByIdRepo,
	listActiveTasksByScanJobAndStageRepo,
	listTasksByScanJobIdRepo,
	transitionTaskStatusRepo,
	updateTaskRepo,
} from "../persistence/task.repo";
import { buildKnownQueueJobIdsForTask } from "../queue-job-ids";
import { removeContainer } from "../runtime/run-single-turn-agent";
import {
	hasEndTurnInJsonlContent,
	SANDBOX_AGENT_RUNTIME_FILE_NAMES,
	summarizeSandboxAgentTokenUsage,
} from "../runtime/sandbox-agent-shared";
import {
	createStageContext,
	type PipelineContext,
	type StageContext,
} from "../stages/full-scan-stage.runtime";
import { resolveStageTaskName } from "../stage-task-name";
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

const getErrorMessage = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

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
const STALE_RUNNING_TASK_GRACE_MS = 2 * 60 * 1000;
const STALE_RUNNING_STDOUT_WINDOW_MS = 10 * 60 * 1000;
const JOB_LOOP_IDLE_SLEEP_MS = 1000;

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
		statePath: path.join(taskDir, `.${runtimeBase}-state.json`),
		outputPath: path.join(taskDir, "output.json"),
	};
};

const updateTaskDefault = async (
	taskId: string,
	patch: {
		status?:
			| "pending"
			| "launching"
			| "running"
			| "completed"
			| "failed"
			| "exited";
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
					...(patch.status === "launching" || patch.status === "running"
						? {
								startedAt: new Date().toISOString(),
								completedAt: null,
							}
						: {}),
					...(patch.status === "completed" ||
					patch.status === "failed" ||
					patch.status === "exited"
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
				("route" in parsed &&
					(parsed.route === null || typeof parsed.route === "string")) &&
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
			eventCount:
				typeof parsed.eventCount === "number" ? parsed.eventCount : null,
			lastEventAgeMs:
				typeof parsed.lastEventAgeMs === "number"
					? parsed.lastEventAgeMs
					: null,
			lastEventSummary:
				parsed.lastEventSummary &&
				typeof parsed.lastEventSummary === "object"
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
			createdAt:
				typeof parsed.createdAt === "number" ? parsed.createdAt : null,
			createdAtIso:
				typeof parsed.createdAt === "number"
					? new Date(parsed.createdAt).toISOString()
					: null,
			sender: typeof parsed.sender === "string" ? parsed.sender : null,
			method: typeof payload.method === "string" ? payload.method : null,
			sessionUpdate:
				typeof update.sessionUpdate === "string"
					? update.sessionUpdate
					: null,
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

const readTaskTokenUsage = async (ctx: StageContext) => {
	const { jsonlPath } = await getTaskRuntimePaths(ctx);
	const jsonlContent = await readFileIfExists(jsonlPath);
	return summarizeSandboxAgentTokenUsage(jsonlContent)?.tokenUsage ?? null;
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
				rawBytes:
					typeof parsed.rawBytes === "number" ? parsed.rawBytes : null,
				error: typeof parsed.error === "string" ? parsed.error : null,
				failedAt:
					typeof parsed.failedAt === "string" ? parsed.failedAt : null,
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

const hasDriverCompletedWithoutEndTurn = (stderrContent: string) =>
	stderrContent.includes(
		"[sandbox-agent-driver] prompt completed without end_turn",
	);

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
		from: ["pending", "launching", "running"],
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

const isOpenTaskStatus = (status: string) =>
	status === "pending" || status === "launching" || status === "running";

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

const createStageContextForTask = <TPipelineContext extends PipelineContext>(
	runtime: JobRuntime<TPipelineContext>,
	task: {
		stageName: string;
		taskId: string;
		name: string;
		input?: unknown;
		runtimeMode?: "new_session" | "fork_session" | null;
		forkedFromTaskId?: string | null;
		forkedFromThreadId?: string | null;
	},
) => {
	const scanJobRef = hasPipelineScanJobContext(runtime.ctx)
		? runtime.ctx.scanJob
		: null;
	return createStageContext({
		base: runtime.ctx,
		stageName: task.stageName,
		scanJob: scanJobRef || {
			scanJobId: runtime.ctx.scanJobId,
			applicationId: null,
			composeId: null,
		},
		taskId: task.taskId,
		taskName: resolveStageTaskName(task.stageName, task.input) || task.name,
		persistent: false,
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

	const stageCtx = createStageContextForTask(runtime, task);
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
					lastJsonlEventIndex: lastJsonlEvent?.eventIndex ?? null,
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
		runtime.runningStdoutSnapshots.set(task.taskId, {
			hash: runtimeOutputHash,
			lastChangedAt: now,
			lastDiagnosticKey: diagnosticKey,
		});
		if (
			outputSummary.exists &&
			!hasEndTurn &&
			previousSnapshot?.lastDiagnosticKey !== diagnosticKey
		) {
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
		...(diagnostics ? { diagnostics } : {}),
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
		if (stageName === "RepositoryScanningStage") {
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
		routeOutputSchemas?: StageContext["routeOutputSchemas"];
	} | null,
) => {
	const taskId = resolveStageTaskId(stage.name, ctx, input, taskIdOverride);
	const scanJob = resolveStageScanJob(
		(input as Record<string, unknown> | null | undefined) || undefined,
		ctx,
	);
	const taskName = resolveStageTaskName(stage.name, input);
	const stageCtx = createStageContext({
		base: ctx,
		stageName: stage.name,
		scanJob,
		taskId,
		taskName,
		routeOutputSchemas: taskRuntime?.routeOutputSchemas,
		persistent: stage.persistent ?? true,
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
		("route" in record &&
			(record.route === null || typeof record.route === "string")) &&
		typeof record.exit === "boolean" &&
		"output" in record
	);
};

const stateHasEndTurn = (stateContent: string) => {
	if (!stateContent.trim()) {
		return false;
	}
	try {
		const parsed = JSON.parse(stateContent) as { endTurnReceived?: unknown };
		return parsed.endTurnReceived === true;
	} catch {
		return false;
	}
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
	] =
		await Promise.all([
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
	const hasEndTurn =
		stateHasEndTurn(stateContent) || hasEndTurnInJsonlContent(jsonlContent);
	if (hasEndTurn) {
		if (!outputContent.trim()) {
			throw new Error(`Task reached end_turn but ${outputPath} is missing or empty`);
		}
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
			throw new Error("Task output.json route must be null for non-routed stages");
		}
		return {
			rawOutput: JSON.stringify(parsed.output, null, 2),
			stderrContent,
			progressSignature,
			hasAgentOutput,
			hasExitSignal: parsed.exit,
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

const prepareStageSuccess = async <
	TPipelineContext extends PipelineContext,
	TInput,
	TOutput,
	TStageContext extends StageContext,
>(
	stage: StageDefinition<TPipelineContext, TInput, TOutput, TStageContext>,
	ctx: TPipelineContext,
	stageCtx: TStageContext,
	input: TInput,
	rawOutput: string,
) => {
	const currentTask = await findTaskByIdRepo(stageCtx.taskId).catch(() => null);
	if (
		currentTask &&
		currentTask.status !== "launching" &&
		currentTask.status !== "running"
	) {
		logPipelineEvent("stage.stale_completion_ignored", {
			scanJobId: stageCtx.scanJobId,
			stageName: stage.name,
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
		? await stage.validateOutput(stageCtx, input, rawOutput)
		: await defaultValidateOutput<TOutput>(stage.name, rawOutput);
	await updateTaskDefault(stageCtx.taskId, { output });
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
	ctx: TPipelineContext,
	stageCtx: TStageContext,
	rawOutput: string,
	options?: {
		exitLane?: boolean;
		exitReason?: "agent_exit";
		runtime?: JobRuntime<TPipelineContext>;
	},
) => {
	const currentTask = await findTaskByIdRepo(stageCtx.taskId).catch(() => null);
	if (
		currentTask &&
		currentTask.status !== "launching" &&
		currentTask.status !== "running"
	) {
		logPipelineEvent("stage.stale_completion_ignored", {
			scanJobId: stageCtx.scanJobId,
			stageName: stage.name,
			taskId: stageCtx.taskId,
			taskName: stageCtx.taskName,
			currentStatus: currentTask.status,
		});
		return false;
	}
	const tokenUsage = await readTaskTokenUsage(stageCtx).catch(() => null);
	const shouldMarkTaskExited =
		Boolean(options?.exitReason) && (await isStageGroupLeaderTask(currentTask));
	const updated = await transitionTaskStatusRepo({
		taskId: stageCtx.taskId,
		from: ["launching", "running"],
		to: shouldMarkTaskExited ? "exited" : "completed",
		patch: options?.exitReason
			? {
					exitReason: options.exitReason,
					exitNote: shouldMarkTaskExited
						? "Agent requested group leader exit"
						: "Agent requested lane exit",
					errorMessage: null,
					tokenUsage,
				}
			: { tokenUsage },
	});
	if (!updated) {
		return false;
	}
	await refreshPipelineState(ctx);
	if (stage.persistent ?? true) {
		if (options?.exitLane) {
			await cleanupPersistentLaneForTask(stageCtx.taskId, options.runtime);
		} else {
			await releasePersistentLaneForTask(stageCtx.taskId);
		}
	} else {
		await cleanupTaskContainer(stageCtx.taskId);
	}
	logPipelineEvent("loop.task_completed", {
		scanJobId: stageCtx.scanJobId,
		stageName: stage.name,
		taskId: stageCtx.taskId,
		taskName: stageCtx.taskName,
		rawOutputLength: rawOutput.length,
	});
	if (options?.exitReason) {
		logPipelineEvent("loop.task_exited", {
			scanJobId: stageCtx.scanJobId,
			stageName: stage.name,
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
		currentTask.status !== "running"
	) {
		logPipelineEvent("stage.stale_failure_ignored", {
			scanJobId: stageCtx.scanJobId,
			stageName: stage.name,
			taskId: stageCtx.taskId,
			taskName: stageCtx.taskName,
			currentStatus: currentTask.status,
			errorMessage: getErrorMessage(error),
		});
		return false;
	}
	const tokenUsage = await readTaskTokenUsage(stageCtx).catch(() => null);
	const updated = await transitionTaskStatusRepo({
		taskId: stageCtx.taskId,
		from: ["launching", "running"],
		to: "failed",
		patch: { errorMessage: getErrorMessage(error), tokenUsage },
	}).catch(() => null);
	if (!updated) {
		return false;
	}
	await refreshPipelineState(ctx).catch(() => {});
	await cleanupFailedTaskRuntime(stageCtx.taskId);
	await stage.onFailure?.(stageCtx, input, error);
	logPipelineEvent("stage.failed", {
		scanJobId: stageCtx.scanJobId,
		stageName: stage.name,
		taskId: stageCtx.taskId,
		taskName: stageCtx.taskName,
		errorMessage: getErrorMessage(error),
	});
	logPipelineEvent("loop.task_failed", {
		scanJobId: stageCtx.scanJobId,
		stageName: stage.name,
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
			resolveStageTaskId(stage.name, ctx, input, options?.taskIdOverride),
		).catch(() => null),
	);
	logPipelineEvent(options?.resumeOnly ? "stage.resume" : "stage.start", {
		scanJobId: stageCtx.scanJobId,
		stageName: stage.name,
		taskId,
		taskName,
	});
	try {
		await ensureTaskRuntimeDirectory(stageCtx);
		await assertScanJobNotCancelled(stageCtx);

		if (!options?.resumeOnly && stage.validateInput) {
			const isValid = await stage.validateInput(stageCtx, input);
			if (!isValid) {
				throw new Error(`Stage ${stage.name} rejected input ${taskId}`);
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
	const stageNames = pipeline.stages.map((stage) => stage.name);
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
			const firstStageState = runtime.stageStates.get(firstStage.name);
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
					taskId: resolveStageTaskId(firstStage.name, ctx, firstStageInput),
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
		{ hash: string; lastChangedAt: number; lastDiagnosticKey?: string }
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
	const boundMembership =
		pendingTask?.stageGroupInstanceId && (stageState.stage.persistent ?? true)
			? await findStageGroupLaneMembershipRepo({
					groupInstanceId: pendingTask.stageGroupInstanceId,
					stageName: stageState.stageName,
				}).catch(() => null)
			: null;
	const reservedLaneIndexes =
		!boundMembership && (stageState.stage.persistent ?? true)
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
		: (stageState.stage.persistent ?? true)
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
	if ((stageState.stage.persistent ?? true) && !laneRuntime) {
		await stageState.stage.queue?.enqueue(execution.taskId, queueScope).catch(() => {});
		return false;
	}
	const launched = await transitionTaskStatusRepo({
		taskId: execution.taskId,
		from: ["pending"],
		to: "launching",
	});
	if (!launched) {
		if (laneRuntime) {
			await releaseStageLaneRuntimeRepo(execution.taskId).catch(() => {});
		}
		return false;
	}

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

	if (
		laneRuntime &&
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

	const stageCtx = createTaskStageContext(
		stageState.stage,
		runtime.ctx,
		execution.input,
		execution.taskId,
		{
			...launched,
			laneRuntime,
			routeOutputSchemas: getStageRouteOutputSchemas(
				runtime.pipeline,
				stageState.stageName,
			),
		},
	).stageCtx;
	try {
		await ensureTaskRuntimeDirectory(stageCtx);
		await assertScanJobNotCancelled(stageCtx);
		if (stageState.stage.validateInput) {
			const isValid = await stageState.stage.validateInput(
				stageCtx,
				execution.input,
			);
			if (!isValid) {
				throw new Error(
					`Stage ${stageState.stage.name} rejected input ${execution.taskId}`,
				);
			}
		}

		const runResult = await stageState.stage.run(stageCtx, execution.input);
		if (runResult.completion === "immediate") {
			const output = await prepareStageSuccess(
				stageState.stage,
				runtime.ctx,
				stageCtx,
				execution.input,
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
					execution.taskId,
					execution.input,
					output,
					null,
				);
				await maybeMarkTaskStageGroupExited(execution.taskId, runtime);
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
					threadId: null,
					errorMessage: `Transient runtime launch failure; retry ${nextAttempt}/${MAX_TRANSIENT_LAUNCH_RETRIES}: ${getErrorMessage(error)}`,
				},
			});
			await stageState.stage.queue?.enqueue(execution.taskId, queueScope).catch(() => {});
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

const inspectActiveStageTask = async <TPipelineContext extends PipelineContext>(
	runtime: JobRuntime<TPipelineContext>,
	stageState: RuntimeStageState<TPipelineContext>,
	task: Awaited<ReturnType<typeof findTaskByIdRepo>>,
) => {
	const stageCtx = createStageContextForTask(runtime, task);
	const input = task.input as unknown;
	const { stdoutPath, stderrPath } = await getTaskRuntimePaths(stageCtx);
	const [stdoutContent, stderrContent] = await Promise.all([
		readFileIfExists(stdoutPath),
		readFileIfExists(stderrPath),
	]);

	if (task.status === "launching") {
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
				from: ["launching"],
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
			return true;
		}

		const exitCode = extractDriverExitCode(stderrContent);
		if (exitCode !== null) {
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
			await backfillStageQueue(runtime, stageState);
			return true;
		}

		const containerAlive = await isContainerAlive(task.containerName);
		if (!containerAlive) {
			await persistTerminalFailure(
				stageState.stage,
				runtime.ctx,
				stageCtx,
				input,
				new Error("Task runtime container stopped before reporting THREAD_ID"),
			);
			await maybeMarkTaskStageGroupExited(task.taskId, runtime);
			await backfillStageQueue(runtime, stageState);
			return true;
		}

		const halfStarted = await inspectHalfStartedRunningTask(runtime, {
			...task,
			status: "running",
		});
		if (halfStarted) {
			await persistTerminalFailure(
				stageState.stage,
				runtime.ctx,
				stageCtx,
				input,
				new Error(`Task became silently stuck: ${halfStarted.reason}`),
			);
			await maybeMarkTaskStageGroupExited(task.taskId, runtime);
			await backfillStageQueue(runtime, stageState);
			return true;
		}
		return false;
	}

	let resolvedOutput: Awaited<ReturnType<typeof resolveStageRawOutput>>;
	try {
		resolvedOutput = await resolveStageRawOutput(stageCtx);
	} catch (error) {
		await persistTerminalFailure(
			stageState.stage,
			runtime.ctx,
			stageCtx,
			input,
			error,
		);
		await maybeMarkTaskStageGroupExited(task.taskId, runtime);
		await backfillStageQueue(runtime, stageState);
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
			const output = await prepareStageSuccess(
				stageState.stage,
				runtime.ctx,
				stageCtx,
				input,
				rawOutput,
			);
			validateSelectedDownstreamOutput(
				runtime,
				stageState.stageName,
				output,
				routeKey,
			);
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
			if (terminalUpdated) {
				await backfillStageQueue(runtime, stageState);
				await dispatchPipelineDownstream(
					runtime,
					stageState.stageName,
					task.taskId,
					input,
					output,
					routeKey,
				);
				await maybeMarkTaskStageGroupExited(task.taskId, runtime);
			}
		} catch (error) {
			if (hasExitSignal) {
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
			} else {
				await persistTerminalFailure(
					stageState.stage,
					runtime.ctx,
					stageCtx,
					input,
					error,
					{ exitLane: hasExitSignal },
				);
				await maybeMarkTaskStageGroupExited(task.taskId, runtime);
			}
			await backfillStageQueue(runtime, stageState);
		}
		return true;
	}

	const exitCode = extractDriverExitCode(rawStderrContent);
	if (exitCode !== null) {
		await persistTerminalFailure(
			stageState.stage,
			runtime.ctx,
			stageCtx,
			input,
			exitCode === 0
				? new Error(
						"Sandbox agent driver exited before end_turn/output.json completion",
					)
				: new Error(`Sandbox agent driver exited with code ${exitCode}`),
			{ exitLane: hasExitSignal },
		);
		await maybeMarkTaskStageGroupExited(task.taskId, runtime);
		await backfillStageQueue(runtime, stageState);
		return true;
	}

	if (hasDriverCompletedWithoutEndTurn(rawStderrContent)) {
		await persistTerminalFailure(
			stageState.stage,
			runtime.ctx,
			stageCtx,
			input,
			new Error(
				"Sandbox agent prompt completed without end_turn",
			),
			{ exitLane: hasExitSignal },
		);
		await maybeMarkTaskStageGroupExited(task.taskId, runtime);
		await backfillStageQueue(runtime, stageState);
		return true;
	}

	const containerAlive = await isContainerAlive(task.containerName);
	if (!containerAlive) {
		await persistTerminalFailure(
			stageState.stage,
			runtime.ctx,
			stageCtx,
			input,
			new Error(
				"Task runtime container stopped before end_turn/output.json completion",
			),
		);
		await maybeMarkTaskStageGroupExited(task.taskId, runtime);
		await backfillStageQueue(runtime, stageState);
		return true;
	}

	const halfStarted = await inspectHalfStartedRunningTask(runtime, task);
	if (halfStarted) {
		await failSilentStuckTask(
			runtime,
			task,
			halfStarted.reason,
			halfStarted.diagnostics,
		);
		await backfillStageQueue(runtime, stageState);
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
	const limit = await getStageConcurrencyLimit(stageState.stage, runtime.ctx);
	let launchedAny = false;

	while (!runtime.stopRequested) {
		await assertScanJobNotCancelled(runtime.ctx);
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

		const launched = await launchStageExecution(runtime, stageState, execution, {
			logEvent: "loop.stage_backfill_spawned",
		});
		if (!launched) {
			break;
		}
		launchedAny = true;
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

	return launchedAny;
};

const resolvePendingTaskQueueScope = async (
	task: {
		taskId: string;
		stageGroupInstanceId?: string | null;
	},
): Promise<StageQueueScope | null> => {
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
	let changed = false;
	for (const task of tasks) {
		if (task.status !== "pending") {
			if (task.status !== "launching" && task.status !== "running") {
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
			knownJobIds.map((jobId) =>
				scopedQueue.getJob(jobId).catch(() => null),
			),
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
		changed = true;
	}
	return changed;
};

const backfillActiveGroupQueues = async <
	TPipelineContext extends PipelineContext,
>(
	runtime: JobRuntime<TPipelineContext>,
) => {
	const tasks = await listTasksByScanJobIdRepo(runtime.ctx.scanJobId);
	const seen = new Set<string>();
	let progressed = false;
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
		progressed =
			(await backfillStageQueue(runtime, stageState, queueScope)) || progressed;
	}
	return progressed;
};

const inspectActiveTasks = async <TPipelineContext extends PipelineContext>(
	runtime: JobRuntime<TPipelineContext>,
) => {
	let progressed = false;
	for (const stageState of runtime.stageStates.values()) {
		const activeTasks = await listActiveTasksByScanJobAndStageRepo({
			scanJobId: runtime.ctx.scanJobId,
			stageName: stageState.stageName,
		});
		for (const task of activeTasks) {
			progressed =
				(await inspectActiveStageTask(runtime, stageState, task)) || progressed;
		}
	}
	return progressed;
};

const runJobLoop = async <TPipelineContext extends PipelineContext>(
	runtime: JobRuntime<TPipelineContext>,
) => {
	await reenqueueMissingPendingTasks(runtime);
	await backfillActiveGroupQueues(runtime);
	for (const stageState of runtime.stageStates.values()) {
		await backfillStageQueue(runtime, stageState);
	}

	while (!runtime.stopRequested) {
		await assertScanJobNotCancelled(runtime.ctx);
		if (runtime.failure) {
			throw runtime.failure;
		}
		logPipelineEvent("loop.tick", {
			scanJobId: runtime.ctx.scanJobId,
			pipelineName: runtime.pipeline.name,
		});

		let progressed = await inspectActiveTasks(runtime);
		progressed = (await reenqueueMissingPendingTasks(runtime)) || progressed;
		progressed = (await backfillActiveGroupQueues(runtime)) || progressed;
		for (const stageState of runtime.stageStates.values()) {
			progressed =
				(await backfillStageQueue(runtime, stageState)) || progressed;
		}
		if (await isJobRuntimeQuiescent(runtime)) {
			return;
		}
		if (!progressed) {
			const version = runtime.wakeSignal.current();
			await Promise.race([
				runtime.wakeSignal.wait(version),
				sleep(JOB_LOOP_IDLE_SLEEP_MS),
			]);
		}
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
		stageStates.set(stage.name, {
			stageName: stage.name,
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
	const selectedDownstream = selectDownstreamEdgesForRoute(
		runtime.pipeline,
		stageName,
		routeKey,
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
			toStageName: selectedDownstream.edges[0]?.to.name ?? null,
			fallback: selectedDownstream.fallback,
		});
	}
	for (const edge of selectedDownstream.edges) {
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
					isStageInGroup(group, edge.to.name),
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
			toStageName: edge.to.name,
			taskCount: taskIds.length,
		});
		await refreshPipelineState(runtime.ctx);

		const downstreamStageState = runtime.stageStates.get(edge.to.name);
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
				toStageName: edge.to.name,
				taskId,
				queueName: queue.name,
				queueScope: downstreamGroupInstanceId ? "group" : "global",
				groupInstanceId: downstreamGroupInstanceId,
			});
		}
	}
};
