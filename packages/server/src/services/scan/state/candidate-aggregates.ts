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

	const latestTriageResultByCandidateId = new Map<string, TriageResult>();
	for (const triageResult of input.triageResults || []) {
		if (
			!latestTriageResultByCandidateId.has(
				triageResult.vulnerabilityCandidateId,
			)
		) {
			latestTriageResultByCandidateId.set(
				triageResult.vulnerabilityCandidateId,
				triageResult,
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
		const latestTriageResult = latestTriageResultByCandidateId.get(
			candidate.vulnerabilityCandidateId,
		);
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
