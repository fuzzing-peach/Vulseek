import { verificationSchema } from "../artifacts/contracts/domain-object.contract";
import { readTaskJsonArtifact } from "../artifacts/task-artifact-paths";
import { bindTaskRuntimeRepo } from "../persistence/task.repo";
import {
	createStageDefinition,
	type StageDefinition,
	type StageQueueBinding,
} from "../pipeline/stage-definition";
import type { StructuredOutputSchemaSource } from "../pipeline/scan-pipeline-schema-contracts";
import { renderPromptTemplate } from "../prompts/prompt-template";
import { NEVER_REUSE_TASK_PROMPT_LINES } from "../prompts/task-isolation.prompt";
import { runSingleTurnAgentInContainer } from "../runtime/run-single-turn-agent";
import { SANDBOX_AGENT_RUNTIME_FILE_NAMES } from "../runtime/sandbox-agent-shared";
import type { Candidate, FinalAnalysis, ScanJob, Verification } from "../types";
import {
	launchAgentStageRuntime,
	resolveAgentStageRuntime,
} from "./agent-stage-runtime";
import {
	type PipelineContext,
	resolveStageConcurrencySetting,
	type StageContext,
} from "./full-scan-stage.runtime";

export type CandidateVerificationStageInput = {
	scanJob: ScanJob;
	repositoryPath: string;
	modulePath: string;
	functionPath: string;
	candidatePath: string;
	analysisResultPath: string;
};

export type CandidateVerificationStageOutput = Verification;

type VerificationStageContext = StageContext & {
	executionContext?: unknown;
};

const buildCandidateVerificationPrompt = (
	stageInput: CandidateVerificationStageInput,
	input: {
		analysisResult: FinalAnalysis;
		candidate: Candidate;
		taskDirContainer: string;
		reportPath: string;
		taskId: string;
	},
) => {
	const { analysisResult, candidate } = input;

	return renderPromptTemplate(new URL("./verify.prompt.md", import.meta.url), {
		taskIsolation: NEVER_REUSE_TASK_PROMPT_LINES.join("\n"),
		scanJobId: stageInput.scanJob.scanJobId,
		candidateId: candidate.id,
		candidateTitle: candidate.title,
		candidateDescription: candidate.description || "-",
		candidateFile: candidate.filePath || "-",
		candidateLine: typeof candidate.line === "number" ? candidate.line : "-",
		analysisResult: analysisResult.result,
		analysisSummary: analysisResult.summary || "-",
		analysisFingerprint: analysisResult.analysisFingerprint || "-",
		criticApproval: analysisResult.criticApproval?.summary || "-",
		criticTaskId: analysisResult.criticApproval?.criticTaskId || "-",
		analysisReportPath: analysisResult.reportPath || "-",
		repositoryJsonPath: stageInput.repositoryPath,
		moduleJsonPath: stageInput.modulePath,
		functionJsonPath: stageInput.functionPath,
		candidateJsonPath: stageInput.candidatePath,
		analysisResultJsonPath: stageInput.analysisResultPath,
		taskDir: input.taskDirContainer,
		reportPath: input.reportPath,
		taskId: input.taskId,
	});
};

const executeCandidateVerificationStage = async (
	ctx: StageContext,
	stageInput: CandidateVerificationStageInput,
	outputSchema?: StructuredOutputSchemaSource,
) => {
	const scanJob = stageInput.scanJob;
	const taskStageDirPath = await ctx.taskDir();
	const [candidate, analysisResult] = await Promise.all([
		readTaskJsonArtifact<Candidate>({
			taskDir: taskStageDirPath,
			containerPath: stageInput.candidatePath,
		}),
		readTaskJsonArtifact<FinalAnalysis>({
			taskDir: taskStageDirPath,
			containerPath: stageInput.analysisResultPath,
		}),
	]);
	const runtime = await resolveAgentStageRuntime({
		ctx,
		containerNameParts: [candidate.id.slice(0, 8)],
		codexHomeName: ".codex-verify",
	});
	const reportPath = `${runtime.taskStageRootInContainer}/01_verify_report.md`;

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
		prompt: buildCandidateVerificationPrompt(stageInput, {
			analysisResult,
			candidate,
			taskDirContainer: runtime.taskStageRootInContainer,
			reportPath,
			taskId: ctx.taskId,
		}),
		outputSchema: outputSchema ?? verificationSchema,
		onThreadId: async (threadId) => {
			await bindTaskRuntimeRepo({ taskId: ctx.taskId, threadId });
		},
	});
};

export const createVerifyingStageDefinition = <
	TPipelineContext extends PipelineContext & {
		executionContext?: unknown;
	},
>(input: {
	id: string;
	name: string;
	mode?: "serial" | "fanout";
	persistent?: boolean;
	reuseContainer?: boolean;
	outputSchema?: StructuredOutputSchemaSource;
	queue?: StageQueueBinding<TPipelineContext, CandidateVerificationStageInput>;
}): StageDefinition<
	TPipelineContext,
	CandidateVerificationStageInput,
	CandidateVerificationStageOutput,
	VerificationStageContext
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
				codexHomeName: ".codex-verify",
				runtimeFileNames: SANDBOX_AGENT_RUNTIME_FILE_NAMES,
			});
		},
		run: async (ctx, stageInput) => ({
			completion: "deferred",
			threadId: (
				await executeCandidateVerificationStage(
					ctx as unknown as StageContext,
					stageInput,
					input.outputSchema,
				)
			).threadId,
		}),
	});
