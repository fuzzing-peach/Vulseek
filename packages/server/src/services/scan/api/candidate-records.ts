import {
	buildCandidatesWithLatestResults,
} from "../state/candidate-aggregates";
import {
	createAnalysisResultRepo,
	listAnalysisResultsByScanJobIdRepo,
} from "../persistence/analysis-result.repo";
import {
	createVulnerabilityCandidateRepo,
	findVulnerabilityCandidateByIdRepo,
	findVulnerabilityCandidatesByScanJobIdRepo,
} from "../persistence/candidate.repo";
import {
	createVerificationResultRepo,
	listVerificationResultsByScanJobIdRepo,
} from "../persistence/verification-result.repo";
import type {
	AnalysisResult,
	VerificationResult,
	VulnerabilityCandidateStage,
} from "../types";

const CONTAINER_SCAN_CONTEXT_ROOT = "/scan-context";

const buildScanJobContextRoot = (scanJobId: string) =>
	`${CONTAINER_SCAN_CONTEXT_ROOT}/jobs/${scanJobId}`;

const buildCandidateContextRoot = (scanJobId: string, candidateId: string) =>
	`${buildScanJobContextRoot(scanJobId)}/candidates/${candidateId}`;

const buildCandidateAnalysisReportPath = (scanJobId: string, candidateId: string) =>
	`${buildCandidateContextRoot(scanJobId, candidateId)}/analysis/01_report.md`;

const buildCandidateVerificationArtifactPaths = (
	scanJobId: string,
	candidateId: string,
) => {
	const verifyRoot = `${buildCandidateContextRoot(scanJobId, candidateId)}/verify`;
	return {
		verifyRoot,
		reportPath: `${verifyRoot}/01_verify_report.md`,
		issueDraftPath: `${verifyRoot}/02_issue_draft.md`,
		pocPath: `${verifyRoot}/03_poc/poc.txt`,
		dockerfilePath: `${verifyRoot}/04_repro/Dockerfile`,
		runScriptPath: `${verifyRoot}/04_repro/run.sh`,
	};
};

export const createVulnerabilityCandidate = async (input: {
	scanJobId: string;
	title: string;
	description?: string;
	filePath?: string;
	line?: number;
	confidence?: number;
	score?: number;
	status?: "queued" | "running" | "completed" | "failed";
	currentStage?: VulnerabilityCandidateStage;
}) => await createVulnerabilityCandidateRepo(input);

export const findVulnerabilityCandidatesByScanJobId = async (scanJobId: string) =>
	await findVulnerabilityCandidatesByScanJobIdRepo(scanJobId);

export const findVulnerabilityCandidatesWithLatestAnalysisResultByScanJobId = async (
	scanJobId: string,
) => {
	const [candidates, analysisResultsList, verificationResultsList] =
		await Promise.all([
			findVulnerabilityCandidatesByScanJobIdRepo(scanJobId),
			listAnalysisResultsByScanJobIdRepo(scanJobId),
			listVerificationResultsByScanJobIdRepo(scanJobId),
		]);

	return buildCandidatesWithLatestResults({
		candidates,
		analysisResults: analysisResultsList as AnalysisResult[],
		verificationResults: verificationResultsList as VerificationResult[],
		buildAnalysisReportPath: buildCandidateAnalysisReportPath,
		buildVerificationArtifactPaths: buildCandidateVerificationArtifactPaths,
	});
};

export const findVulnerabilityCandidateById = async (
	vulnerabilityCandidateId: string,
) => await findVulnerabilityCandidateByIdRepo(vulnerabilityCandidateId);

export const createAnalysisResult = async (input: {
	scanJobId: string;
	vulnerabilityCandidateId: string;
	result: string;
	confidence?: number;
	score?: number;
	reportPath?: string;
	runtimeSeconds?: number;
	threadId?: string;
	summary?: string;
}) => await createAnalysisResultRepo(input);

export const findAnalysisResultsByScanJobId = async (scanJobId: string) =>
	await listAnalysisResultsByScanJobIdRepo(scanJobId);

export const createVerificationResult = async (input: {
	scanJobId: string;
	vulnerabilityCandidateId: string;
	result: string;
	isBug?: boolean;
	isSecurity?: boolean;
	confidence?: number;
	score?: number;
	reportPath?: string;
	issueDraftPath?: string;
	pocPath?: string;
	dockerfilePath?: string;
	runScriptPath?: string;
	runtimeSeconds?: number;
	threadId?: string;
	summary?: string;
}) => await createVerificationResultRepo(input);

export const findVerificationResultsByScanJobId = async (scanJobId: string) =>
	await listVerificationResultsByScanJobIdRepo(scanJobId);
