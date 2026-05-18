import {
	verificationSchema,
} from "../artifacts/contracts/domain-object.contract";
import {
	createStageDefinition,
	type StageQueueBinding,
	type StageDefinition,
} from "../pipeline/stage-definition";
import {
	buildTaskAgentProfileSnapshot,
} from "../agent-profile-snapshot";
import { bindTaskRuntimeRepo } from "../persistence/task.repo";
import {
	runSingleTurnAgentInContainer,
	startContainer,
} from "../runtime/run-single-turn-agent";
import { SANDBOX_AGENT_RUNTIME_FILE_NAMES } from "../runtime/sandbox-agent-shared";
import type {
	Candidate,
	FinalAnalysis,
	Function,
	Module,
	ScanJob,
	Verification,
} from "../types";
import {
	type PipelineContext,
	resolveStageConcurrencySetting,
	type StageContext,
} from "./full-scan-stage.runtime";

export type CandidateVerificationStageInput = {
	analysisResult: FinalAnalysis & {
		scanJob: ScanJob;
		module: Module & { scanJob: ScanJob };
		function: Function & {
			scanJob: ScanJob;
			module: Module & { scanJob: ScanJob };
		};
		candidate: Candidate & {
			scanJob: ScanJob;
			module: Module & { scanJob: ScanJob };
			function: Function & {
				scanJob: ScanJob;
				module: Module & { scanJob: ScanJob };
			};
		};
	};
};

export type CandidateVerificationStageOutput = Verification;

type VerificationStageContext = StageContext & {
	executionContext?: { verifyConcurrency?: number };
};

const buildCandidateVerificationPrompt = (
	stageInput: CandidateVerificationStageInput,
	input: {
		taskDirContainer: string;
		reportPath: string;
		issueDraftPath: string;
		pocPath: string;
		dockerfilePath: string;
		runScriptPath: string;
		taskId: string;
	},
) => {
	const { analysisResult } = stageInput;
	const candidate = analysisResult.candidate;

	return [
		"You are the verifier agent for one vulnerability candidate.",
		"Work only on this candidate and validate the existing analysis result.",
		`scan_job_id: ${analysisResult.scanJob.scanJobId}`,
		`candidate_id: ${candidate.id}`,
		`candidate_title: ${candidate.title}`,
		`candidate_description: ${candidate.description || "-"}`,
		`candidate_file: ${candidate.filePath || "-"}`,
		`candidate_line: ${typeof candidate.line === "number" ? candidate.line : "-"}`,
		`analysis_result: ${analysisResult.result}`,
		`analysis_summary: ${analysisResult.summary || "-"}`,
		`analysis_fingerprint: ${analysisResult.analysisFingerprint || "-"}`,
		`critic_approval: ${analysisResult.criticApproval?.summary || "-"}`,
		`critic_task_id: ${analysisResult.criticApproval?.criticTaskId || "-"}`,
		`analysis_report_path: ${analysisResult.reportPath || "-"}`,
		`task_dir: ${input.taskDirContainer}`,
		`write_verify_report_to: ${input.reportPath}`,
		`write_issue_draft_to: ${input.issueDraftPath}`,
		`write_poc_to: ${input.pocPath}`,
		`write_repro_dockerfile_to: ${input.dockerfilePath}`,
		`write_repro_run_script_to: ${input.runScriptPath}`,
		"",
		"Use the installed skill named verify as your working method.",
		"Strictly follow the skill workflow and produce the required markdown artifacts.",
		"Write every task artifact only under task_dir.",
		"Before returning, validate the structured JSON against the runtime-provided output.schema.json.",
		`Set id to ${input.taskId}.`,
		`Set reportPath to ${input.reportPath}.`,
		`Set issueDraftPath to ${input.issueDraftPath}.`,
		`Set pocPath to ${input.pocPath}.`,
		`Set dockerfilePath to ${input.dockerfilePath}.`,
		`Set runScriptPath to ${input.runScriptPath}.`,
		"Set runtimeSeconds to null if unknown.",
		"Set status to completed when the run succeeds.",
		"Keep result aligned with the verification conclusion, not the prior analysis guess.",
	].join("\n");
};

const executeCandidateVerificationStage = async (
	ctx: StageContext,
	stageInput: CandidateVerificationStageInput,
) => {
	const candidateId = stageInput.analysisResult.candidate.id;
	const scanJob = stageInput.analysisResult.scanJob;
	const verifierAgentProfile = await ctx.agentProfile();
	const taskStageDirPath = await ctx.taskDir();
	const taskStageRootInContainer = await ctx.taskDirContainer();
	const stageDirPath = ctx.persistent ? await ctx.laneDir() : taskStageDirPath;
	const stageRootInContainer = ctx.persistent
		? await ctx.laneDirContainer()
		: taskStageRootInContainer;
	const reportPath = `${taskStageRootInContainer}/01_verify_report.md`;
	const issueDraftPath = `${taskStageRootInContainer}/02_issue_draft.md`;
	const pocPath = `${taskStageRootInContainer}/03_poc/poc.txt`;
	const dockerfilePath = `${taskStageRootInContainer}/04_repro/Dockerfile`;
	const runScriptPath = `${taskStageRootInContainer}/04_repro/run.sh`;
	const containerName = ctx.containerName(
		candidateId.slice(0, 8),
	);
	await bindTaskRuntimeRepo({
		taskId: ctx.taskId,
		containerName,
		agentProfile: buildTaskAgentProfileSnapshot(verifierAgentProfile).agentProfile,
	});
	await startContainer({
		scanJob,
		taskId: ctx.taskId,
		agentProfile: verifierAgentProfile,
		containerName,
		codexHome: `${stageRootInContainer}/.codex-verify`,
		stageDirPath,
		stageRootInContainer,
		persistent: ctx.persistent,
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
		persistent: ctx.persistent,
		laneThreadId: ctx.laneThreadId,
		runtimeFileNames: SANDBOX_AGENT_RUNTIME_FILE_NAMES,
		cwd: "/workspace/repo",
		sessionMode: ctx.sessionMode,
		parentSessionId: ctx.parentSessionId,
		parentTaskId: ctx.parentTaskId,
		prompt: buildCandidateVerificationPrompt(stageInput, {
			taskDirContainer: taskStageRootInContainer,
			reportPath,
			issueDraftPath,
			pocPath,
			dockerfilePath,
			runScriptPath,
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
		executionContext?: { verifyConcurrency?: number };
	},
>(input: {
	name?: string;
	mode?: "serial" | "fanout";
	persistent?: boolean;
	queue?: StageQueueBinding<TPipelineContext, CandidateVerificationStageInput>;
}): StageDefinition<
	TPipelineContext,
	CandidateVerificationStageInput,
	CandidateVerificationStageOutput,
	VerificationStageContext
> =>
	createStageDefinition({
		name: input.name || "VerifyingStage",
		mode: input.mode || "fanout",
		persistent: input.persistent,
		queue: input.queue,
		getDesiredConcurrency: async (ctx) =>
			await resolveStageConcurrencySetting(
				ctx.scanJobId,
				"VerifyingStage",
				(settings) => settings.verifyConcurrency,
			),
		run: async (ctx, stageInput) =>
			({
				completion: "deferred",
				threadId: (
					await executeCandidateVerificationStage(
						ctx as unknown as StageContext,
						stageInput,
					)
				).threadId,
			}),
	});
