export const buildCandidatesWithLatestResults = <
	Candidate extends {
		scanJobId: string;
		vulnerabilityCandidateId: string;
		confidence?: number | null;
		score?: number | null;
	},
	AnalysisResult extends {
		taskId: string;
		vulnerabilityCandidateId: string;
		result: string;
		reportPath?: string | null;
		confidence?: number | null;
		score?: number | null;
		runtimeSeconds?: number | null;
		threadId?: string | null;
		summary?: string | null;
		createdAt: string;
		updatedAt: string;
	},
	VerificationResult extends {
		taskId: string;
		vulnerabilityCandidateId: string;
		result: string;
		reportPath?: string | null;
		issueDraftPath?: string | null;
		pocPath?: string | null;
		dockerfilePath?: string | null;
		runScriptPath?: string | null;
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
	) => string | null;
	buildVerificationArtifactPaths: (
		scanJobId: string,
		vulnerabilityCandidateId: string,
	) => {
		reportPath: string | null;
		issueDraftPath: string | null;
		pocPath: string | null;
		dockerfilePath: string | null;
		runScriptPath: string | null;
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
		const analysisReportPath =
			latestAnalysisResult?.reportPath ||
			input.buildAnalysisReportPath(
				candidate.scanJobId,
				candidate.vulnerabilityCandidateId,
			);
		const verificationArtifactPaths =
			latestVerificationResult?.reportPath &&
			latestVerificationResult.issueDraftPath &&
			latestVerificationResult.pocPath &&
			latestVerificationResult.dockerfilePath &&
			latestVerificationResult.runScriptPath
				? {
						reportPath: latestVerificationResult.reportPath,
						issueDraftPath: latestVerificationResult.issueDraftPath,
						pocPath: latestVerificationResult.pocPath,
						dockerfilePath: latestVerificationResult.dockerfilePath,
						runScriptPath: latestVerificationResult.runScriptPath,
					}
				: input.buildVerificationArtifactPaths(
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
						taskId: latestAnalysisResult.taskId,
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
						taskId: latestVerificationResult.taskId,
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
