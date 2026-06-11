import { criticResponseSchema } from "../artifacts/contracts/domain-object.contract";
import { readTaskJsonArtifact } from "../artifacts/task-artifact-paths";
import { bindTaskRuntimeRepo } from "../persistence/task.repo";
import {
	createStageDefinition,
	type StageDefinition,
	type StageQueueBinding,
} from "../pipeline/stage-definition";
import { renderPromptTemplate } from "../prompts/prompt-template";
import { NEVER_REUSE_TASK_PROMPT_LINES } from "../prompts/task-isolation.prompt";
import { runSingleTurnAgentInContainer } from "../runtime/run-single-turn-agent";
import type { Candidate } from "../types";
import {
	launchAgentStageRuntime,
	resolveAgentStageRuntime,
} from "./agent-stage-runtime";
import type { CandidateAnalysisStageInput } from "./candidate-analysis.stage";
import {
	type PipelineContext,
	resolveStageConcurrencySetting,
	type StageContext,
} from "./full-scan-stage.runtime";

export type AnalysisCriticStageInput = CandidateAnalysisStageInput & {
	draftAnalysisPath: string;
	analysisFingerprint: string;
};

export type AnalysisCriticStageOutput = unknown;

const buildAnalysisCriticPrompt = (
	input: AnalysisCriticStageInput,
	paths: {
		candidate: Candidate;
		taskDirContainer: string;
		taskId: string;
	},
) =>
	renderPromptTemplate(new URL("./criticize.prompt.md", import.meta.url), {
		taskIsolation: NEVER_REUSE_TASK_PROMPT_LINES.join("\n"),
		candidateId: paths.candidate.id,
		candidateTitle: paths.candidate.title,
		taskDir: paths.taskDirContainer,
		analysisFingerprint: input.analysisFingerprint,
		candidateJsonPath: input.candidatePath,
		draftAnalysisJsonPath: input.draftAnalysisPath,
		taskId: paths.taskId,
	});

const executeAnalysisCriticStage = async (
	ctx: StageContext,
	stageInput: AnalysisCriticStageInput,
) => {
	const taskStageDirPath = await ctx.taskDir();
	const candidate = await readTaskJsonArtifact<Candidate>({
		taskDir: taskStageDirPath,
		containerPath: stageInput.candidatePath,
	});
	const runtime = await resolveAgentStageRuntime({
		ctx,
		containerNameParts: [candidate.id.slice(0, 8)],
		codexHomeName: ".codex-analysis-critic",
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
		prompt: buildAnalysisCriticPrompt(stageInput, {
			candidate,
			taskDirContainer: runtime.taskStageRootInContainer,
			taskId: ctx.taskId,
		}),
		outputSchema: criticResponseSchema,
		routeOutputSchemas: ctx.routeOutputSchemas,
		onThreadId: async (threadId) => {
			await bindTaskRuntimeRepo({ taskId: ctx.taskId, threadId });
		},
	});
};

export const createAnalysisCriticStageDefinition = <
	TPipelineContext extends PipelineContext,
>(input: {
	id: string;
	name: string;
	mode?: "serial" | "fanout";
	persistent?: boolean;
	reuseContainer?: boolean;
	queue?: StageQueueBinding<TPipelineContext, AnalysisCriticStageInput>;
}): StageDefinition<
	TPipelineContext,
	AnalysisCriticStageInput,
	AnalysisCriticStageOutput,
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
				codexHomeName: ".codex-analysis-critic",
			});
		},
		run: async (ctx, stageInput) => ({
			completion: "deferred",
			threadId: (
				await executeAnalysisCriticStage(
					ctx as unknown as StageContext,
					stageInput,
				)
			).threadId,
		}),
	});
