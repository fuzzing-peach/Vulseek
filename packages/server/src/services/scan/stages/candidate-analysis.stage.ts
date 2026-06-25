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
import { runSingleTurnAgentInContainer } from "../runtime/run-single-turn-agent";
import type { Candidate, ScanJob } from "../types";
import {
	launchAgentStageRuntime,
	resolveAgentStageRuntime,
} from "./agent-stage-runtime";
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
	analysisReportTemplatePath?: string | null;
	feedbackPath?: string | null;
};

export type CandidateAnalysisStageOutput = unknown;

type AnalysisStageContext = StageContext & {
	executionContext?: unknown;
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
		analysisReportTemplatePath:
			stageInput.analysisReportTemplatePath || "none",
		feedbackJsonPath: stageInput.feedbackPath || "none",
		taskId: input.taskId,
	});
};

const executeCandidateAnalysisStage = async (
	ctx: StageContext,
	stageInput: CandidateAnalysisStageInput,
) => {
	const scanJob = stageInput.scanJob;
	const taskStageDirPath = await ctx.taskDir();
	const candidate = await readTaskJsonArtifact<Candidate>({
		taskDir: taskStageDirPath,
		containerPath: stageInput.candidatePath,
	});
	const runtime = await resolveAgentStageRuntime({
		ctx,
		containerNameParts: [candidate.id.slice(0, 8)],
	});
	const reportPath = `${runtime.taskStageRootInContainer}/01_report.md`;

	return await runSingleTurnAgentInContainer({
		scanJob,
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
		prompt: buildCandidateAnalysisPrompt(stageInput, {
			candidate,
			reportPath,
			taskDirContainer: runtime.taskStageRootInContainer,
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
		executionContext?: unknown;
	},
>(input: {
	id: string;
	name: string;
	mode?: "serial" | "fanout";
	persistent?: boolean;
	reuseContainer?: boolean;
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
			});
		},
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
