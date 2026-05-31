import { buildTaskAgentProfileSnapshot } from "../agent-profile-snapshot";
import { analysisSchema } from "../artifacts/contracts/domain-object.contract";
import { readTaskJsonArtifact } from "../artifacts/task-artifact-paths";
import { bindTaskRuntimeRepo } from "../persistence/task.repo";
import {
	createStageDefinition,
	type StageDefinition,
	type StageQueueBinding,
} from "../pipeline/stage-definition";
import { renderPromptTemplate } from "../prompts/prompt-template";
import { NEVER_REUSE_TASK_PROMPT_LINES } from "../prompts/task-isolation.prompt";
import {
	runSingleTurnAgentInContainer,
	startContainer,
} from "../runtime/run-single-turn-agent";
import type { Candidate, ScanJob } from "../types";
import {
	type PipelineContext,
	resolveStageConcurrencySetting,
	type StageContext,
} from "./full-scan-stage.runtime";

export type CandidateAnalysisStageInput = {
	scanJob: ScanJob;
	repositoryPath: string;
	modulePath: string;
	functionPath: string;
	candidatePath: string;
	feedbackPath?: string | null;
};

export type CandidateAnalysisStageOutput = unknown;

type AnalysisStageContext = StageContext & {
	executionContext?: { analysisConcurrency?: number };
};

export const buildCandidateAnalysisPrompt = (
	stageInput: CandidateAnalysisStageInput,
	input: {
		candidate: Candidate;
		reportPath: string;
		taskDirContainer: string;
		taskId: string;
	},
) => {
	const { scanJob } = stageInput;

	return renderPromptTemplate(new URL("./analyze.prompt.md", import.meta.url), {
		taskIsolation: NEVER_REUSE_TASK_PROMPT_LINES.join("\n"),
		scanJobId: scanJob.scanJobId,
		candidateId: input.candidate.id,
		candidateTitle: input.candidate.title,
		candidateDescription: input.candidate.description || "-",
		candidateFile: input.candidate.filePath || "-",
		candidateLine:
			typeof input.candidate.line === "number" ? input.candidate.line : "-",
		taskDir: input.taskDirContainer,
		reportPath: input.reportPath,
		repositoryJsonPath: stageInput.repositoryPath,
		moduleJsonPath: stageInput.modulePath,
		functionJsonPath: stageInput.functionPath,
		candidateJsonPath: stageInput.candidatePath,
		feedbackJsonPath: stageInput.feedbackPath || "none",
		taskId: input.taskId,
	});
};

const executeCandidateAnalysisStage = async (
	ctx: StageContext,
	stageInput: CandidateAnalysisStageInput,
) => {
	const scanJob = stageInput.scanJob;
	const analysisAgentProfile = await ctx.agentProfile();
	const taskStageDirPath = await ctx.taskDir();
	const taskStageRootInContainer = await ctx.taskDirContainer();
	const stageDirPath = ctx.persistent ? await ctx.laneDir() : taskStageDirPath;
	const stageRootInContainer = ctx.persistent
		? await ctx.laneDirContainer()
		: taskStageRootInContainer;
	const reportPath = `${taskStageRootInContainer}/01_report.md`;
	const candidate = await readTaskJsonArtifact<Candidate>({
		taskDir: taskStageDirPath,
		containerPath: stageInput.candidatePath,
	});
	const containerName = ctx.containerName(candidate.id.slice(0, 8));
	await bindTaskRuntimeRepo({
		taskId: ctx.taskId,
		containerName,
		agentProfile:
			buildTaskAgentProfileSnapshot(analysisAgentProfile).agentProfile,
	});
	await startContainer({
		scanJob,
		taskId: ctx.taskId,
		agentProfile: analysisAgentProfile,
		containerName,
		codexHome: `${stageRootInContainer}/.codex`,
		stageDirPath,
		stageRootInContainer,
		persistent: ctx.persistent,
	});

	return await runSingleTurnAgentInContainer({
		scanJob,
		agentProfile: analysisAgentProfile,
		containerName,
		codexHome: `${stageRootInContainer}/.codex`,
		stageDirPath,
		stageRootInContainer,
		taskId: ctx.taskId,
		taskStageDirPath,
		taskStageRootInContainer,
		persistent: ctx.persistent,
		groupedPersistent: ctx.groupedPersistent,
		allowAgentExit: ctx.allowAgentExit,
		laneThreadId: ctx.laneThreadId,
		cwd: "/workspace/repo",
		sessionMode: ctx.sessionMode,
		parentSessionId: ctx.parentSessionId,
		parentTaskId: ctx.parentTaskId,
		prompt: buildCandidateAnalysisPrompt(stageInput, {
			candidate,
			reportPath,
			taskDirContainer: taskStageRootInContainer,
			taskId: ctx.taskId,
		}),
		outputSchema: analysisSchema,
		routeOutputSchemas: ctx.routeOutputSchemas,
		onThreadId: async (threadId) => {
			await bindTaskRuntimeRepo({ taskId: ctx.taskId, threadId });
		},
	});
};

export const createAnalysisStageDefinition = <
	TPipelineContext extends PipelineContext & {
		executionContext?: { analysisConcurrency?: number };
	},
>(input: {
	id: string;
	name: string;
	mode?: "serial" | "fanout";
	persistent?: boolean;
	queue?: StageQueueBinding<TPipelineContext, CandidateAnalysisStageInput>;
}): StageDefinition<
	TPipelineContext,
	CandidateAnalysisStageInput,
	CandidateAnalysisStageOutput,
	AnalysisStageContext
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
				(settings) => settings.analysisConcurrency,
			),
		run: async (ctx, stageInput) => ({
			completion: "deferred",
			threadId: (
				await executeCandidateAnalysisStage(
					ctx as unknown as StageContext,
					stageInput,
				)
			).threadId,
		}),
	});
