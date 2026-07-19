import {
	identifyTargetManifestSchema,
	targetSchema,
} from "../artifacts/contracts/domain-object.contract";
import { readTaskJsonArtifact } from "../artifacts/task-artifact-paths";
import { bindTaskRuntimeRepo } from "../persistence/task.repo";
import {
	createStageDefinition,
	type StageDefinition,
	type StageQueueBinding,
} from "../pipeline/stage-definition";
import type { StructuredOutputSchemaSource } from "../pipeline/scan-pipeline-schema-contracts";
import { NEVER_REUSE_TASK_PROMPT_LINES } from "../prompts/task-isolation.prompt";
import { runSingleTurnAgentInContainer } from "../runtime/run-single-turn-agent";
import type { IdentifyTargetManifest, ScanJob } from "../types";
import {
	launchAgentStageRuntime,
	resolveAgentStageRuntime,
	resolveStageRuntimeCwd,
	resolveStageRuntimePrompt,
	resolveStageRuntimePromptTemplate,
} from "./agent-stage-runtime";
import {
	type PipelineContext,
	resolveStageConcurrencySetting,
	type StageContext,
} from "./full-scan-stage.runtime";

export type IdentifyTargetStageInput = {
	scanJob: ScanJob;
	repositoryPath: string;
	modulePath: string;
	threatModelPath: string;
	moduleId: string;
	moduleName: string;
	priority: number | null;
	vulnerabilityClassFocus: string;
};

export type IdentifyTargetStageOutput = IdentifyTargetManifest;

const validateIdentifyTargetOutput = async (
	ctx: StageContext,
	rawOutput: string,
) => {
	const manifest = identifyTargetManifestSchema.parse(JSON.parse(rawOutput));
	const taskDir = await ctx.taskDir();
	for (const targetPath of manifest.targets) {
		targetSchema.parse(
			await readTaskJsonArtifact({
				taskDir,
				containerPath: targetPath,
			}),
		);
	}
	return manifest;
};

const executeIdentifyTargetStage = async (
	ctx: StageContext,
	stageInput: IdentifyTargetStageInput,
	outputSchema?: StructuredOutputSchemaSource,
) => {
	const runtime = await resolveAgentStageRuntime({
		ctx,
		containerNameParts: [
			stageInput.moduleId.slice(0, 16),
			stageInput.vulnerabilityClassFocus.slice(0, 16),
		],
	});
	const thinkingInstruction = runtime.agentProfile?.thinkingLevelEnabled
		? `use_reasoning_effort: ${runtime.agentProfile.thinkingLevel}`
		: "";
	const promptTemplate = await resolveStageRuntimePromptTemplate(ctx);

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
		cwd: await resolveStageRuntimeCwd(ctx),
		sessionMode: ctx.sessionMode,
		parentSessionId: ctx.parentSessionId,
		parentTaskId: ctx.parentTaskId,
		prompt: await resolveStageRuntimePrompt(ctx, promptTemplate, {
				taskIsolation: NEVER_REUSE_TASK_PROMPT_LINES.join("\n"),
				scanJobId: stageInput.scanJob.scanJobId,
				moduleId: stageInput.moduleId,
				moduleName: stageInput.moduleName,
				vulnerabilityClassFocus: stageInput.vulnerabilityClassFocus,
				repositoryJsonPath: stageInput.repositoryPath,
				moduleJsonPath: stageInput.modulePath,
				threatModelJsonPath: stageInput.threatModelPath,
				thinkingInstruction,
			}),
		outputSchema: outputSchema ?? identifyTargetManifestSchema,
		onThreadId: async (threadId) => {
			await bindTaskRuntimeRepo({ taskId: ctx.taskId, threadId });
		},
	});
};

export const createIdentifyTargetStageDefinition = <
	TPipelineContext extends PipelineContext & { executionContext?: unknown },
>(input: {
	id: string;
	name: string;
	mode?: "serial" | "fanout";
	persistent?: boolean;
	reuseContainer?: boolean;
	outputSchema?: StructuredOutputSchemaSource;
	queue?: StageQueueBinding<TPipelineContext, IdentifyTargetStageInput>;
}): StageDefinition<
	TPipelineContext,
	IdentifyTargetStageInput,
	IdentifyTargetStageOutput,
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
				containerNameParts: [
					stageInput.moduleId.slice(0, 16),
					stageInput.vulnerabilityClassFocus.slice(0, 16),
				],
			});
		},
		run: async (ctx, stageInput) => {
			const result = await executeIdentifyTargetStage(
				ctx as unknown as StageContext,
				stageInput,
				input.outputSchema,
			);
			return {
				completion: "deferred",
				threadId: result.threadId,
			};
		},
		validateOutput: async (_ctx, _stageInput, rawOutput) =>
			await validateIdentifyTargetOutput(
				_ctx as unknown as StageContext,
				rawOutput,
			),
	});
