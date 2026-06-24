import { scanTargetManifestSchema } from "../artifacts/contracts/domain-object.contract";
import { bindTaskRuntimeRepo } from "../persistence/task.repo";
import {
	createStageDefinition,
	type StageDefinition,
	type StageQueueBinding,
} from "../pipeline/stage-definition";
import { buildScanTargetPrompt } from "../prompts/scan-target.prompt";
import { runSingleTurnAgentInContainer } from "../runtime/run-single-turn-agent";
import type { ScanJob, ScanTargetManifest } from "../types";
import {
	launchAgentStageRuntime,
	resolveAgentStageRuntime,
} from "./agent-stage-runtime";
import {
	type PipelineContext,
	resolveStageConcurrencySetting,
	type StageContext,
} from "./full-scan-stage.runtime";

export type ScanTargetStageInput = {
	scanJob: ScanJob;
	repositoryPath: string;
	modulePath: string;
	threatModelPath: string;
	targetPath: string;
	moduleId: string;
	moduleName: string;
	targetId: string;
	targetName: string;
	targetKind: string;
	filePath?: string | null;
	line?: number | null;
	summary?: string | null;
	priority: number | null;
};

export type ScanTargetStageOutput = ScanTargetManifest;

const executeScanTargetStage = async (
	ctx: StageContext,
	stageInput: ScanTargetStageInput,
) => {
	const runtime = await resolveAgentStageRuntime({
		ctx,
		containerNameParts: [stageInput.targetId.slice(0, 24)],
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
		nullableOutput: ctx.nullableOutput,
		groupedPersistent: ctx.groupedPersistent,
		allowAgentExit: ctx.allowAgentExit,
		laneThreadId: ctx.laneThreadId,
		cwd: "/workspace/repo",
		sessionMode: ctx.sessionMode,
		parentSessionId: ctx.parentSessionId,
		parentTaskId: ctx.parentTaskId,
		prompt: buildScanTargetPrompt({
			scanJobId: stageInput.scanJob.scanJobId,
			moduleId: stageInput.moduleId,
			moduleName: stageInput.moduleName,
			targetId: stageInput.targetId,
			targetName: stageInput.targetName,
			targetKind: stageInput.targetKind,
			filePath: stageInput.filePath || undefined,
			line: stageInput.line ?? undefined,
			summary: stageInput.summary || undefined,
			repositoryJsonPath: stageInput.repositoryPath,
			moduleJsonPath: stageInput.modulePath,
			threatModelJsonPath: stageInput.threatModelPath,
			targetJsonPath: stageInput.targetPath,
			thinkingLevel: runtime.agentProfile?.thinkingLevelEnabled
				? runtime.agentProfile.thinkingLevel
				: null,
		}),
		outputSchema: scanTargetManifestSchema,
		onThreadId: async (threadId) => {
			await bindTaskRuntimeRepo({ taskId: ctx.taskId, threadId });
		},
	});
};

export const createScanTargetStageDefinition = <
	TPipelineContext extends PipelineContext & { executionContext?: unknown },
>(input: {
	id: string;
	name: string;
	mode?: "serial" | "fanout";
	persistent?: boolean;
	reuseContainer?: boolean;
	queue?: StageQueueBinding<TPipelineContext, ScanTargetStageInput>;
}): StageDefinition<
	TPipelineContext,
	ScanTargetStageInput,
	ScanTargetStageOutput | null,
	StageContext
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
		launch: async (ctx, stageInput) => {
			await launchAgentStageRuntime({
				ctx: ctx as unknown as StageContext,
				scanJob: stageInput.scanJob,
				containerNameParts: [stageInput.targetId.slice(0, 24)],
			});
		},
		run: async (ctx, stageInput) => {
			const result = await executeScanTargetStage(
				ctx as unknown as StageContext,
				stageInput,
			);
			return {
				completion: "deferred",
				threadId: result.threadId,
			};
		},
	});
