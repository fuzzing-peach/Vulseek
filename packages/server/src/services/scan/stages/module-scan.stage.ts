import { buildTaskAgentProfileSnapshot } from "../agent-profile-snapshot";
import { moduleScanManifestSchema } from "../artifacts/contracts/domain-object.contract";
import { bindTaskRuntimeRepo } from "../persistence/task.repo";
import {
	createStageDefinition,
	type StageDefinition,
	type StageQueueBinding,
} from "../pipeline/stage-definition";
import { buildModuleScannerPrompt } from "../prompts/module-scanner.prompt";
import {
	runSingleTurnAgentInContainer,
	startContainer,
} from "../runtime/run-single-turn-agent";
import type { ModuleScanManifest, ScanJob } from "../types";
import {
	type PipelineContext,
	resolveStageConcurrencySetting,
	type StageContext,
} from "./full-scan-stage.runtime";

export type ModuleScanningStageInput = {
	scanJob: ScanJob;
	repositoryPath: string;
	modulePath: string;
	moduleId: string;
	moduleName: string;
	priority: number | null;
};

export type ModuleScanningStageOutput = ModuleScanManifest;

const executeModuleScanStage = async (
	ctx: StageContext,
	stageInput: ModuleScanningStageInput,
) => {
	const scanAgentProfile = await ctx.agentProfile();
	const taskStageDirPath = await ctx.taskDir();
	const taskStageRootInContainer = await ctx.taskDirContainer();
	const taskRealRootInContainer = await ctx.taskDirRealContainer();
	const stageDirPath =
		ctx.laneIndex !== null ? await ctx.laneDir() : taskStageDirPath;
	const stageRootInContainer =
		ctx.laneIndex !== null
			? await ctx.laneDirContainer()
			: taskRealRootInContainer;
	const containerName = ctx.containerName(stageInput.moduleId.slice(0, 24));

	await bindTaskRuntimeRepo({
		taskId: ctx.taskId,
		containerName,
		containerIndex: ctx.containerIndex,
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
		taskRealRootInContainer,
		persistent: ctx.persistent,
		reuseContainer: ctx.reuseContainer,
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
		taskRealRootInContainer,
		persistent: ctx.persistent,
		reuseContainer: ctx.reuseContainer,
		groupedPersistent: ctx.groupedPersistent,
		allowAgentExit: ctx.allowAgentExit,
		laneThreadId: ctx.laneThreadId,
		cwd: "/workspace/repo",
		sessionMode: ctx.sessionMode,
		parentSessionId: ctx.parentSessionId,
		parentTaskId: ctx.parentTaskId,
		prompt: buildModuleScannerPrompt({
			scanJobId: stageInput.scanJob.scanJobId,
			moduleId: stageInput.moduleId,
			moduleName: stageInput.moduleName,
			repositoryJsonPath: stageInput.repositoryPath,
			moduleJsonPath: stageInput.modulePath,
			thinkingLevel: scanAgentProfile?.thinkingLevelEnabled
				? scanAgentProfile.thinkingLevel
				: null,
		}),
		outputSchema: moduleScanManifestSchema,
		onThreadId: async (threadId) => {
			await bindTaskRuntimeRepo({ taskId: ctx.taskId, threadId });
		},
	});
};

export const createModuleScanningStageDefinition = <
	TPipelineContext extends PipelineContext & {
		executionContext?: unknown;
	},
>(input: {
	id: string;
	name: string;
	mode?: "serial" | "fanout";
	persistent?: boolean;
	reuseContainer?: boolean;
	queue?: StageQueueBinding<TPipelineContext, ModuleScanningStageInput>;
}): StageDefinition<
	TPipelineContext,
	ModuleScanningStageInput,
	ModuleScanningStageOutput,
	StageContext
> =>
	createStageDefinition({
		id: input.id,
		name: input.name,
		mode: input.mode || "fanout",
		persistent: input.persistent,
		reuseContainer: input.reuseContainer,
		queue: input.queue,
		getDesiredConcurrency: async (ctx) =>
			await resolveStageConcurrencySetting(ctx.scanJobId, input.id, () => 4),
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
