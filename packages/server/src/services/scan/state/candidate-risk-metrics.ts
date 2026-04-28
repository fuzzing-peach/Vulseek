export const syncResolvedCandidateRiskMetrics = async <
	Candidate extends {
		confidence?: number | null;
		score?: number | null;
	},
	AnalysisResult extends {
		confidence?: number | null;
		score?: number | null;
	},
	VerificationResult extends {
		confidence?: number | null;
		score?: number | null;
	},
>(input: {
	vulnerabilityCandidateId: string;
	candidate: Candidate;
	latestAnalysisResult: AnalysisResult | null;
	latestVerificationResult: VerificationResult | null;
	updateRiskMetrics: (
		vulnerabilityCandidateId: string,
		patch: {
			confidence?: number;
			score?: number;
		},
	) => Promise<unknown>;
}) =>
	await input.updateRiskMetrics(input.vulnerabilityCandidateId, {
		confidence:
			typeof input.latestVerificationResult?.confidence === "number"
				? input.latestVerificationResult.confidence
				: typeof input.latestAnalysisResult?.confidence === "number"
					? input.latestAnalysisResult.confidence
					: input.candidate.confidence ?? undefined,
		score:
			typeof input.latestVerificationResult?.score === "number"
				? input.latestVerificationResult.score
				: typeof input.latestAnalysisResult?.score === "number"
					? input.latestAnalysisResult.score
					: input.candidate.score ?? undefined,
	});
