import { moduleScanManifestSchema } from "../artifacts/contracts/domain-object.contract";
import { bindTaskRuntimeRepo } from "../persistence/task.repo";
import {
	createStageDefinition,
	type StageDefinition,
	type StageQueueBinding,
} from "../pipeline/stage-definition";
import { buildModuleScannerPrompt } from "../prompts/module-scanner.prompt";
import { runSingleTurnAgentInContainer } from "../runtime/run-single-turn-agent";
import type { ModuleScanManifest, ScanJob } from "../types";
import {
	launchAgentStageRuntime,
	resolveAgentStageRuntime,
} from "./agent-stage-runtime";
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
	const runtime = await resolveAgentStageRuntime({
		ctx,
		containerNameParts: [stageInput.moduleId.slice(0, 24)],
	});
	return await runSingleTurnAgentInContainer({
		scanJob: stageInput.scanJob,
		agentProfile: runtime.agentProfile,
		containerName: runtime.containerName,
		codexHome: runtime.codexHome,
		stageDirPath: runtime.stageDirPath,
		stageRootInContainer: runtime.stageRootInContainer,
		taskId: ctx.taskId,
		taskStageDirPath: runtime.taskStageDirPath,
		taskStageRootInContainer: runtime.taskStageRootInContainer,
		taskRealRootInContainer: runtime.taskRealRootInContainer,
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
			thinkingLevel: runtime.agentProfile?.thinkingLevelEnabled
				? runtime.agentProfile.thinkingLevel
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
		launch: async (ctx, stageInput) => {
			await launchAgentStageRuntime({
				ctx: ctx as unknown as StageContext,
				scanJob: stageInput.scanJob,
				containerNameParts: [stageInput.moduleId.slice(0, 24)],
			});
		},
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
