import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import {
	findScanJobByIdRepo,
} from "../persistence/scan-job.repo";
import {
	findTaskByIdRepo,
	countActiveTasksByScanJobAndStageRepo,
	listActiveTasksByScanJobAndStageRepo,
	listTasksByScanJobIdRepo,
	transitionTaskStatusRepo,
	updateTaskRepo,
} from "../persistence/task.repo";
import {
	bindStageLaneRuntimeRepo,
	claimIdleStageLaneRuntimeRepo,
	findStageLaneRuntimeByActiveTaskIdRepo,
	releaseStageLaneRuntimeRepo,
	resetClaimedStageLaneRuntimeForFreshStartRepo,
	resetStageLaneRuntimeForExitRepo,
	type StageLaneRuntime,
} from "../persistence/stage-lane-runtime.repo";
import { execAsync } from "../../../utils/process/execAsync";
import {
	type FirstStageInputOf,
	getDownstreamEdges,
	type PipelineDefinition,
} from "./pipeline-definition";
import {
	createStageContext,
	type PipelineContext,
	type StageContext,
} from "../stages/full-scan-stage.runtime";
import {
	isFanoutStage,
	type StageExecution,
	type StageDefinition,
} from "./stage-definition";
import { removeContainer } from "../runtime/run-single-turn-agent";
import {
	extractRetFromJsonlContent,
	hasExitSignalInJsonlContent,
	SANDBOX_AGENT_RUNTIME_FILE_NAMES,
} from "../runtime/sandbox-agent-shared";
import { buildKnownQueueJobIdsForTask } from "../queue-job-ids";

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
	"scanJob" in ctx && Boolean((ctx as PipelineScanJobContext).scanJob?.scanJobId);

const refreshPipelineState = async (ctx: unknown) => {
	await (ctx as PipelineRefreshContext).refreshPipelineState?.();
};

const getErrorMessage = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

const logPipelineEvent = (
	event: string,
	details: Record<string, unknown>,
) => {
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
	if (
		scanJob &&
		scanJob.status === "canceled"
	) {
		throw new ScanJobCancelledError(ctx.scanJobId);
	}
};

const STAGE_RAW_OUTPUT_FILE_NAME = "raw-output.txt";

const persistStageRawOutput = async (
	ctx: StageContext,
	rawOutput: string,
) => {
	const stageDirPath = await ctx.taskDir();
	await fs.mkdir(stageDirPath, { recursive: true });
	await fs.writeFile(
		path.join(stageDirPath, STAGE_RAW_OUTPUT_FILE_NAME),
		rawOutput,
		"utf-8",
	);
};

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
	return {
		taskDir,
		jsonlPath: path.join(taskDir, SANDBOX_AGENT_RUNTIME_FILE_NAMES.jsonl),
		textPath: path.join(taskDir, SANDBOX_AGENT_RUNTIME_FILE_NAMES.text),
		stderrPath: path.join(taskDir, SANDBOX_AGENT_RUNTIME_FILE_NAMES.stderr),
		stdoutPath: path.join(taskDir, SANDBOX_AGENT_RUNTIME_FILE_NAMES.stdout),
	};
};

