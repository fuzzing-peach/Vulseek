import assert from "node:assert/strict";
import test from "node:test";
import { buildCandidatesWithLatestResults } from "./candidate-aggregates";

const baseCandidate = {
	scanJobId: "scan-job-1",
	vulnerabilityCandidateId: "candidate-1",
	title: "Shared candidate title",
	confidence: null,
	score: null,
	createdAt: "2026-07-07T01:00:00.000Z",
};

test("buildCandidatesWithLatestResults keys latest results by producerTaskId and vulnerabilityCandidateId", () => {
	const candidates = [
		{
			...baseCandidate,
			producerTaskId: "producer-a",
		},
		{
			...baseCandidate,
			producerTaskId: "producer-b",
		},
	];
	const results = buildCandidatesWithLatestResults({
		candidates,
		analysisResults: [
			{
				taskId: "analysis-a",
				producerTaskId: "producer-a",
				vulnerabilityCandidateId: "candidate-1",
				result: "real_vulnerability",
				confidence: 0.9,
				score: 9,
				reportPath: null,
				runtimeSeconds: null,
				threadId: null,
				summary: null,
				createdAt: "2026-07-07T01:10:00.000Z",
				updatedAt: "2026-07-07T01:11:00.000Z",
			},
			{
				taskId: "analysis-b",
				producerTaskId: "producer-b",
				vulnerabilityCandidateId: "candidate-1",
				result: "false_positive",
				confidence: 0.1,
				score: 1,
				reportPath: null,
				runtimeSeconds: null,
				threadId: null,
				summary: null,
				createdAt: "2026-07-07T01:12:00.000Z",
				updatedAt: "2026-07-07T01:13:00.000Z",
			},
		],
		verificationResults: [],
		triageResults: [],
		buildAnalysisReportPath: () => null,
		buildVerificationArtifactPaths: () => ({ reportPath: null }),
	});

	assert.equal(results[0]?.latestAnalysisResult?.taskId, "analysis-a");
	assert.equal(results[0]?.latestAnalysisResult?.result, "real_vulnerability");
	assert.equal(results[1]?.latestAnalysisResult?.taskId, "analysis-b");
	assert.equal(results[1]?.latestAnalysisResult?.result, "false_positive");
});
