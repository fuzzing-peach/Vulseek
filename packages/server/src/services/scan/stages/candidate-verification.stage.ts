import {
	verificationSchema,
} from "../artifacts/contracts/domain-object.contract";
import {
	createStageDefinition,
	type StageQueueBinding,
	type StageDefinition,
	type StageOutputTextChannel,
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
	Analysis,
	Candidate,
	Function,
	Module,
	ScanJob,
	Verification,
} from "../types";
import {
	type PipelineContext,
	resolveScanProfileConcurrencySettings,
	type StageContext,
} from "./full-scan-stage.runtime";

export type CandidateVerificationStageInput = {
	analysisResult: Analysis & {
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
		"Your final structured result must be exactly one top-level JSON object matching output.schema.json with no wrapper keys, no prose, and no markdown fences.",
		"Before finishing, validate the final JSON against output.schema.json and follow the runtime output contract appended below.",
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
	const stageDirPath = await ctx.taskDir();
	const stageRootInContainer = await ctx.taskDirContainer();
	const reportPath = `${stageRootInContainer}/01_verify_report.md`;
	const issueDraftPath = `${stageRootInContainer}/02_issue_draft.md`;
	const pocPath = `${stageRootInContainer}/03_poc/poc.txt`;
	const dockerfilePath = `${stageRootInContainer}/04_repro/Dockerfile`;
	const runScriptPath = `${stageRootInContainer}/04_repro/run.sh`;
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
		agentProfile: verifierAgentProfile,
		containerName,
		codexHome: `${stageRootInContainer}/.codex-verify`,
		stageDirPath,
		stageRootInContainer,
		runtimeFileNames: SANDBOX_AGENT_RUNTIME_FILE_NAMES,
	});

	return await runSingleTurnAgentInContainer({
		scanJob,
		agentProfile: verifierAgentProfile,
		containerName,
		codexHome: `${stageRootInContainer}/.codex-verify`,
		stageDirPath,
		stageRootInContainer,
		runtimeFileNames: SANDBOX_AGENT_RUNTIME_FILE_NAMES,
		cwd: "/workspace/repo",
		sessionMode: ctx.sessionMode,
		parentSessionId: ctx.parentSessionId,
		parentTaskId: ctx.parentTaskId,
		prompt: buildCandidateVerificationPrompt(stageInput, {
			taskDirContainer: stageRootInContainer,
			reportPath,
			issueDraftPath,
			pocPath,
			dockerfilePath,
			runScriptPath,
			taskId: ctx.taskId,
		}),
		outputSchema: verificationSchema,
		outputTextChannel: ctx.outputTextChannel,
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
	outputTextChannel?: StageOutputTextChannel;
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
		outputTextChannel: input.outputTextChannel,
		queue: input.queue,
		getDesiredConcurrency: async (ctx) =>
			Math.max(
				1,
				(await resolveScanProfileConcurrencySettings(ctx.scanJobId))
					.verifyConcurrency || 1,
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
