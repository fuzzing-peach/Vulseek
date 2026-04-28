export const buildCandidatesWithLatestResults = <
	Candidate extends {
		scanJobId: string;
		vulnerabilityCandidateId: string;
		confidence?: number | null;
		score?: number | null;
	},
	AnalysisResult extends {
		analysisResultId: string;
		candidateAnalysisTaskId?: string;
		vulnerabilityCandidateId: string;
		result: string;
		confidence?: number | null;
		score?: number | null;
		runtimeSeconds?: number | null;
		threadId?: string | null;
		summary?: string | null;
		createdAt: string;
		updatedAt: string;
	},
	VerificationResult extends {
		verificationResultId: string;
		candidateVerificationTaskId?: string;
		vulnerabilityCandidateId: string;
		result: string;
		isBug?: boolean | null;
		isSecurity?: boolean | null;
		confidence?: number | null;
		score?: number | null;
		runtimeSeconds?: number | null;
		threadId?: string | null;
		summary?: string | null;
		createdAt: string;
		updatedAt: string;
	},
>(input: {
	candidates: Candidate[];
	analysisResults: AnalysisResult[];
	verificationResults: VerificationResult[];
	buildAnalysisReportPath: (
		scanJobId: string,
		vulnerabilityCandidateId: string,
	) => string;
	buildVerificationArtifactPaths: (
		scanJobId: string,
		vulnerabilityCandidateId: string,
	) => {
		reportPath: string;
		issueDraftPath: string;
		pocPath: string;
		dockerfilePath: string;
		runScriptPath: string;
	};
}) => {
	const latestAnalysisResultByCandidateId = new Map<string, AnalysisResult>();
	for (const analysisResult of input.analysisResults) {
		if (
			!latestAnalysisResultByCandidateId.has(
				analysisResult.vulnerabilityCandidateId,
			)
		) {
			latestAnalysisResultByCandidateId.set(
				analysisResult.vulnerabilityCandidateId,
				analysisResult,
			);
		}
	}

	const latestVerificationResultByCandidateId = new Map<
		string,
		VerificationResult
	>();
	for (const verificationResult of input.verificationResults) {
		if (
			!latestVerificationResultByCandidateId.has(
				verificationResult.vulnerabilityCandidateId,
			)
		) {
			latestVerificationResultByCandidateId.set(
				verificationResult.vulnerabilityCandidateId,
				verificationResult,
			);
		}
	}

	return input.candidates.map((candidate) => {
		const latestAnalysisResult = latestAnalysisResultByCandidateId.get(
			candidate.vulnerabilityCandidateId,
		);
		const latestVerificationResult = latestVerificationResultByCandidateId.get(
			candidate.vulnerabilityCandidateId,
		);
		const analysisReportPath = input.buildAnalysisReportPath(
			candidate.scanJobId,
			candidate.vulnerabilityCandidateId,
		);
		const verificationArtifactPaths = input.buildVerificationArtifactPaths(
			candidate.scanJobId,
			candidate.vulnerabilityCandidateId,
		);
		const resolvedConfidence =
			typeof latestVerificationResult?.confidence === "number"
				? latestVerificationResult.confidence
				: typeof latestAnalysisResult?.confidence === "number"
					? latestAnalysisResult.confidence
					: candidate.confidence;
		const resolvedScore =
			typeof latestVerificationResult?.score === "number"
				? latestVerificationResult.score
				: typeof latestAnalysisResult?.score === "number"
					? latestAnalysisResult.score
					: candidate.score;

		return {
			...candidate,
			confidence: resolvedConfidence,
			score: resolvedScore,
			latestAnalysisResult: latestAnalysisResult
				? {
						analysisResultId: latestAnalysisResult.analysisResultId,
						candidateAnalysisTaskId:
							latestAnalysisResult.candidateAnalysisTaskId,
						result: latestAnalysisResult.result,
						confidence: latestAnalysisResult.confidence,
						score: latestAnalysisResult.score,
						reportPath: analysisReportPath,
						runtimeSeconds: latestAnalysisResult.runtimeSeconds,
						threadId: latestAnalysisResult.threadId,
						summary: latestAnalysisResult.summary,
						createdAt: latestAnalysisResult.createdAt,
						updatedAt: latestAnalysisResult.updatedAt,
					}
				: null,
			latestVerificationResult: latestVerificationResult
				? {
						verificationResultId: latestVerificationResult.verificationResultId,
						candidateVerificationTaskId:
							latestVerificationResult.candidateVerificationTaskId,
						result: latestVerificationResult.result,
						isBug: latestVerificationResult.isBug,
						isSecurity: latestVerificationResult.isSecurity,
						confidence: latestVerificationResult.confidence,
						score: latestVerificationResult.score,
						reportPath: verificationArtifactPaths.reportPath,
						issueDraftPath: verificationArtifactPaths.issueDraftPath,
						pocPath: verificationArtifactPaths.pocPath,
						dockerfilePath: verificationArtifactPaths.dockerfilePath,
						runScriptPath: verificationArtifactPaths.runScriptPath,
						runtimeSeconds: latestVerificationResult.runtimeSeconds,
						threadId: latestVerificationResult.threadId,
						summary: latestVerificationResult.summary,
						createdAt: latestVerificationResult.createdAt,
						updatedAt: latestVerificationResult.updatedAt,
					}
				: null,
		};
	});
};
