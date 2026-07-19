import { criticResponseSchema } from "../artifacts/contracts/domain-object.contract";
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
import type { Candidate } from "../types";
import {
	launchAgentStageRuntime,
	resolveAgentStageRuntime,
	resolveStageRuntimeCwd,
	resolveStageRuntimePrompt,
	resolveStageRuntimePromptTemplate,
} from "./agent-stage-runtime";
import type { AnalyzeFindingStageInput } from "./analyze-finding.stage";
import {
	type PipelineContext,
	resolveStageConcurrencySetting,
	type StageContext,
} from "./full-scan-stage.runtime";

export type CritiqueFindingStageInput = AnalyzeFindingStageInput & {
	draftAnalysisPath: string;
	analysisFingerprint: string;
};

export type CritiqueFindingStageOutput = unknown;

const executeCritiqueFindingStage = async (
	ctx: StageContext,
	stageInput: CritiqueFindingStageInput,
	outputSchema?: StructuredOutputSchemaSource,
) => {
	const taskStageDirPath = await ctx.taskDir();
	const candidate = await readTaskJsonArtifact<Candidate>({
		taskDir: taskStageDirPath,
		containerPath: stageInput.candidatePath,
	});
	const runtime = await resolveAgentStageRuntime({
		ctx,
		containerNameParts: [candidate.id.slice(0, 8)],
		codexHomeName: ".codex-critique-finding",
	});
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
			candidateId: candidate.id,
			candidateTitle: candidate.title,
			taskDir: runtime.taskStageRootInContainer,
			analysisFingerprint: stageInput.analysisFingerprint,
			candidateJsonPath: stageInput.candidatePath,
			draftAnalysisJsonPath: stageInput.draftAnalysisPath,
			taskId: ctx.taskId,
		}),
		outputSchema: outputSchema ?? criticResponseSchema,
		routeOutputSchemas: ctx.routeOutputSchemas,
		onThreadId: async (threadId) => {
			await bindTaskRuntimeRepo({ taskId: ctx.taskId, threadId });
		},
	});
};

export const createCritiqueFindingStageDefinition = <
	TPipelineContext extends PipelineContext,
>(input: {
	id: string;
	name: string;
	mode?: "serial" | "fanout";
	persistent?: boolean;
	reuseContainer?: boolean;
	outputSchema?: StructuredOutputSchemaSource;
	queue?: StageQueueBinding<TPipelineContext, CritiqueFindingStageInput>;
}): StageDefinition<
	TPipelineContext,
	CritiqueFindingStageInput,
	CritiqueFindingStageOutput,
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
			await resolveStageConcurrencySetting(ctx.scanJobId, input.id, () => 2),
		launch: async (ctx, stageInput) => {
			const taskStageDirPath = await (ctx as unknown as StageContext).taskDir();
			const candidate = await readTaskJsonArtifact<Candidate>({
				taskDir: taskStageDirPath,
				containerPath: stageInput.candidatePath,
			});
			await launchAgentStageRuntime({
				ctx: ctx as unknown as StageContext,
				scanJob: stageInput.scanJob,
				containerNameParts: [candidate.id.slice(0, 8)],
				codexHomeName: ".codex-critique-finding",
			});
		},
		run: async (ctx, stageInput) => ({
			completion: "deferred",
			threadId: (
				await executeCritiqueFindingStage(
					ctx as unknown as StageContext,
					stageInput,
					input.outputSchema,
				)
			).threadId,
		}),
	});
