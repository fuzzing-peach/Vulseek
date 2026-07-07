export const buildCandidatesWithLatestResults = <
	Candidate extends {
		scanJobId: string;
		vulnerabilityCandidateId: string;
		producerTaskId: string;
		confidence?: number | null;
		score?: number | null;
	},
	AnalysisResult extends {
		taskId: string;
		vulnerabilityCandidateId: string;
		producerTaskId: string;
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
		producerTaskId: string;
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
	TriageResult extends {
		taskId: string;
		vulnerabilityCandidateId: string;
		producerTaskId: string;
		result: string;
		disqualifier?: string | null;
		disqualifierReason?: string | null;
		securityClassification: string;
		isSecurityIssue: boolean;
		impactType: string;
		cvssVector?: string | null;
		cvssScore?: number | null;
		cvssSeverity: string;
		exploitability: string;
		isExploitable?: boolean | null;
		commonTriggerConditions: string[];
		hardeningOrRobustness: boolean;
		epssProbability30d?: number | null;
		epssSource: string;
		reportPath?: string | null;
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
	triageResults?: TriageResult[];
	buildAnalysisReportPath: (
		scanJobId: string,
		vulnerabilityCandidateId: string,
	) => string | null;
	buildVerificationArtifactPaths: (
		scanJobId: string,
		vulnerabilityCandidateId: string,
	) => {
		reportPath: string | null;
	};
}) => {
	const resultKey = (value: {
		producerTaskId: string;
		vulnerabilityCandidateId: string;
	}) => `${value.producerTaskId}\n${value.vulnerabilityCandidateId}`;
	const latestAnalysisResultByCandidateKey = new Map<string, AnalysisResult>();
	for (const analysisResult of input.analysisResults) {
		const key = resultKey(analysisResult);
		if (!latestAnalysisResultByCandidateKey.has(key)) {
			latestAnalysisResultByCandidateKey.set(key, analysisResult);
		}
	}

	const latestTriageResultByCandidateKey = new Map<string, TriageResult>();
	for (const triageResult of input.triageResults || []) {
		const key = resultKey(triageResult);
		if (!latestTriageResultByCandidateKey.has(key)) {
			latestTriageResultByCandidateKey.set(key, triageResult);
		}
	}

	const latestVerificationResultByCandidateKey = new Map<
		string,
		VerificationResult
	>();
	for (const verificationResult of input.verificationResults) {
		const key = resultKey(verificationResult);
		if (!latestVerificationResultByCandidateKey.has(key)) {
			latestVerificationResultByCandidateKey.set(key, verificationResult);
		}
	}

	return input.candidates.map((candidate) => {
		const key = resultKey(candidate);
		const latestAnalysisResult = latestAnalysisResultByCandidateKey.get(key);
		const latestVerificationResult =
			latestVerificationResultByCandidateKey.get(key);
		const latestTriageResult = latestTriageResultByCandidateKey.get(key);
		const analysisReportPath =
			latestAnalysisResult?.reportPath ||
			input.buildAnalysisReportPath(
				candidate.scanJobId,
				candidate.vulnerabilityCandidateId,
			);
		const verificationArtifactPaths =
			latestVerificationResult?.reportPath
				? {
						reportPath: latestVerificationResult.reportPath,
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
			typeof latestTriageResult?.cvssScore === "number"
				? latestTriageResult.cvssScore
				: typeof latestVerificationResult?.score === "number"
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
						confidence: latestVerificationResult.confidence,
						score: latestVerificationResult.score,
						reportPath: verificationArtifactPaths.reportPath,
						runtimeSeconds: latestVerificationResult.runtimeSeconds,
						threadId: latestVerificationResult.threadId,
						summary: latestVerificationResult.summary,
						createdAt: latestVerificationResult.createdAt,
						updatedAt: latestVerificationResult.updatedAt,
					}
				: null,
			latestTriageResult: latestTriageResult
				? {
						taskId: latestTriageResult.taskId,
						result: latestTriageResult.result,
						disqualifier: latestTriageResult.disqualifier,
						disqualifierReason: latestTriageResult.disqualifierReason,
						securityClassification:
							latestTriageResult.securityClassification,
						isSecurityIssue: latestTriageResult.isSecurityIssue,
						impactType: latestTriageResult.impactType,
						cvssVector: latestTriageResult.cvssVector,
						cvssScore: latestTriageResult.cvssScore,
						cvssSeverity: latestTriageResult.cvssSeverity,
						exploitability: latestTriageResult.exploitability,
						isExploitable: latestTriageResult.isExploitable,
						commonTriggerConditions:
							latestTriageResult.commonTriggerConditions,
						hardeningOrRobustness:
							latestTriageResult.hardeningOrRobustness,
						epssProbability30d: latestTriageResult.epssProbability30d,
						epssSource: latestTriageResult.epssSource,
						reportPath: latestTriageResult.reportPath,
						runtimeSeconds: latestTriageResult.runtimeSeconds,
						threadId: latestTriageResult.threadId,
						summary: latestTriageResult.summary,
						createdAt: latestTriageResult.createdAt,
						updatedAt: latestTriageResult.updatedAt,
					}
				: null,
		};
	});
};
