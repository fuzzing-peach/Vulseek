import { buildTaskAgentProfileSnapshot } from "../agent-profile-snapshot";
import { verificationSchema } from "../artifacts/contracts/domain-object.contract";
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
import { SANDBOX_AGENT_RUNTIME_FILE_NAMES } from "../runtime/sandbox-agent-shared";
import type { Candidate, FinalAnalysis, ScanJob, Verification } from "../types";
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
) => {
	const scanJob = stageInput.scanJob;
	const verifierAgentProfile = await ctx.agentProfile();
	const taskStageDirPath = await ctx.taskDir();
	const taskStageRootInContainer = await ctx.taskDirContainer();
	const taskRealRootInContainer = await ctx.taskDirRealContainer();
	const stageDirPath =
		ctx.laneIndex !== null ? await ctx.laneDir() : taskStageDirPath;
	const stageRootInContainer =
		ctx.laneIndex !== null
			? await ctx.laneDirContainer()
			: taskRealRootInContainer;
	const reportPath = `${taskStageRootInContainer}/01_verify_report.md`;
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
	const containerName = ctx.containerName(candidate.id.slice(0, 8));
	await bindTaskRuntimeRepo({
		taskId: ctx.taskId,
		containerName,
		containerIndex: ctx.containerIndex,
		agentProfile:
			buildTaskAgentProfileSnapshot(verifierAgentProfile).agentProfile,
	});
	await startContainer({
		scanJob,
		taskId: ctx.taskId,
		agentProfile: verifierAgentProfile,
		containerName,
		codexHome: `${stageRootInContainer}/.codex-verify`,
		stageDirPath,
		stageRootInContainer,
		taskRealRootInContainer,
		persistent: ctx.persistent,
		reuseContainer: ctx.reuseContainer,
		runtimeFileNames: SANDBOX_AGENT_RUNTIME_FILE_NAMES,
	});

	return await runSingleTurnAgentInContainer({
		scanJob,
		agentProfile: verifierAgentProfile,
		containerName,
		codexHome: `${stageRootInContainer}/.codex-verify`,
		stageDirPath,
		stageRootInContainer,
		taskId: ctx.taskId,
		taskStageDirPath,
		taskStageRootInContainer,
		taskRealRootInContainer,
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
			taskDirContainer: taskStageRootInContainer,
			reportPath,
			taskId: ctx.taskId,
		}),
		outputSchema: verificationSchema,
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
		run: async (ctx, stageInput) => ({
			completion: "deferred",
			threadId: (
				await executeCandidateVerificationStage(
					ctx as unknown as StageContext,
					stageInput,
				)
			).threadId,
		}),
	});
