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
	executionContext?: { fullScanFunctionConcurrency?: number };
};

const functionScanningOutputSchema = functionScanManifestSchema;

const executeFunctionScanStage = async (
	ctx: StageContext,
	stageInput: FunctionScanningStageInput,
) => {
	const scanAgentProfile = await ctx.agentProfile();
	const taskStageDirPath = await ctx.taskDir();
	const taskStageRootInContainer = await ctx.taskDirContainer();
	const stageDirPath = ctx.persistent ? await ctx.laneDir() : taskStageDirPath;
	const stageRootInContainer = ctx.persistent
		? await ctx.laneDirContainer()
		: taskStageRootInContainer;
	const containerName = ctx.containerName(stageInput.functionId.slice(0, 24));

	await bindTaskRuntimeRepo({
		taskId: ctx.taskId,
		containerName,
		agentProfile: buildTaskAgentProfileSnapshot(scanAgentProfile).agentProfile,
	});
	await startContainer({
		scanJob: stageInput.scanJob,
		taskId: ctx.taskId,
		agentProfile: scanAgentProfile,
		containerName,
		codexHome: `${stageRootInContainer}/.codex`,
		stageDirPath,
		stageRootInContainer,
		persistent: ctx.persistent,
	});
	return await runSingleTurnAgentInContainer({
		scanJob: stageInput.scanJob,
		agentProfile: scanAgentProfile,
		containerName,
		codexHome: `${stageRootInContainer}/.codex`,
		stageDirPath,
		stageRootInContainer,
		taskId: ctx.taskId,
		taskStageDirPath,
		taskStageRootInContainer,
		persistent: ctx.persistent,
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
};

export const createFunctionScanningStageDefinition = <
	TPipelineContext extends PipelineContext & {
		executionContext?: { fullScanFunctionConcurrency?: number };
	},
>(input: {
	id: string;
	name: string;
	mode?: "serial" | "fanout";
	persistent?: boolean;
	queue?: StageQueueBinding<TPipelineContext, FunctionScanningStageInput>;
}): StageDefinition<
	TPipelineContext,
	FunctionScanningStageInput,
	FunctionScanningStageOutput,
	FunctionStageContext
> =>
	createStageDefinition({
		id: input.id,
		name: input.name,
		mode: input.mode || "fanout",
		persistent: input.persistent,
		queue: input.queue,
		getDesiredConcurrency: async (ctx) =>
			await resolveStageConcurrencySetting(
				ctx.scanJobId,
				input.id,
				(settings) => settings.fullScanFunctionConcurrency,
			),
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
