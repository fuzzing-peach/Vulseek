import {
	buildCandidatesWithLatestResults,
} from "../state/candidate-aggregates";
import {
	listAnalysisResultsByScanJobIdRepo,
	listVerificationResultsByScanJobIdRepo,
} from "../persistence/task.repo";
import {
	findVulnerabilityCandidateByIdRepo,
	findVulnerabilityCandidatesByScanJobIdRepo,
} from "../persistence/candidate.repo";

const buildCandidateAnalysisReportPath = () => null;

const buildCandidateVerificationArtifactPaths = () => {
	const verifyRoot = null;
	return {
		verifyRoot,
		reportPath: null,
		issueDraftPath: null,
		pocPath: null,
		dockerfilePath: null,
		runScriptPath: null,
	};
};

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
		analysisResults: analysisResultsList,
		verificationResults: verificationResultsList,
		buildAnalysisReportPath: buildCandidateAnalysisReportPath,
		buildVerificationArtifactPaths: buildCandidateVerificationArtifactPaths,
	});
};

export const findVulnerabilityCandidateById = async (
	vulnerabilityCandidateId: string,
) => await findVulnerabilityCandidateByIdRepo(vulnerabilityCandidateId);
