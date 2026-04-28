import path from "node:path";
import {
	validateAnalysisResultFile,
} from "../artifacts/contracts/analysis-result.contract";
import {
	type StageQueueBinding,
	type StageDefinition,
} from "../pipeline/stage-definition";
import {
	createAnalysisResultRepo,
	deleteAnalysisResultsByCandidateIdRepo,
	updateCandidateAnalysisTaskRepo,
} from "../persistence/analysis-result.repo";
import {
	updateVulnerabilityCandidateCurrentStageRepo,
	updateVulnerabilityCandidateRiskMetricsRepo,
} from "../persistence/candidate.repo";
import {
	removeContainer,
	runSingleTurnAgentInContainer,
	startContainer,
} from "../runtime/run-single-turn-agent";
import {
	syncResolvedCandidateRiskMetrics,
} from "../state/candidate-risk-metrics";
import type {
	Analysis,
	Candidate,
	Function,
	ScanJob,
	Module,
} from "../types";
import {
	resolveStageAgentProfile,
	type StageRuntimeTarget,
} from "./full-scan-stage.runtime";

export type CandidateAnalysisStageInput = {
	taskId: string;
	candidate: Candidate & {
		scanJob: ScanJob;
		module: Module & { scanJob: ScanJob };
		function: Function & {
			scanJob: ScanJob;
			module: Module & { scanJob: ScanJob };
		};
	};
};

export type CandidateAnalysisStageOutput = {
	taskId: string;
	analysis: Analysis;
};

type AnalysisStageContext = StageRuntimeTarget & {
	executionContext?: { analysisConcurrency?: number };
};

