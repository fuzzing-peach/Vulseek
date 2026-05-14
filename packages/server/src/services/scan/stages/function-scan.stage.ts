import { z } from "zod";
import { candidateSchema } from "../artifacts/contracts/domain-object.contract";
import type { Candidate, Function, Module, Repository, ScanJob } from "../types";
import {
	createStageDefinition,
	type StageQueueBinding,
	type StageDefinition,
	type StageOutputTextChannel,
} from "../pipeline/stage-definition";
import {
	buildFunctionScannerPrompt,
} from "../prompts/function-scanner.prompt";
import { buildTaskAgentProfileSnapshot } from "../agent-profile-snapshot";
import { bindTaskRuntimeRepo } from "../persistence/task.repo";
import {
	runSingleTurnAgentInContainer,
	startContainer,
} from "../runtime/run-single-turn-agent";
import {
	type PipelineContext,
	resolveScanProfileConcurrencySettings,
	type StageContext,
} from "./full-scan-stage.runtime";

export type FunctionScanningStageInput = {
	scanJob: ScanJob;
	repository: Repository;
	module: Module;
	function: Function;
};

export type FunctionScanningStageOutput = {
	candidates: Candidate[];
};

type FunctionStageContext = StageContext & {
	executionContext?: { fullScanFunctionConcurrency?: number };
};

const functionScanningOutputSchema = z.object({
	candidates: z.array(candidateSchema),
});

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
	const containerName = ctx.containerName(
		stageInput.function.functionId.slice(0, 24),
	);

	await bindTaskRuntimeRepo({
		taskId: ctx.taskId,
		containerName,
		agentProfile: buildTaskAgentProfileSnapshot(scanAgentProfile).agentProfile,
	});
	await startContainer({
		scanJob: stageInput.scanJob,
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
			moduleId: stageInput.module.moduleId,
			moduleName: stageInput.module.name,
			functionId: stageInput.function.functionId,
			functionName: stageInput.function.functionName,
			filePath: stageInput.function.filePath || undefined,
			line: stageInput.function.line ?? undefined,
			summary: stageInput.function.summary || undefined,
			vulnerabilityType: stageInput.function.vulnerabilityType || undefined,
			repositoryJson: JSON.stringify(stageInput.repository),
			moduleJson: JSON.stringify(stageInput.module),
			functionJson: JSON.stringify(stageInput.function),
			thinkingLevel: scanAgentProfile?.thinkingLevel || "medium",
		}),
		outputSchema: functionScanningOutputSchema,
		outputTextChannel: ctx.outputTextChannel,
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
	name?: string;
	mode?: "serial" | "fanout";
	persistent?: boolean;
	outputTextChannel?: StageOutputTextChannel;
	queue?: StageQueueBinding<TPipelineContext, FunctionScanningStageInput>;
}): StageDefinition<
	TPipelineContext,
	FunctionScanningStageInput,
	FunctionScanningStageOutput,
	FunctionStageContext
> =>
	createStageDefinition({
		name: input.name || "FunctionScanningStage",
		mode: input.mode || "fanout",
		persistent: input.persistent,
		outputTextChannel: input.outputTextChannel,
		queue: input.queue,
		getDesiredConcurrency: async (ctx) =>
			Math.max(
				1,
				(await resolveScanProfileConcurrencySettings(ctx.scanJobId))
					.fullScanFunctionConcurrency || 1,
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
