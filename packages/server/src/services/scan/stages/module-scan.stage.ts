import {
	moduleSchema,
} from "../artifacts/contracts/domain-object.contract";
import type {
	Module,
	Repository,
	ScanJob,
} from "../types";
import {
	createStageDefinition,
	type StageQueueBinding,
	type StageDefinition,
	type StageOutputTextChannel,
} from "../pipeline/stage-definition";
import {
	buildModuleScannerPrompt,
} from "../prompts/module-scanner.prompt";
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

export type ModuleScanningStageInput = {
	scanJob: ScanJob;
	repository: Repository;
	module: Module;
};

export type ModuleScanningStageOutput = typeof moduleSchema._type;

const executeModuleScanStage = async (
	ctx: StageContext,
	stageInput: ModuleScanningStageInput,
) => {
	const scanAgentProfile = await ctx.agentProfile();
	const taskStageDirPath = await ctx.taskDir();
	const taskStageRootInContainer = await ctx.taskDirContainer();
	const stageDirPath = ctx.persistent ? await ctx.laneDir() : taskStageDirPath;
	const stageRootInContainer = ctx.persistent
		? await ctx.laneDirContainer()
		: taskStageRootInContainer;
	const containerName = ctx.containerName(
		stageInput.module.moduleId.slice(0, 24),
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
		prompt: buildModuleScannerPrompt({
			scanJobId: stageInput.scanJob.scanJobId,
			moduleId: stageInput.module.moduleId,
			moduleName: stageInput.module.name,
			repositoryJson: JSON.stringify(stageInput.repository),
			moduleJson: JSON.stringify(stageInput.module),
			thinkingLevel: scanAgentProfile?.thinkingLevel || "medium",
		}),
		outputSchema: moduleSchema,
		outputTextChannel: ctx.outputTextChannel,
		onThreadId: async (threadId) => {
			await bindTaskRuntimeRepo({ taskId: ctx.taskId, threadId });
		},
	});
};

export const createModuleScanningStageDefinition = <
	TPipelineContext extends PipelineContext & {
		executionContext?: { fullScanModuleConcurrency?: number };
	},
>(input: {
	name?: string;
	mode?: "serial" | "fanout";
	persistent?: boolean;
	outputTextChannel?: StageOutputTextChannel;
	queue?: StageQueueBinding<TPipelineContext, ModuleScanningStageInput>;
}): StageDefinition<
	TPipelineContext,
	ModuleScanningStageInput,
	ModuleScanningStageOutput,
	StageContext
> =>
	createStageDefinition({
		name: input.name || "ModuleScanningStage",
		mode: input.mode || "fanout",
		persistent: input.persistent,
		outputTextChannel: input.outputTextChannel,
		queue: input.queue,
		getDesiredConcurrency: async (ctx) =>
			Math.max(
				1,
				(await resolveScanProfileConcurrencySettings(ctx.scanJobId))
					.fullScanModuleConcurrency || 1,
			),
		run: async (ctx, stageInput) => {
			const result = await executeModuleScanStage(
				ctx as unknown as StageContext,
				stageInput,
			);
			return {
				completion: "deferred",
				threadId: result.threadId,
			};
		},
	});
