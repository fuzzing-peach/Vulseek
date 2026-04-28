export const normalizeCandidateStatuses = async <
	Candidate extends {
		vulnerabilityCandidateId: string;
		currentStage: string;
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
	updateCandidateCurrentStage: (
		vulnerabilityCandidateId: string,
		stage: "analyzing" | "verifying",
	) => Promise<unknown>;
	updateCandidateStatus: (
		vulnerabilityCandidateId: string,
		status: "queued" | "completed",
	) => Promise<unknown>;
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

	for (const candidate of input.candidates) {
		const verificationResult = latestVerificationResultByCandidateId.get(
			candidate.vulnerabilityCandidateId,
		);
		if (verificationResult) {
			if (candidate.currentStage !== "verifying") {
				await input
					.updateCandidateCurrentStage(
						candidate.vulnerabilityCandidateId,
						"verifying",
					)
					.catch(() => {});
			}
			if (candidate.status !== "completed") {
				await input
					.updateCandidateStatus(
						candidate.vulnerabilityCandidateId,
						"completed",
					)
					.catch(() => {});
			}
			continue;
		}

		const analysisResult = latestAnalysisResultByCandidateId.get(
			candidate.vulnerabilityCandidateId,
		);
		if (!analysisResult) {
			continue;
		}

		if (input.shouldVerifyFromAnalysisResult(analysisResult.result)) {
			if (candidate.currentStage !== "verifying") {
				await input
					.updateCandidateCurrentStage(
						candidate.vulnerabilityCandidateId,
						"verifying",
					)
					.catch(() => {});
			}
			if (
				candidate.status !== "failed" &&
				candidate.status !== "running" &&
				candidate.status !== "queued"
			) {
				await input
					.updateCandidateStatus(
						candidate.vulnerabilityCandidateId,
						"queued",
					)
					.catch(() => {});
			}
			continue;
		}

		if (candidate.currentStage !== "analyzing") {
			await input
				.updateCandidateCurrentStage(
					candidate.vulnerabilityCandidateId,
					"analyzing",
				)
				.catch(() => {});
		}
		if (candidate.status !== "completed") {
			await input
				.updateCandidateStatus(
					candidate.vulnerabilityCandidateId,
					"completed",
				)
				.catch(() => {});
		}
	}
};
