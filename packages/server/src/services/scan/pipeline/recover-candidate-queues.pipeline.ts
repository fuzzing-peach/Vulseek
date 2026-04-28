export const recoverCandidateQueuesPipeline = async <
	Job extends { scanJobId: string; status: string },
	Candidate extends { vulnerabilityCandidateId: string; status: string },
>(input: {
	loadJobs: () => Promise<Job[]>;
	normalizeCandidateStatusesForScanJob: (scanJobId: string) => Promise<unknown>;
	loadAnalysisState: (scanJobId: string) => Promise<{
		pendingCandidates: Candidate[];
	}>;
	loadVerificationState: (scanJobId: string) => Promise<{
		pendingCandidates: Candidate[];
	}>;
	updateCandidateStatus: (
		vulnerabilityCandidateId: string,
		status: "queued",
	) => Promise<unknown>;
	updateCandidateCurrentStage: (
		vulnerabilityCandidateId: string,
		stage: "analyzing" | "verifying",
	) => Promise<unknown>;
	enqueueAnalysisWork: (
		scanJobId: string,
		vulnerabilityCandidateId: string,
	) => Promise<unknown>;
	enqueueVerificationWork: (
		scanJobId: string,
		vulnerabilityCandidateId: string,
	) => Promise<unknown>;
	updateScanJobStatus: (
		scanJobId: string,
		status: "analyzing" | "verifying",
	) => Promise<unknown>;
	reconcilePipelineStatus: (scanJobId: string) => Promise<unknown>;
}) => {
	const jobs = await input.loadJobs();

	let analysisCandidates = 0;
	let verificationCandidates = 0;

	for (const job of jobs) {
		await input.normalizeCandidateStatusesForScanJob(job.scanJobId);
		const analysisState = await input.loadAnalysisState(job.scanJobId);
		const verificationState = await input.loadVerificationState(job.scanJobId);

		for (const candidate of analysisState.pendingCandidates) {
			await input
				.updateCandidateCurrentStage(
					candidate.vulnerabilityCandidateId,
					"analyzing",
				)
				.catch(() => {});
			if (candidate.status !== "failed") {
				if (candidate.status !== "running") {
					await input
						.updateCandidateStatus(
							candidate.vulnerabilityCandidateId,
							"queued",
						)
						.catch(() => {});
				}
				await input.enqueueAnalysisWork(
					job.scanJobId,
					candidate.vulnerabilityCandidateId,
				);
				analysisCandidates += 1;
			}
		}

		for (const candidate of verificationState.pendingCandidates) {
			if (candidate.status !== "running") {
				await input
					.updateCandidateStatus(
						candidate.vulnerabilityCandidateId,
						"queued",
					)
					.catch(() => {});
			}
			await input
				.updateCandidateCurrentStage(
					candidate.vulnerabilityCandidateId,
					"verifying",
				)
				.catch(() => {});
			await input.enqueueVerificationWork(
				job.scanJobId,
				candidate.vulnerabilityCandidateId,
			);
			verificationCandidates += 1;
		}

		if (
			job.status !== "scanning" &&
			job.status !== "queued" &&
			verificationState.pendingCandidates.length > 0
		) {
			await input.updateScanJobStatus(job.scanJobId, "verifying").catch(() => {});
		} else if (
			job.status !== "scanning" &&
			job.status !== "queued" &&
			analysisState.pendingCandidates.length > 0
		) {
			await input.updateScanJobStatus(job.scanJobId, "analyzing").catch(() => {});
		}

		await input.reconcilePipelineStatus(job.scanJobId).catch(() => {});
	}

	return {
		scanJobs: jobs.length,
		analysisCandidates,
		verificationCandidates,
	};
};
