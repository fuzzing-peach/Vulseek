import {
	analysisSchema,
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
import type {
	CriticResponse,
	FuzzBuildResult,
	FuzzRunResult,
	Candidate,
	Function,
	ScanJob,
	Module,
} from "../types";
import {
	type PipelineContext,
	resolveStageConcurrencySetting,
	type StageContext,
} from "./full-scan-stage.runtime";

export type CandidateAnalysisStageInput = {
	candidate: Candidate & {
		scanJob: ScanJob;
		module: Module & { scanJob: ScanJob };
		function: Function & {
			scanJob: ScanJob;
			module: Module & { scanJob: ScanJob };
		};
	};
	feedback?:
		| {
				kind: "fuzz_build";
				result: FuzzBuildResult;
		  }
		| {
				kind: "fuzz_run";
				result: FuzzRunResult;
		  }
		| {
				kind: "critic";
				result: CriticResponse;
		  };
};

export type CandidateAnalysisStageOutput = unknown;

type AnalysisStageContext = StageContext & {
	executionContext?: { analysisConcurrency?: number };
};

const buildCandidateAnalysisPrompt = (
	stageInput: CandidateAnalysisStageInput,
	input: {
		reportPath: string;
		taskDirContainer: string;
		taskId: string;
	},
) => {
	const { scanJob } = stageInput.candidate;

	return [
		"You are the analysis agent for one vulnerability candidate.",
		"Work only on this candidate and decide whether it is a real issue.",
		`scan_job_id: ${scanJob.scanJobId}`,
		`candidate_id: ${stageInput.candidate.id}`,
		`candidate_title: ${stageInput.candidate.title}`,
		`candidate_description: ${stageInput.candidate.description || "-"}`,
		`candidate_file: ${stageInput.candidate.filePath || "-"}`,
		`candidate_line: ${typeof stageInput.candidate.line === "number" ? stageInput.candidate.line : "-"}`,
		`task_dir: ${input.taskDirContainer}`,
		`write_report_to: ${input.reportPath}`,
		`feedback: ${stageInput.feedback ? JSON.stringify(stageInput.feedback) : "none"}`,
		"",
		"Use the installed skill named deep-analysis as your working method.",
		"Follow the coordinator workflow defined in the skill.",
		"Write every task artifact only under task_dir.",
		"Decide whether this turn should request fuzzer construction, submit a draft analysis to critic, or finalize a critic-approved analysis.",
		"The selected object type must match the selected route key.",
		"Before returning, validate the structured JSON against the runtime-provided output.schema.json.",
		`Use ${input.taskId} as the id when the selected schema has an id field.`,
		`Use ${stageInput.candidate.id} as candidateId when returning BuildFuzzerRequest.`,
		`Set reportPath to ${input.reportPath} when returning an analysis result.`,
		"Set runtimeSeconds to null if unknown.",
		"Set status to completed when the run succeeds.",
		"Route mapping:",
		"- BuildFuzzerRequest -> build_fuzzer",
		"- analysisSchema draft for critic -> critic",
		"- finalAnalysisSchema after matching critic convinced response -> verification and set output.json exit to true",
		"When returning BuildFuzzerRequest, include candidateId, analysisFingerprint, entryToCandidatePath, harnessRequirements, expectedTriggerCondition, targetFunction, targetFilePath, and notes.",
		"When returning an analysisSchema draft for critic, do not include BuildFuzzerRequest fields; return only an analysis result object that matches analysisSchema.",
		"When returning finalAnalysisSchema for verification, include analysisFingerprint and criticApproval in addition to the analysis result fields.",
		"Do not route verification unless the latest critic response is convinced for the same analysis fingerprint.",
		"Compute score as a 0-10 estimated severity score. Consider CVSS-style dimensions and real-world impact breadth, including whether the vulnerable path appears in common usage scenarios.",
		"",
		"Recommended result enum values:",
		"- real_vulnerability",
		"- likely_vulnerability",
		"- plausible_but_unproven",
		"- false_positive",
	].join("\n");
};

const executeCandidateAnalysisStage = async (
	ctx: StageContext,
	stageInput: CandidateAnalysisStageInput,
) => {
	const candidateId = stageInput.candidate.id;
	const scanJob = stageInput.candidate.scanJob;
	const analysisAgentProfile = await ctx.agentProfile();
	const taskStageDirPath = await ctx.taskDir();
	const taskStageRootInContainer = await ctx.taskDirContainer();
	const stageDirPath = ctx.persistent ? await ctx.laneDir() : taskStageDirPath;
	const stageRootInContainer = ctx.persistent
		? await ctx.laneDirContainer()
		: taskStageRootInContainer;
	const reportPath = `${taskStageRootInContainer}/01_report.md`;
	const containerName = ctx.containerName(
		candidateId.slice(0, 8),
	);
	await bindTaskRuntimeRepo({
		taskId: ctx.taskId,
		containerName,
		agentProfile: buildTaskAgentProfileSnapshot(analysisAgentProfile).agentProfile,
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
		laneThreadId: ctx.laneThreadId,
		cwd: "/workspace/repo",
		sessionMode: ctx.sessionMode,
		parentSessionId: ctx.parentSessionId,
		parentTaskId: ctx.parentTaskId,
		prompt: buildCandidateAnalysisPrompt(stageInput, {
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
	name?: string;
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
		name: input.name || "AnalysisStage",
		mode: input.mode || "fanout",
		persistent: input.persistent,
		queue: input.queue,
		getDesiredConcurrency: async (ctx) =>
			await resolveStageConcurrencySetting(
				ctx.scanJobId,
				"AnalysisStage",
				(settings) => settings.analysisConcurrency,
			),
		run: async (ctx, stageInput) =>
			({
				completion: "deferred",
				threadId: (
					await executeCandidateAnalysisStage(
						ctx as unknown as StageContext,
						stageInput,
					)
				).threadId,
			}),
	});
