import { buildTaskAgentProfileSnapshot } from "../agent-profile-snapshot";
import { functionScanManifestSchema } from "../artifacts/contracts/domain-object.contract";
import { bindTaskRuntimeRepo } from "../persistence/task.repo";
import {
	createStageDefinition,
	type StageDefinition,
	type StageQueueBinding,
} from "../pipeline/stage-definition";
import { buildFunctionScannerPrompt } from "../prompts/function-scanner.prompt";
import {
	runSingleTurnAgentInContainer,
	startContainer,
} from "../runtime/run-single-turn-agent";
import type { FunctionScanManifest, ScanJob } from "../types";
import {
	type PipelineContext,
	resolveStageConcurrencySetting,
	type StageContext,
} from "./full-scan-stage.runtime";

export type FunctionScanningStageInput = {
	scanJob: ScanJob;
	repositoryPath: string;
	modulePath: string;
	functionPath: string;
	moduleId: string;
	moduleName: string;
	functionId: string;
	functionName: string;
	filePath?: string | null;
	line?: number | null;
	summary?: string | null;
	vulnerabilityType?: string | null;
	priority: number | null;
};

export type FunctionScanningStageOutput = FunctionScanManifest;

type FunctionStageContext = StageContext & {
	executionContext?: unknown;
};

const functionScanningOutputSchema = functionScanManifestSchema;

const executeFunctionScanStage = async (
	ctx: StageContext,
	stageInput: FunctionScanningStageInput,
) => {
	const startedAt = Date.now();
	const logTiming = (
		step: string,
		stepStartedAt: number,
		extra: Record<string, unknown> = {},
	) => {
		console.log(
			"[scan-stage]",
			JSON.stringify({
				event: "function_scan.launch_timing",
				scanJobId: stageInput.scanJob.scanJobId,
				stageName: ctx.stageName,
				taskId: ctx.taskId,
				taskName: ctx.taskName,
				functionId: stageInput.functionId,
				functionName: stageInput.functionName,
				laneIndex: ctx.laneIndex,
				containerIndex: ctx.containerIndex,
				step,
				elapsedMs: Date.now() - stepStartedAt,
				totalElapsedMs: Date.now() - startedAt,
				...extra,
			}),
		);
	};
	let stepStartedAt = Date.now();
	const scanAgentProfile = await ctx.agentProfile();
	logTiming("agent_profile", stepStartedAt, {
		provider: scanAgentProfile?.provider ?? null,
		model: scanAgentProfile?.model ?? null,
	});
	stepStartedAt = Date.now();
	const taskStageDirPath = await ctx.taskDir();
	const taskStageRootInContainer = await ctx.taskDirContainer();
	const taskRealRootInContainer = await ctx.taskDirRealContainer();
	const stageDirPath =
		ctx.laneIndex !== null ? await ctx.laneDir() : taskStageDirPath;
	const stageRootInContainer =
		ctx.laneIndex !== null
			? await ctx.laneDirContainer()
			: taskRealRootInContainer;
	const containerName = ctx.containerName(stageInput.functionId.slice(0, 24));
	logTiming("resolve_paths", stepStartedAt, {
		containerName,
		stageDirPath,
		taskStageDirPath,
	});

	stepStartedAt = Date.now();
	await bindTaskRuntimeRepo({
		taskId: ctx.taskId,
		containerName,
		containerIndex: ctx.containerIndex,
		agentProfile: buildTaskAgentProfileSnapshot(scanAgentProfile).agentProfile,
	});
	logTiming("bind_task_runtime", stepStartedAt, {
		containerName,
	});
	stepStartedAt = Date.now();
	await startContainer({
		scanJob: stageInput.scanJob,
		taskId: ctx.taskId,
		agentProfile: scanAgentProfile,
		containerName,
		codexHome: `${stageRootInContainer}/.codex`,
		stageDirPath,
		stageRootInContainer,
		taskRealRootInContainer,
		persistent: ctx.persistent,
		reuseContainer: ctx.reuseContainer,
	});
	logTiming("start_container", stepStartedAt, {
		containerName,
		persistent: ctx.persistent,
		reuseContainer: ctx.reuseContainer,
	});
	stepStartedAt = Date.now();
	const result = await runSingleTurnAgentInContainer({
		scanJob: stageInput.scanJob,
		agentProfile: scanAgentProfile,
		containerName,
		codexHome: `${stageRootInContainer}/.codex`,
		stageDirPath,
		stageRootInContainer,
		taskId: ctx.taskId,
		taskStageDirPath,
		taskStageRootInContainer,
		taskRealRootInContainer,
		persistent: ctx.persistent,
		reuseContainer: ctx.reuseContainer,
		nullableOutput: ctx.nullableOutput,
		groupedPersistent: ctx.groupedPersistent,
		allowAgentExit: ctx.allowAgentExit,
		laneThreadId: ctx.laneThreadId,
		cwd: "/workspace/repo",
		sessionMode: ctx.sessionMode,
		parentSessionId: ctx.parentSessionId,
		parentTaskId: ctx.parentTaskId,
		prompt: buildFunctionScannerPrompt({
			scanJobId: stageInput.scanJob.scanJobId,
			moduleId: stageInput.moduleId,
			moduleName: stageInput.moduleName,
			functionId: stageInput.functionId,
			functionName: stageInput.functionName,
			filePath: stageInput.filePath || undefined,
			line: stageInput.line ?? undefined,
			summary: stageInput.summary || undefined,
			vulnerabilityType: stageInput.vulnerabilityType || undefined,
			repositoryJsonPath: stageInput.repositoryPath,
			moduleJsonPath: stageInput.modulePath,
			functionJsonPath: stageInput.functionPath,
			thinkingLevel: scanAgentProfile?.thinkingLevelEnabled
				? scanAgentProfile.thinkingLevel
				: null,
		}),
		outputSchema: functionScanningOutputSchema,
		onThreadId: async (threadId) => {
			await bindTaskRuntimeRepo({ taskId: ctx.taskId, threadId });
		},
	});
	logTiming("run_single_turn_agent", stepStartedAt, {
		containerName,
		threadId: result.threadId ?? null,
	});
	return result;
};

export const createFunctionScanningStageDefinition = <
	TPipelineContext extends PipelineContext & {
		executionContext?: unknown;
	},
>(input: {
	id: string;
	name: string;
	mode?: "serial" | "fanout";
	persistent?: boolean;
	reuseContainer?: boolean;
	queue?: StageQueueBinding<TPipelineContext, FunctionScanningStageInput>;
}): StageDefinition<
	TPipelineContext,
	FunctionScanningStageInput,
	FunctionScanningStageOutput | null,
	FunctionStageContext
> =>
	createStageDefinition({
		id: input.id,
		name: input.name,
		mode: input.mode || "fanout",
		persistent: input.persistent,
		reuseContainer: input.reuseContainer,
		nullableOutput: true,
		queue: input.queue,
		getDesiredConcurrency: async (ctx) =>
			await resolveStageConcurrencySetting(ctx.scanJobId, input.id, () => 4),
		run: async (ctx, stageInput) => {
			const result = await executeFunctionScanStage(
				ctx as unknown as StageContext,
				stageInput,
			);
			return {
				completion: "deferred",
				threadId: result.threadId,
			};
		},
	});
