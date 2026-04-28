import path from "node:path";
import {
	validateVerificationResultFile,
} from "../artifacts/contracts/verification-result.contract";
import {
	type StageQueueBinding,
	type StageDefinition,
} from "../pipeline/stage-definition";
import {
	createVerificationResultRepo,
	deleteVerificationResultsByCandidateIdRepo,
	updateCandidateVerificationTaskRepo,
} from "../persistence/verification-result.repo";
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
	Module,
	Verification,
	ScanJob,
} from "../types";
import {
	resolveStageAgentProfile,
	type StageRuntimeTarget,
} from "./full-scan-stage.runtime";

export type CandidateVerificationStageInput = {
	taskId: string;
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

export type CandidateVerificationStageOutput = {
	taskId: string;
	verification: Verification;
};

type VerificationStageContext = StageRuntimeTarget & {
	executionContext?: { verifyConcurrency?: number };
};

const buildCandidateVerificationPrompt = (
	stageInput: CandidateVerificationStageInput,
) => {
	const { analysisResult } = stageInput;
	const candidate = analysisResult.candidate;
	const verifyRoot = path.posix.join(
		"/scan-context",
		"jobs",
		analysisResult.scanJob.scanJobId,
		"candidates",
		candidate.id,
		"verify",
	);
	const reportPath = `${verifyRoot}/01_verify_report.md`;
	const issueDraftPath = `${verifyRoot}/02_issue_draft.md`;
	const pocPath = `${verifyRoot}/03_poc/poc.txt`;
	const dockerfilePath = `${verifyRoot}/04_repro/Dockerfile`;
	const runScriptPath = `${verifyRoot}/04_repro/run.sh`;
	const resultPath = `${verifyRoot}/verification_result.json`;

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
		`write_verify_report_to: ${reportPath}`,
		`write_issue_draft_to: ${issueDraftPath}`,
		`write_poc_to: ${pocPath}`,
		`write_repro_dockerfile_to: ${dockerfilePath}`,
		`write_repro_run_script_to: ${runScriptPath}`,
		`write_result_json_to: ${resultPath}`,
		"",
		"Use the installed skill named verify as your working method.",
		"Strictly follow the skill workflow and produce the required markdown artifacts.",
		"After finishing verification, write verification_result.json as a top-level object.",
		"Required JSON fields for this run: result, score, summary, isBug, isSecurity.",
		"Optional JSON field: confidence.",
		"Keep result aligned with the verification conclusion, not the prior analysis guess.",
	].join("\n");
};

const executeCandidateVerificationStage = async (
	ctx: StageRuntimeTarget,
	stageInput: CandidateVerificationStageInput,
) => {
	const candidateId = stageInput.analysisResult.candidate.id;
	const scanJob = stageInput.analysisResult.scanJob;
	const verifierAgentProfile = await resolveStageAgentProfile(scanJob, "verification");
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
		"verify",
		stageInput.taskId.slice(0, 6),
	].join("-");
	await updateVulnerabilityCandidateCurrentStageRepo(candidateId, "verifying");
	await updateCandidateVerificationTaskRepo(stageInput.taskId, { containerName });
	await startContainer({
		scanJob,
		agentProfile: verifierAgentProfile,
		containerName,
		codexHome: `${runtimeRootInContainer}/.codex-verify`,
		runtimeDirHost,
		runtimeRootInContainer,
		runtimeFileNames: {
			jsonl: "verify-app-server-messages.jsonl",
			text: "verify-app-server-text.log",
			stderr: "verify-app-server-stderr.log",
		},
	});

	try {
		return await runSingleTurnAgentInContainer({
		scanJob,
		agentProfile: verifierAgentProfile,
		containerName,
		codexHome: `${runtimeRootInContainer}/.codex-verify`,
		runtimeDirHost,
		runtimeRootInContainer,
		runtimeFileNames: {
			jsonl: "verify-app-server-messages.jsonl",
			text: "verify-app-server-text.log",
			stderr: "verify-app-server-stderr.log",
		},
		cwd: "/workspace/repo",
		prompt: buildCandidateVerificationPrompt(stageInput),
		setupMarkdownPathInContainer: `${runtimeRootInContainer}/verify/00_setup.md`,
		setupMarkdown: [
			"# Candidate Verification Setup",
			"",
			`- scan_job_id: ${scanJob.scanJobId}`,
			`- candidate_id: ${candidateId}`,
			`- task_id: ${stageInput.taskId}`,
			`- agent_profile: ${verifierAgentProfile?.name || verifierAgentProfile?.agentProfileId || "default"}`,
			`- agent_provider: ${verifierAgentProfile?.provider || "codex"}`,
			`- agent_model: ${verifierAgentProfile?.model || "gpt-5.4"}`,
		].join("\n"),
		onThreadId: async (threadId) => {
			await updateCandidateVerificationTaskRepo(stageInput.taskId, { threadId });
		},
		});
	} finally {
		await removeContainer(containerName);
	}
};

