import {
	analysisSchema,
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
import type {
	Analysis,
	Candidate,
	Function,
	ScanJob,
	Module,
} from "../types";
import {
	type PipelineContext,
	resolveScanProfileConcurrencySettings,
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
};

export type CandidateAnalysisStageOutput = Analysis;

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
		"",
		"Use the installed skill named deep-analysis as your working method.",
		"Strictly follow the fixed markdown template defined in the skill.",
		"Write every task artifact only under task_dir.",
		"Your final structured result must be exactly one top-level JSON object matching output.schema.json with no wrapper keys, no prose, and no markdown fences.",
		"Before finishing, validate the final JSON against output.schema.json and follow the runtime output contract appended below.",
		`Set id to ${input.taskId}.`,
		`Set reportPath to ${input.reportPath}.`,
		"Set runtimeSeconds to null if unknown.",
		"Set status to completed when the run succeeds.",
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
		outputTextChannel: ctx.outputTextChannel,
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
	outputTextChannel?: StageOutputTextChannel;
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
		outputTextChannel: input.outputTextChannel,
		queue: input.queue,
		getDesiredConcurrency: async (ctx) =>
			Math.max(
				1,
				(await resolveScanProfileConcurrencySettings(ctx.scanJobId))
					.analysisConcurrency || 1,
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
