import {
	criticResponseSchema,
	type Analysis,
} from "../artifacts/contracts/domain-object.contract";
import { buildTaskAgentProfileSnapshot } from "../agent-profile-snapshot";
import { bindTaskRuntimeRepo } from "../persistence/task.repo";
import {
	createStageDefinition,
	type StageDefinition,
	type StageQueueBinding,
} from "../pipeline/stage-definition";
import {
	runSingleTurnAgentInContainer,
	startContainer,
} from "../runtime/run-single-turn-agent";
import type { CandidateAnalysisStageInput } from "./candidate-analysis.stage";
import {
	type PipelineContext,
	resolveStageConcurrencySetting,
	type StageContext,
} from "./full-scan-stage.runtime";

export type AnalysisCriticStageInput = CandidateAnalysisStageInput & {
	draftAnalysis: Analysis;
	analysisFingerprint: string;
};

export type AnalysisCriticStageOutput = unknown;

const buildAnalysisCriticPrompt = (
	input: AnalysisCriticStageInput,
	paths: {
		taskDirContainer: string;
		taskId: string;
	},
) =>
	[
		"You are the critic agent for one vulnerability analysis.",
		"Use the installed skill named analysis-critic as your working method.",
		`candidate_id: ${input.candidate.id}`,
		`candidate_title: ${input.candidate.title}`,
		`task_dir: ${paths.taskDirContainer}`,
		`analysis_fingerprint: ${input.analysisFingerprint}`,
		`draft_analysis: ${JSON.stringify(input.draftAnalysis)}`,
		"",
		"Try to refute the analysis. Focus on reachability, fuzz evidence, false-positive alternatives, exploitability, and severity.",
		"If you are convinced, set stance to convinced and bind reviewedAnalysisFingerprint to the draft analysis fingerprint supplied by the analysis agent.",
		"Before returning, validate the structured JSON against the runtime-provided output.schema.json.",
		`Use ${paths.taskId} as id.`,
		"Always route back to analysis.",
	].join("\n");

const executeAnalysisCriticStage = async (
	ctx: StageContext,
	stageInput: AnalysisCriticStageInput,
) => {
	const agentProfile = await ctx.agentProfile();
	const taskStageDirPath = await ctx.taskDir();
	const taskStageRootInContainer = await ctx.taskDirContainer();
	const stageDirPath = ctx.persistent ? await ctx.laneDir() : taskStageDirPath;
	const stageRootInContainer = ctx.persistent
		? await ctx.laneDirContainer()
		: taskStageRootInContainer;
	const containerName = ctx.containerName(stageInput.candidate.id.slice(0, 8));
	await bindTaskRuntimeRepo({
		taskId: ctx.taskId,
		containerName,
		agentProfile: buildTaskAgentProfileSnapshot(agentProfile).agentProfile,
	});
	await startContainer({
		scanJob: stageInput.candidate.scanJob,
		taskId: ctx.taskId,
		agentProfile,
		containerName,
		codexHome: `${stageRootInContainer}/.codex-analysis-critic`,
		stageDirPath,
		stageRootInContainer,
		persistent: ctx.persistent,
	});

	return await runSingleTurnAgentInContainer({
		scanJob: stageInput.candidate.scanJob,
		agentProfile,
		containerName,
		codexHome: `${stageRootInContainer}/.codex-analysis-critic`,
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
		prompt: buildAnalysisCriticPrompt(stageInput, {
			taskDirContainer: taskStageRootInContainer,
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
	name?: string;
	mode?: "serial" | "fanout";
	persistent?: boolean;
	queue?: StageQueueBinding<TPipelineContext, AnalysisCriticStageInput>;
}): StageDefinition<
	TPipelineContext,
	AnalysisCriticStageInput,
	AnalysisCriticStageOutput,
	StageContext
> =>
	createStageDefinition({
		name: input.name || "AnalysisCriticStage",
		mode: input.mode || "fanout",
		persistent: input.persistent,
		queue: input.queue,
		getDesiredConcurrency: async (ctx) =>
			await resolveStageConcurrencySetting(
				ctx.scanJobId,
				"AnalysisCriticStage",
				(settings) => settings.analysisConcurrency,
			),
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
