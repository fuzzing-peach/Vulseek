import { triageSchema } from "../artifacts/contracts/domain-object.contract";
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
import { SANDBOX_AGENT_RUNTIME_FILE_NAMES } from "../runtime/sandbox-agent-shared";
import type {
	Candidate,
	FinalAnalysis,
	ScanJob,
	Triage,
	Verification,
} from "../types";
import {
	launchAgentStageRuntime,
	resolveAgentStageRuntime,
} from "./agent-stage-runtime";
import {
	type PipelineContext,
	resolveStageConcurrencySetting,
	type StageContext,
} from "./full-scan-stage.runtime";

export type CandidateTriageStageInput = {
	scanJob: ScanJob;
	repositoryPath: string;
	modulePath: string;
	functionPath: string;
	candidatePath: string;
	analysisResultPath: string;
	verifyResultPath: string;
};

export type CandidateTriageStageOutput = Triage;

type TriageStageContext = StageContext & {
	executionContext?: unknown;
};

const buildCandidateTriagePrompt = (
	stageInput: CandidateTriageStageInput,
	input: {
		analysisResult: FinalAnalysis;
		verifyResult: Verification;
		candidate: Candidate;
		taskDirContainer: string;
		reportPath: string;
		taskId: string;
	},
) => {
	const { analysisResult, verifyResult, candidate } = input;

	return renderPromptTemplate(new URL("./triage.prompt.md", import.meta.url), {
		taskIsolation: NEVER_REUSE_TASK_PROMPT_LINES.join("\n"),
		scanJobId: stageInput.scanJob.scanJobId,
		candidateId: candidate.id,
		candidateTitle: candidate.title,
		candidateDescription: candidate.description || "-",
		candidateFile: candidate.filePath || "-",
		candidateLine: typeof candidate.line === "number" ? candidate.line : "-",
		analysisResult: analysisResult.result,
		analysisSummary: analysisResult.summary || "-",
		verifyResult: verifyResult.result,
		verifySummary: verifyResult.summary || "-",
		repositoryJsonPath: stageInput.repositoryPath,
		moduleJsonPath: stageInput.modulePath,
		functionJsonPath: stageInput.functionPath,
		candidateJsonPath: stageInput.candidatePath,
		analysisResultJsonPath: stageInput.analysisResultPath,
		verifyResultJsonPath: stageInput.verifyResultPath,
		taskDir: input.taskDirContainer,
		reportPath: input.reportPath,
		taskId: input.taskId,
	});
};

const executeCandidateTriageStage = async (
	ctx: StageContext,
	stageInput: CandidateTriageStageInput,
) => {
	const scanJob = stageInput.scanJob;
	const taskStageDirPath = await ctx.taskDir();
	const [candidate, analysisResult, verifyResult] = await Promise.all([
		readTaskJsonArtifact<Candidate>({
			taskDir: taskStageDirPath,
			containerPath: stageInput.candidatePath,
		}),
		readTaskJsonArtifact<FinalAnalysis>({
			taskDir: taskStageDirPath,
			containerPath: stageInput.analysisResultPath,
		}),
		readTaskJsonArtifact<Verification>({
			taskDir: taskStageDirPath,
			containerPath: stageInput.verifyResultPath,
		}),
	]);
	const runtime = await resolveAgentStageRuntime({
		ctx,
		containerNameParts: [candidate.id.slice(0, 8)],
		codexHomeName: ".codex-triage",
	});
	const reportPath = `${runtime.taskStageRootInContainer}/01_triage_report.md`;

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
		runtimeFileNames: SANDBOX_AGENT_RUNTIME_FILE_NAMES,
		cwd: "/workspace/repo",
		sessionMode: ctx.sessionMode,
		parentSessionId: ctx.parentSessionId,
		parentTaskId: ctx.parentTaskId,
		prompt: buildCandidateTriagePrompt(stageInput, {
			analysisResult,
			verifyResult,
			candidate,
			taskDirContainer: runtime.taskStageRootInContainer,
			reportPath,
			taskId: ctx.taskId,
		}),
		outputSchema: triageSchema,
		onThreadId: async (threadId) => {
			await bindTaskRuntimeRepo({ taskId: ctx.taskId, threadId });
		},
	});
};

export const createTriageStageDefinition = <
	TPipelineContext extends PipelineContext & {
		executionContext?: unknown;
	},
>(input: {
	id: string;
	name: string;
	mode?: "serial" | "fanout";
	persistent?: boolean;
	reuseContainer?: boolean;
	queue?: StageQueueBinding<TPipelineContext, CandidateTriageStageInput>;
}): StageDefinition<
	TPipelineContext,
	CandidateTriageStageInput,
	CandidateTriageStageOutput,
	TriageStageContext
> =>
	createStageDefinition({
		id: input.id,
		name: input.name,
		mode: input.mode || "fanout",
		persistent: input.persistent,
		reuseContainer: input.reuseContainer,
		queue: input.queue,
		getDesiredConcurrency: async (ctx) =>
			await resolveStageConcurrencySetting(ctx.scanJobId, input.id, () => 1),
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
				codexHomeName: ".codex-triage",
				runtimeFileNames: SANDBOX_AGENT_RUNTIME_FILE_NAMES,
			});
		},
		run: async (ctx, stageInput) => ({
			completion: "deferred",
			threadId: (
				await executeCandidateTriageStage(
					ctx as unknown as StageContext,
					stageInput,
				)
			).threadId,
		}),
	});