const updateTaskDefault = async (
	taskId: string,
	patch: {
		status?: "pending" | "launching" | "running" | "completed" | "failed";
		errorMessage?: string;
		containerName?: string;
		threadId?: string;
		rawOutput?: string;
		output?: unknown;
	},
) => {
	const taskPatch = {
		...(patch.containerName ? { containerName: patch.containerName } : {}),
		...(patch.threadId ? { threadId: patch.threadId } : {}),
		...(patch.rawOutput !== undefined ? { rawOutput: patch.rawOutput } : {}),
		...(patch.output !== undefined ? { output: patch.output } : {}),
		...(patch.status
			? {
					status: patch.status,
					errorMessage: patch.errorMessage,
					...(patch.status === "launching" || patch.status === "running"
						? {
								startedAt: new Date().toISOString(),
								completedAt: null,
						  }
						: {}),
					...(patch.status === "completed" || patch.status === "failed"
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

const extractDriverExitCode = (stderrContent: string) => {
	const match = stderrContent.match(/\[sandbox-agent-driver\] exit_code=(\d+)/);
	return match ? Number.parseInt(match[1] || "", 10) : null;
};

const hasDriverCompletedWithoutRet = (stderrContent: string) =>
	stderrContent.includes(
		"[sandbox-agent-driver] prompt completed without <VULSEEK_RET>",
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

const assertPathInside = (root: string, candidate: string) => {
	const relative = path.relative(root, candidate);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error(`Returned output file path is outside task directory: ${candidate}`);
	}
	return candidate;
};

const resolveReturnedOutputFilePath = async (
	ctx: StageContext,
	returnedPath: string,
) => {
	const taskDir = await ctx.taskDir();
	const taskDirContainer = await ctx.taskDirContainer();
	const trimmed = returnedPath.trim();
	const unquoted =
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
			? trimmed.slice(1, -1)
			: trimmed;

	if (!unquoted) {
		throw new Error("Returned output file path is empty");
	}

	if (unquoted === taskDirContainer || unquoted.startsWith(`${taskDirContainer}/`)) {
		const relative = path.posix.relative(taskDirContainer, unquoted);
		return assertPathInside(taskDir, path.join(taskDir, relative));
	}

	if (path.isAbsolute(unquoted)) {
		throw new Error(
			`Returned output file path must be inside task directory ${taskDirContainer}: ${unquoted}`,
		);
	}

	return assertPathInside(taskDir, path.resolve(taskDir, unquoted));
};

const readReturnedOutputFile = async (
	ctx: StageContext,
	returnedPath: string,
) => {
	const outputFilePath = await resolveReturnedOutputFilePath(ctx, returnedPath);
	try {
		return await fs.readFile(outputFilePath, "utf-8");
	} catch (error) {
		throw new Error(
			`Failed to read returned output file ${outputFilePath}: ${getErrorMessage(error)}`,
		);
	}
};

const cleanupTaskContainer = async (taskId: string) => {
	const task = await findTaskByIdRepo(taskId).catch(() => null);
	if (!task?.containerName) {
		return;
	}
	await removeContainer(task.containerName).catch(() => {});
};

const cleanupPersistentLaneForTask = async (taskId: string) => {
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
		outputTextChannel:
			runtime.stageStates.get(task.stageName)?.stage.outputTextChannel ||
			"file",
		persistent: false,
		sessionMode: task.runtimeMode === "fork_session" ? "fork" : "new",
		parentSessionId: task.forkedFromThreadId ?? null,
		parentTaskId: task.forkedFromTaskId ?? null,
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
	const { jsonlPath, textPath, stdoutPath } = await getTaskRuntimePaths(stageCtx);
	const [jsonlContent, textContent, stdoutContent] = await Promise.all([
		readFileIfExists(jsonlPath),
		readFileIfExists(textPath),
		readFileIfExists(stdoutPath),
	]);

	const now = Date.now();
	const runtimeOutputHash = sha1(
		[
			`jsonl:${jsonlContent}`,
			`text:${textContent}`,
			`stdout:${stdoutContent}`,
		].join("\n"),
	);
	const previousSnapshot = runtime.runningStdoutSnapshots.get(task.taskId);
	if (!previousSnapshot || previousSnapshot.hash !== runtimeOutputHash) {
		runtime.runningStdoutSnapshots.set(task.taskId, {
			hash: runtimeOutputHash,
			lastChangedAt: now,
		});
		return null;
	}

	if (now - previousSnapshot.lastChangedAt < STALE_RUNNING_STDOUT_WINDOW_MS) {
		return null;
	}

	return {
		reason: task.threadId ? "silent_stuck_after_start" : "silent_stuck_before_start",
	} as const;
};

const failSilentStuckTask = async <TPipelineContext extends PipelineContext>(
	runtime: JobRuntime<TPipelineContext>,
	task: Awaited<ReturnType<typeof findTaskByIdRepo>>,
	reason: string,
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

	if (task.containerName) {
		await removeContainer(task.containerName).catch(() => {});
	}
	runtime.runningStdoutSnapshots.delete(task.taskId);
	await updateTaskRepo(task.taskId, {
		status: "failed",
		errorMessage: `Task became silently stuck: ${reason}`,
		completedAt: new Date().toISOString(),
	});
	logPipelineEvent("stage.silent_stuck_failed", {
		scanJobId: runtime.ctx.scanJobId,
		pipelineName: runtime.pipeline.name,
		stageName: task.stageName,
		taskId: task.taskId,
		taskName: task.name,
		reason,
	});
	logPipelineEvent("loop.task_failed", {
		scanJobId: runtime.ctx.scanJobId,
		pipelineName: runtime.pipeline.name,
		stageName: task.stageName,
		taskId: task.taskId,
		taskName: task.name,
		errorMessage: `Task became silently stuck: ${reason}`,
	});
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

	const candidateScanJob = (record.candidate as { scanJob?: ScanJobLike } | undefined)
		?.scanJob;
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

const resolveStageTaskName = <TInput>(
	stageName: string,
	input: TInput,
): string => {
	const record =
		(input as Record<string, unknown> | null | undefined) || undefined;
	switch (stageName) {
		case "RepositoryScanningStage":
			return "repository-scanning";
		case "ModuleScanningStage":
			return typeof record?.module === "object" &&
				record.module &&
				"name" in record.module &&
				typeof record.module.name === "string"
				? record.module.name
				: "module-scanning";
		case "FunctionScanningStage":
			return typeof record?.function === "object" &&
				record.function &&
				"functionName" in record.function &&
				typeof record.function.functionName === "string"
				? record.function.functionName
				: "function-scanning";
		case "AnalysisStage":
			return typeof record?.candidate === "object" &&
				record.candidate &&
				"title" in record.candidate &&
				typeof record.candidate.title === "string"
				? record.candidate.title
				: "candidate-analysis";
		case "VerifyingStage":
			return typeof record?.analysisResult === "object" &&
				record.analysisResult &&
				"candidate" in record.analysisResult &&
				typeof record.analysisResult.candidate === "object" &&
				record.analysisResult.candidate &&
				"title" in record.analysisResult.candidate &&
				typeof record.analysisResult.candidate.title === "string"
				? record.analysisResult.candidate.title
				: "candidate-verification";
		default:
			return stageName;
	}
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
		outputTextChannel: stage.outputTextChannel || "file",
		persistent: stage.persistent ?? true,
		laneIndex: taskRuntime?.laneRuntime?.laneIndex ?? null,
		laneThreadId: taskRuntime?.laneRuntime?.threadId ?? null,
		sessionMode:
			taskRuntime?.laneRuntime?.threadId
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

const resolveStageRawOutput = async (
	ctx: StageContext,
	outputTextChannel: "response" | "file",
) => {
	const { jsonlPath, textPath, stderrPath, stdoutPath } =
		await getTaskRuntimePaths(ctx);
	const [jsonlContent, textContent, stderrContent, stdoutContent] =
		await Promise.all([
		readFileIfExists(jsonlPath),
		readFileIfExists(textPath),
		readFileIfExists(stderrPath),
		readFileIfExists(stdoutPath),
	]);
	const progressSignature = sha1(
		[jsonlContent, textContent, stderrContent, stdoutContent].join("\n"),
	);
	const hasAgentOutput =
		jsonlContent.trim().length > 0 || textContent.trim().length > 0;
	const hasExitSignal = jsonlContent
		? hasExitSignalInJsonlContent(jsonlContent)
		: textContent.includes("<VULSEEK_EXIT>");

	const jsonlRet = jsonlContent
		? extractRetFromJsonlContent(jsonlContent)
		: null;
	if (jsonlRet !== null) {
		const rawOutput =
			outputTextChannel === "file"
				? await readReturnedOutputFile(ctx, jsonlRet)
				: jsonlRet;
		return {
			rawOutput,
			stderrContent,
			progressSignature,
			hasAgentOutput,
			hasExitSignal,
		};
	}

	return {
		rawOutput: null,
		stderrContent,
		progressSignature,
		hasAgentOutput,
		hasExitSignal,
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
	await persistStageRawOutput(stageCtx, rawOutput);
	await updateTaskDefault(stageCtx.taskId, { rawOutput });
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
	options?: { exitLane?: boolean },
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
	const updated = await transitionTaskStatusRepo({
		taskId: stageCtx.taskId,
		from: ["launching", "running"],
		to: "completed",
	});
	if (!updated) {
		return false;
	}
	await refreshPipelineState(ctx);
	if (stage.persistent ?? true) {
		if (options?.exitLane) {
			await cleanupPersistentLaneForTask(stageCtx.taskId);
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
	options?: { exitLane?: boolean },
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
	const updated = await transitionTaskStatusRepo({
		taskId: stageCtx.taskId,
		from: ["launching", "running"],
		to: "failed",
		patch: { errorMessage: getErrorMessage(error) },
	}).catch(() => null);
	if (!updated) {
		return false;
	}
	await refreshPipelineState(ctx).catch(() => {});
	if (stage.persistent ?? true) {
		if (options?.exitLane) {
			await cleanupPersistentLaneForTask(stageCtx.taskId).catch(() => {});
		} else {
			await releasePersistentLaneForTask(stageCtx.taskId).catch(() => {});
		}
	} else {
		await cleanupTaskContainer(stageCtx.taskId).catch(() => {});
	}
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
		await findTaskByIdRepo(resolveStageTaskId(stage.name, ctx, input, options?.taskIdOverride))
			.catch(() => null),
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

		const output = await prepareStageSuccess(stage, ctx, stageCtx, input, rawOutput);
		return {
			taskId,
			taskName,
			stageCtx,
			output,
			rawOutput,
		};
	} catch (error) {
		throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
			stageCtx,
			taskId,
			taskName,
		});
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
		await persistTerminalSuccess(
			stage,
			ctx,
			result.stageCtx,
			result.rawOutput,
		);
		return result.output;
	} catch (error) {
		const { stageCtx } = createTaskStageContext(stage, ctx, input, taskIdOverride);
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
	runningStdoutSnapshots: Map<string, { hash: string; lastChangedAt: number }>;
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

const getJobRuntimeKey = (
	pipelineName: string,
	scanJobId: string,
) => `${pipelineName}:${scanJobId}`;

const handleJobRuntimeFailure = <TPipelineContext extends PipelineContext>(
	runtime: JobRuntime<TPipelineContext>,
	error: unknown,
) => {
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
		const counts = await queue.getJobCounts("waiting", "prioritized", "delayed");
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
	const pendingTask = await findTaskByIdRepo(execution.taskId).catch(() => null);
	let laneRuntime =
		stageState.stage.persistent ?? true
			? await claimIdleStageLaneRuntimeRepo({
					scanJobId: runtime.ctx.scanJobId,
					stageName: stageState.stageName,
					laneCount: limit,
					taskId: execution.taskId,
					forkedFromTaskId: pendingTask?.forkedFromTaskId ?? null,
					forkedFromThreadId: pendingTask?.forkedFromThreadId ?? null,
				})
			: null;
	if ((stageState.stage.persistent ?? true) && !laneRuntime) {
		await stageState.stage.queue?.enqueue(execution.taskId).catch(() => {});
		return;
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
		return;
	}

	if (
		laneRuntime &&
		laneRuntime.threadId &&
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
		{ ...launched, laneRuntime },
	).stageCtx;
	try {
		await ensureTaskRuntimeDirectory(stageCtx);
		await assertScanJobNotCancelled(stageCtx);
		if (stageState.stage.validateInput) {
			const isValid = await stageState.stage.validateInput(stageCtx, execution.input);
			if (!isValid) {
				throw new Error(`Stage ${stageState.stage.name} rejected input ${execution.taskId}`);
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
			const terminalUpdated = await persistTerminalSuccess(
				stageState.stage,
				runtime.ctx,
				stageCtx,
				runResult.rawOutput,
			);
			if (terminalUpdated) {
				await dispatchPipelineDownstream(
					runtime,
					stageState.stageName,
					execution.taskId,
					execution.input,
					output,
				);
			}
		}
	} catch (error) {
		await persistTerminalFailure(
			stageState.stage,
			runtime.ctx,
			stageCtx,
			execution.input,
			error,
		);
		await backfillStageFromQueue(runtime, stageState);
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
};

const inspectActiveStageTask = async <
	TPipelineContext extends PipelineContext,
>(
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
			await backfillStageFromQueue(runtime, stageState);
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
			await backfillStageFromQueue(runtime, stageState);
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
			await backfillStageFromQueue(runtime, stageState);
			return true;
		}
		return false;
	}

	const { rawOutput, stderrContent: rawStderrContent, hasExitSignal } =
		await resolveStageRawOutput(
			stageCtx,
			stageState.stage.outputTextChannel || "file",
		);
	if (rawOutput !== null) {
		try {
			const output = await prepareStageSuccess(
				stageState.stage,
				runtime.ctx,
				stageCtx,
				input,
				rawOutput,
			);
			const terminalUpdated = await persistTerminalSuccess(
				stageState.stage,
				runtime.ctx,
				stageCtx,
				rawOutput,
				{ exitLane: hasExitSignal },
			);
			if (terminalUpdated) {
				await backfillStageFromQueue(runtime, stageState);
				await dispatchPipelineDownstream(
					runtime,
					stageState.stageName,
					task.taskId,
					input,
					output,
				);
			}
		} catch (error) {
			await persistTerminalFailure(
				stageState.stage,
				runtime.ctx,
				stageCtx,
				input,
				error,
				{ exitLane: hasExitSignal },
			);
			await backfillStageFromQueue(runtime, stageState);
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
				? new Error("Sandbox agent driver exited without returning <VULSEEK_RET>")
				: new Error(`Sandbox agent driver exited with code ${exitCode}`),
			{ exitLane: hasExitSignal },
		);
		await backfillStageFromQueue(runtime, stageState);
		return true;
	}

	if (hasDriverCompletedWithoutRet(rawStderrContent)) {
		await persistTerminalFailure(
			stageState.stage,
			runtime.ctx,
			stageCtx,
			input,
			new Error("Sandbox agent prompt completed without returning <VULSEEK_RET>"),
			{ exitLane: hasExitSignal },
		);
		await backfillStageFromQueue(runtime, stageState);
		return true;
	}

	const containerAlive = await isContainerAlive(task.containerName);
	if (!containerAlive) {
		await persistTerminalFailure(
			stageState.stage,
			runtime.ctx,
			stageCtx,
			input,
			new Error("Task runtime container stopped before returning <VULSEEK_RET>"),
		);
		await backfillStageFromQueue(runtime, stageState);
		return true;
	}

	const halfStarted = await inspectHalfStartedRunningTask(runtime, task);
	if (halfStarted) {
		await failSilentStuckTask(runtime, task, halfStarted.reason);
		await backfillStageFromQueue(runtime, stageState);
		return true;
	}
	return false;
};

const backfillStageFromQueue = async <
	TPipelineContext extends PipelineContext,
	TInput,
	TOutput,
>(
	runtime: JobRuntime<TPipelineContext>,
	stageState: RuntimeStageState<TPipelineContext, TInput, TOutput>,
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
		const execution = await stageState.stage.queue?.poll(runtime.ctx);
		if (execution === undefined) {
			break;
		}

		launchedAny = true;
		await launchStageExecution(
			runtime,
			stageState,
			execution,
			{ logEvent: "loop.stage_backfill_spawned" },
		);
		logPipelineEvent("loop.stage_backfill_spawned", {
			scanJobId: runtime.ctx.scanJobId,
			pipelineName: runtime.pipeline.name,
			stageName: stageState.stageName,
			taskId: execution.taskId,
			concurrencyLimit: limit,
		});
	}

	return launchedAny;
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
		const knownJobIds = buildKnownQueueJobIdsForTask(queueBinding.queue, task);
		const existingJobs = await Promise.all(
			knownJobIds.map((jobId) =>
				queueBinding.queue.getJob(jobId).catch(() => null),
			),
		);
		const existingJob = existingJobs.find(Boolean);
		if (existingJob) {
			continue;
		}
		await queueBinding.enqueue(task.taskId);
		logPipelineEvent("loop.pending_task_reenqueued", {
			scanJobId: runtime.ctx.scanJobId,
			pipelineName: runtime.pipeline.name,
			stageName: task.stageName,
			taskId: task.taskId,
			taskName: task.name,
		});
		changed = true;
	}
	return changed;
};

const inspectActiveTasks = async <
	TPipelineContext extends PipelineContext,
>(
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
	for (const stageState of runtime.stageStates.values()) {
		await backfillStageFromQueue(runtime, stageState);
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
		for (const stageState of runtime.stageStates.values()) {
			progressed =
				(await backfillStageFromQueue(runtime, stageState)) || progressed;
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
	pipelineSupervisorJobs.set(key, runtime as unknown as JobRuntime<PipelineContext>);
	return runtime;
};

export const startPipelineRuntime = <
	TPipelineContext extends PipelineContext,
>(
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
) => {
	await assertScanJobNotCancelled(runtime.ctx);
	for (const edge of getDownstreamEdges(runtime.pipeline, stageName)) {
		const downstreamInputs = edge.transformOutput
			? await edge.transformOutput({
					ctx: runtime.ctx,
					stageInput,
					stageOutput,
				})
			: [];
		if (!edge.createTasks) {
			continue;
		}

		const taskIds = await edge.createTasks({
			ctx: runtime.ctx,
			fromTaskId,
			stageInput,
			stageOutput,
			nextInputObjects: downstreamInputs,
		});
		const fromTask = await findTaskByIdRepo(fromTaskId).catch(() => null);
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

		const limit = await getStageConcurrencyLimit(
			edge.to as StageDefinition<TPipelineContext, unknown, unknown, StageContext>,
			runtime.ctx,
		);
		for (const [index, taskId] of taskIds.entries()) {
			const activeCount = await countActiveTasksByScanJobAndStageRepo({
				scanJobId: runtime.ctx.scanJobId,
				stageName: downstreamStageState.stageName,
			});
			if (activeCount < limit) {
				const input = downstreamInputs[index];
				if (input === undefined) {
					continue;
				}
				await launchStageExecution(
					runtime,
					downstreamStageState as RuntimeStageState<
						TPipelineContext,
						unknown,
						unknown
					>,
					{ taskId, input },
					{ logEvent: "loop.downstream_spawned" },
				);
				logPipelineEvent("loop.downstream_spawned", {
					scanJobId: runtime.ctx.scanJobId,
					pipelineName: runtime.pipeline.name,
					edgeName: edge.name,
					fromStageName: stageName,
					toStageName: edge.to.name,
					taskId,
					activeCount,
					concurrencyLimit: limit,
				});
				continue;
			}

			await downstreamQueue.enqueue(taskId);
			logPipelineEvent("loop.downstream_enqueued", {
				scanJobId: runtime.ctx.scanJobId,
				pipelineName: runtime.pipeline.name,
				edgeName: edge.name,
				fromStageName: stageName,
				toStageName: edge.to.name,
				taskId,
				activeCount,
				concurrencyLimit: limit,
			});
		}
	}
};
