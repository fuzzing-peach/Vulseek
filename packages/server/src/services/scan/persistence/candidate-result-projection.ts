export const getCandidateResultRank = (result: string | null | undefined) => {
	if (!result) {
		return -1;
	}
	return (
		{
			real_vulnerability: 4,
			true: 4,
			likely_vulnerability: 3,
			likely: 3,
			plausible_but_unproven: 2,
			api_misuse: 1,
			false_positive: 0,
			false: 0,
		} as Record<string, number>
	)[result] ?? -1;
};

export const compareProjectionResultVersions = (
	left: { resultAt: string; taskId: string },
	right: { resultAt: string; taskId: string },
) => {
	const leftTime = Date.parse(left.resultAt);
	const rightTime = Date.parse(right.resultAt);
	if (leftTime !== rightTime) {
		return leftTime - rightTime;
	}
	return left.taskId.localeCompare(right.taskId);
};

type CandidateProjectionPatchInput = {
	scanJobId: string;
	vulnerabilityCandidateId: string;
	taskId: string;
	stageName: string;
	output: unknown;
	resultAt: string;
};

export const buildCandidateProjectionPatch = (
	input: CandidateProjectionPatchInput,
) => {
	const result =
		input.output && typeof input.output === "object"
			? (input.output as { result?: unknown }).result
			: null;
	const resultValue = typeof result === "string" ? result : null;
	const common = {
		result: resultValue,
		rank: getCandidateResultRank(resultValue),
		resultAt: input.resultAt,
	};

	if (input.stageName === "analyze-finding") {
		return {
			analysisTaskId: input.taskId,
			analysisOutput: input.output,
			analysisResult: common.result,
			analysisRank: common.rank,
			analysisResultAt: common.resultAt,
		};
	}
	if (input.stageName === "verify-finding") {
		return {
			verificationTaskId: input.taskId,
			verificationOutput: input.output,
			verificationResult: common.result,
			verificationRank: common.rank,
			verificationResultAt: common.resultAt,
		};
	}
	if (input.stageName === "triage-finding") {
		return {
			triageTaskId: input.taskId,
			triageOutput: input.output,
			triageResult: common.result,
			triageRank: common.rank,
			triageResultAt: common.resultAt,
		};
	}
	return {};
};
