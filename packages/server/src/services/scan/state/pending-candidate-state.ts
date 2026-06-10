export const getPendingAnalysisCandidateState = <
	Candidate extends {
		vulnerabilityCandidateId: string;
		status: string;
	},
	AnalysisResult extends {
		vulnerabilityCandidateId: string;
	},
>(input: {
	candidates: Candidate[];
	analysisResults: AnalysisResult[];
}) => {
	const analysisCandidateIds = new Set(
		input.analysisResults.map((item) => item.vulnerabilityCandidateId),
	);

	const pendingCandidates = input.candidates.filter(
		(candidate) =>
			!analysisCandidateIds.has(candidate.vulnerabilityCandidateId) &&
			candidate.status !== "failed" &&
			candidate.status !== "exited" &&
			candidate.status !== "canceled",
	);
	const failed = input.candidates.filter(
		(candidate) =>
			!analysisCandidateIds.has(candidate.vulnerabilityCandidateId) &&
			candidate.status === "failed",
	).length;

	return {
		candidates: input.candidates,
		pendingCandidates,
		failed,
	};
};

export const getPendingVerificationCandidateState = <
	Candidate extends {
		vulnerabilityCandidateId: string;
		status: string;
	},
	AnalysisResult extends {
		vulnerabilityCandidateId: string;
		result: string;
	},
	VerificationResult extends {
		vulnerabilityCandidateId: string;
	},
>(input: {
	candidates: Candidate[];
	analysisResults: AnalysisResult[];
	verificationResults: VerificationResult[];
	shouldVerifyFromAnalysisResult: (result: string) => boolean;
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

	const pendingCandidates = input.candidates.filter((candidate) => {
		const latestAnalysisResult = latestAnalysisResultByCandidateId.get(
			candidate.vulnerabilityCandidateId,
		);
		if (!latestAnalysisResult) {
			return false;
		}

		if (!input.shouldVerifyFromAnalysisResult(latestAnalysisResult.result)) {
			return false;
		}

		if (
			latestVerificationResultByCandidateId.has(
				candidate.vulnerabilityCandidateId,
			)
		) {
			return false;
		}

		return (
			candidate.status !== "failed" &&
			candidate.status !== "exited" &&
			candidate.status !== "canceled"
		);
	});

	const failed = input.candidates.filter((candidate) => {
		const latestAnalysisResult = latestAnalysisResultByCandidateId.get(
			candidate.vulnerabilityCandidateId,
		);
		if (!latestAnalysisResult) {
			return false;
		}

		if (!input.shouldVerifyFromAnalysisResult(latestAnalysisResult.result)) {
			return false;
		}

		if (
			latestVerificationResultByCandidateId.has(
				candidate.vulnerabilityCandidateId,
			)
		) {
			return false;
		}

		return candidate.status === "failed";
	}).length;

	return {
		candidates: input.candidates,
		pendingCandidates,
		totalTargets: input.candidates.filter((candidate) => {
			const latestAnalysisResult = latestAnalysisResultByCandidateId.get(
				candidate.vulnerabilityCandidateId,
			);
			if (!latestAnalysisResult) {
				return false;
			}

			return input.shouldVerifyFromAnalysisResult(latestAnalysisResult.result);
		}).length,
		failed,
	};
};