const buildCandidateAnalysisPrompt = (
	stageInput: CandidateAnalysisStageInput,
) => {
	const { scanJob } = stageInput.candidate;
	const candidateRoot = path.posix.join(
		"/scan-context",
		"jobs",
		scanJob.scanJobId,
		"candidates",
		stageInput.candidate.id,
	);
	const reportPath = `${candidateRoot}/analysis/01_report.md`;
	const resultPath = `${candidateRoot}/analysis/analysis_result.json`;

	return [
		"You are the analysis agent for one vulnerability candidate.",
		"Work only on this candidate and decide whether it is a real issue.",
		`scan_job_id: ${scanJob.scanJobId}`,
		`candidate_id: ${stageInput.candidate.id}`,
		`candidate_title: ${stageInput.candidate.title}`,
		`candidate_description: ${stageInput.candidate.description || "-"}`,
		`candidate_file: ${stageInput.candidate.filePath || "-"}`,
		`candidate_line: ${typeof stageInput.candidate.line === "number" ? stageInput.candidate.line : "-"}`,
		`write_report_to: ${reportPath}`,
		`write_result_json_to: ${resultPath}`,
		"",
		"Use the installed skill named deep-analysis as your working method.",
		"Strictly follow the fixed markdown template defined in the skill.",
		"After the report is written, write analysis_result.json as a top-level object.",
		"Required JSON fields for this run: result, score, summary.",
		"Optional JSON field: confidence.",
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
	ctx: StageRuntimeTarget,
	stageInput: CandidateAnalysisStageInput,
) => {
	const candidateId = stageInput.candidate.id;
	const scanJob = stageInput.candidate.scanJob;
	const analysisAgentProfile = await resolveStageAgentProfile(scanJob, "analysis");
	const runtimeDirHost = path.join(
		"/scan-context",
		"projects",
		ctx.projectName
			.replace(/[\\/]+/g, "-")
			.replace(/[^a-zA-Z0-9._-]/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "") || "unknown",
		"profiles",
		ctx.serviceName
			.replace(/[\\/]+/g, "-")
			.replace(/[^a-zA-Z0-9._-]/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "") || "unknown",
		"jobs",
		scanJob.scanJobId,
		"candidates",
		candidateId,
	);
	const runtimeRootInContainer = path.posix.join(
		"/scan-context",
		"jobs",
		scanJob.scanJobId,
		"candidates",
		candidateId,
	);
	const containerName = [
		ctx.projectName
			.toLowerCase()
			.replace(/[^a-z0-9_.-]/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "") || "x",
		ctx.serviceName
			.toLowerCase()
			.replace(/[^a-z0-9_.-]/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "") || "x",
		(candidateId.slice(0, 8)
			.toLowerCase()
			.replace(/[^a-z0-9_.-]/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "") || "x"),
		"analysis",
		stageInput.taskId.slice(0, 6),
	].join("-");
	await updateVulnerabilityCandidateCurrentStageRepo(candidateId, "analyzing");
	await updateCandidateAnalysisTaskRepo(stageInput.taskId, { containerName });
	await startContainer({
		scanJob,
		agentProfile: analysisAgentProfile,
		containerName,
		codexHome: `${runtimeRootInContainer}/.codex`,
		runtimeDirHost,
		runtimeRootInContainer,
	});

	try {
		return await runSingleTurnAgentInContainer({
		scanJob,
		agentProfile: analysisAgentProfile,
		containerName,
		codexHome: `${runtimeRootInContainer}/.codex`,
		runtimeDirHost,
		runtimeRootInContainer,
		cwd: "/workspace/repo",
		prompt: buildCandidateAnalysisPrompt(stageInput),
		setupMarkdownPathInContainer: `${runtimeRootInContainer}/01_setup.md`,
		setupMarkdown: [
			"# Candidate Analysis Setup",
			"",
			`- scan_job_id: ${scanJob.scanJobId}`,
			`- candidate_id: ${candidateId}`,
			`- task_id: ${stageInput.taskId}`,
			`- agent_profile: ${analysisAgentProfile?.name || analysisAgentProfile?.agentProfileId || "default"}`,
			`- agent_provider: ${analysisAgentProfile?.provider || "codex"}`,
			`- agent_model: ${analysisAgentProfile?.model || "gpt-5.4"}`,
		].join("\n"),
		onThreadId: async (threadId) => {
			await updateCandidateAnalysisTaskRepo(stageInput.taskId, { threadId });
		},
		});
	} finally {
		await removeContainer(containerName);
	}
};

const validateCandidateAnalysisOutput = async (
	ctx: StageRuntimeTarget,
	stageInput: CandidateAnalysisStageInput,
	_rawOutput: string,
): Promise<CandidateAnalysisStageOutput> => {
	const runtimeDirHost = path.join(
		"/scan-context",
		"projects",
		ctx.projectName
			.replace(/[\\/]+/g, "-")
			.replace(/[^a-zA-Z0-9._-]/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "") || "unknown",
		"profiles",
		ctx.serviceName
			.replace(/[\\/]+/g, "-")
			.replace(/[^a-zA-Z0-9._-]/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "") || "unknown",
		"jobs",
		stageInput.candidate.scanJob.scanJobId,
		"candidates",
		stageInput.candidate.id,
	);
	const payload = await validateAnalysisResultFile(
		path.join(
			runtimeDirHost,
			"analysis",
			"analysis_result.json",
		),
	);
	const result = String(payload.result);
	const summary = payload.summary;
	const candidateId = stageInput.candidate.id;
	await updateVulnerabilityCandidateCurrentStageRepo(candidateId, "analyzing");
	await deleteAnalysisResultsByCandidateIdRepo(candidateId);
	await createAnalysisResultRepo({
		scanJobId: stageInput.candidate.scanJob.scanJobId,
		vulnerabilityCandidateId: candidateId,
		result,
		confidence: payload.confidence ?? undefined,
		score: payload.score ?? undefined,
		reportPath: path.posix.join(
			"/scan-context",
			"jobs",
			stageInput.candidate.scanJob.scanJobId,
			"candidates",
			candidateId,
			"analysis",
			"01_report.md",
		),
		summary:
			summary ||
			(result === "real_vulnerability"
				? `Real vulnerability: ${stageInput.candidate.title}`
				: result === "likely_vulnerability"
					? `Likely vulnerability: ${stageInput.candidate.title}`
					: result === "false_positive"
						? `False positive: ${stageInput.candidate.title}`
						: `Plausible but unproven: ${stageInput.candidate.title}`),
	});
	await syncResolvedCandidateRiskMetrics({
		vulnerabilityCandidateId: candidateId,
		candidate: stageInput.candidate,
		latestAnalysisResult: payload,
		latestVerificationResult: null,
		updateRiskMetrics: updateVulnerabilityCandidateRiskMetricsRepo,
	});
	return {
		taskId: stageInput.taskId,
		analysis: {
			id: stageInput.taskId,
			result:
				result === "real_vulnerability" ||
				result === "likely_vulnerability" ||
				result === "plausible_but_unproven" ||
				result === "false_positive"
					? result
					: "plausible_but_unproven",
			summary:
				summary ||
				(result === "real_vulnerability"
					? `Real vulnerability: ${stageInput.candidate.title}`
					: result === "likely_vulnerability"
						? `Likely vulnerability: ${stageInput.candidate.title}`
						: result === "false_positive"
							? `False positive: ${stageInput.candidate.title}`
							: `Plausible but unproven: ${stageInput.candidate.title}`),
			confidence: payload.confidence ?? null,
			score: payload.score ?? null,
			reportPath: path.posix.join(
				"/scan-context",
				"jobs",
				stageInput.candidate.scanJob.scanJobId,
				"candidates",
				candidateId,
				"analysis",
				"01_report.md",
			),
			runtimeSeconds: null,
			status: "completed",
		},
	};
};

export const createAnalysisStageDefinition = <TContext extends AnalysisStageContext>(input: {
	name?: string;
	mode?: "serial" | "fanout";
	queue?: StageQueueBinding<TContext, CandidateAnalysisStageInput>;
	getDesiredConcurrency?: (ctx: TContext) => Promise<number>;
}): StageDefinition<
	TContext,
	CandidateAnalysisStageInput,
	CandidateAnalysisStageOutput
> => ({
	name: input.name || "AnalysisStage",
	mode: input.mode || "fanout",
	queue: input.queue,
	run: async (ctx, stageInput) =>
		(await executeCandidateAnalysisStage(ctx, stageInput)).rawOutput,
	validateOutput: async (ctx, stageInput, rawOutput) =>
		await validateCandidateAnalysisOutput(ctx, stageInput, rawOutput),
	getDesiredConcurrency:
		input.getDesiredConcurrency ||
		(async (ctx) => Math.max(1, ctx.executionContext?.analysisConcurrency || 1)),
});