const validateCandidateVerificationOutput = async (
	ctx: StageRuntimeTarget,
	stageInput: CandidateVerificationStageInput,
	_rawOutput: string,
): Promise<CandidateVerificationStageOutput> => {
	const candidateId = stageInput.analysisResult.candidate.id;
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
		stageInput.analysisResult.scanJob.scanJobId,
		"candidates",
		candidateId,
	);
	const payload = await validateVerificationResultFile(
		path.join(
			runtimeDirHost,
			"verify",
			"verification_result.json",
		),
	);
	const result = String(payload.result);
	const verifyRoot = path.posix.join(
		"/scan-context",
		"jobs",
		stageInput.analysisResult.scanJob.scanJobId,
		"candidates",
		candidateId,
		"verify",
	);
	await updateVulnerabilityCandidateCurrentStageRepo(candidateId, "verifying");
	await deleteVerificationResultsByCandidateIdRepo(candidateId);
	await createVerificationResultRepo({
		scanJobId: stageInput.analysisResult.scanJob.scanJobId,
		vulnerabilityCandidateId: candidateId,
		result,
		isBug: payload.isBug ?? undefined,
		isSecurity: payload.isSecurity ?? undefined,
		confidence: payload.confidence ?? undefined,
		score: payload.score ?? undefined,
		reportPath: `${verifyRoot}/01_verify_report.md`,
		issueDraftPath: `${verifyRoot}/02_issue_draft.md`,
		pocPath: `${verifyRoot}/03_poc/poc.txt`,
		dockerfilePath: `${verifyRoot}/04_repro/Dockerfile`,
		runScriptPath: `${verifyRoot}/04_repro/run.sh`,
		summary:
			payload.summary ||
			(result === "real_vulnerability"
				? `Verified vulnerability: ${stageInput.analysisResult.candidate.title}`
				: result === "likely_vulnerability"
					? `Likely vulnerability after verification: ${stageInput.analysisResult.candidate.title}`
					: result === "api_misuse"
						? `API misuse: ${stageInput.analysisResult.candidate.title}`
						: result === "false_positive"
							? `False positive: ${stageInput.analysisResult.candidate.title}`
						: `Plausible but unproven after verification: ${stageInput.analysisResult.candidate.title}`),
	});
	await syncResolvedCandidateRiskMetrics({
		vulnerabilityCandidateId: candidateId,
		candidate: stageInput.analysisResult.candidate,
		latestAnalysisResult: stageInput.analysisResult,
		latestVerificationResult: payload,
		updateRiskMetrics: updateVulnerabilityCandidateRiskMetricsRepo,
	});
	return {
		taskId: stageInput.taskId,
		verification: {
			id: stageInput.taskId,
			result:
				result === "real_vulnerability" ||
				result === "likely_vulnerability" ||
				result === "plausible_but_unproven" ||
				result === "false_positive" ||
				result === "api_misuse"
					? result
					: "plausible_but_unproven",
			isBug: payload.isBug ?? null,
			isSecurity: payload.isSecurity ?? null,
			summary:
				payload.summary ||
				(result === "real_vulnerability"
					? `Verified vulnerability: ${stageInput.analysisResult.candidate.title}`
					: result === "likely_vulnerability"
						? `Likely vulnerability after verification: ${stageInput.analysisResult.candidate.title}`
						: result === "api_misuse"
							? `API misuse: ${stageInput.analysisResult.candidate.title}`
							: result === "false_positive"
								? `False positive: ${stageInput.analysisResult.candidate.title}`
								: `Plausible but unproven after verification: ${stageInput.analysisResult.candidate.title}`),
			confidence: payload.confidence ?? null,
			score: payload.score ?? null,
			reportPath: `${verifyRoot}/01_verify_report.md`,
			issueDraftPath: `${verifyRoot}/02_issue_draft.md`,
			pocPath: `${verifyRoot}/03_poc/poc.txt`,
			dockerfilePath: `${verifyRoot}/04_repro/Dockerfile`,
			runScriptPath: `${verifyRoot}/04_repro/run.sh`,
			runtimeSeconds: null,
			status: "completed",
		},
	};
};

export const createVerifyingStageDefinition = <TContext extends VerificationStageContext>(input: {
	name?: string;
	mode?: "serial" | "fanout";
	queue?: StageQueueBinding<TContext, CandidateVerificationStageInput>;
	getDesiredConcurrency?: (ctx: TContext) => Promise<number>;
}): StageDefinition<
	TContext,
	CandidateVerificationStageInput,
	CandidateVerificationStageOutput
> => ({
	name: input.name || "VerifyingStage",
	mode: input.mode || "fanout",
	queue: input.queue,
	run: async (ctx, stageInput) =>
		(await executeCandidateVerificationStage(ctx, stageInput)).rawOutput,
	validateOutput: async (ctx, stageInput, rawOutput) =>
		await validateCandidateVerificationOutput(ctx, stageInput, rawOutput),
	getDesiredConcurrency:
		input.getDesiredConcurrency ||
		(async (ctx) => Math.max(1, ctx.executionContext?.verifyConcurrency || 1)),
});
