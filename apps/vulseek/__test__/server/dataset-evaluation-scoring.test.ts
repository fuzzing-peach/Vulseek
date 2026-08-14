import { describe, expect, it } from "vitest";
import {
	buildDatasetTrialScoringPrompt,
	selectScorableJobOutputs,
	validateDatasetTrialScoringAgentOutput,
} from "@vulseek/server/services/dataset-evaluation-scoring-contract";

const jobOutputs = [
	{
		taskId: "task-report-a",
		stageName: "research-report",
		artifacts: ["/task/job-output/report-a.md"],
	},
	{
		taskId: "task-report-b",
		stageName: "research-report",
		artifacts: ["/task/job-output/report-b.md"],
	},
];

const groundTruthArtifacts = [
	"ground-truth/a.txt",
	"ground-truth/b.json",
];

describe("Dataset Trial artifact scoring contract", () => {
	it("excludes empty historical Job outputs from scoring", () => {
		expect(
			selectScorableJobOutputs([
				...jobOutputs,
				{ taskId: "empty", stageName: "goal-dedup", artifacts: [] },
			]),
		).toEqual(jobOutputs);
	});

	it("returns one normalized hit result per Job output", () => {
		expect(
			validateDatasetTrialScoringAgentOutput({
				rawOutput: {
					jobOutputs: [
						{
							taskId: "task-report-b",
							hit: false,
							matchedGroundTruthArtifacts: [],
							reason: "Different vulnerability.",
						},
						{
							taskId: "task-report-a",
							hit: true,
							matchedGroundTruthArtifacts: [
								"ground-truth/a.txt",
								"ground-truth/a.txt",
							],
							reason: "Same root cause and affected function.",
						},
					],
					summary: "One output matched.",
				},
				groundTruthArtifacts,
				jobOutputs,
			}),
		).toEqual({
			groundTruthArtifacts,
			jobOutputs: [
				{
					...jobOutputs[0],
					hit: true,
					matchedGroundTruthArtifacts: ["ground-truth/a.txt"],
					reason: "Same root cause and affected function.",
				},
				{
					...jobOutputs[1],
					hit: false,
					matchedGroundTruthArtifacts: [],
					reason: "Different vulnerability.",
				},
			],
			unmatchedGroundTruthArtifacts: ["ground-truth/b.json"],
			summary: "One output matched.",
		});
	});

	it("rejects missing, duplicate, and unknown Job output ids", () => {
		const parse = (jobOutputResults: unknown[]) =>
			validateDatasetTrialScoringAgentOutput({
				rawOutput: { jobOutputs: jobOutputResults, summary: "Summary" },
				groundTruthArtifacts,
				jobOutputs,
			});
		const miss = (taskId: string) => ({
			taskId,
			hit: false,
			matchedGroundTruthArtifacts: [],
			reason: "No match.",
		});

		expect(() => parse([miss("task-report-a")])).toThrow(
			"missing Job output tasks: task-report-b",
		);
		expect(() =>
			parse([miss("task-report-a"), miss("task-report-a")]),
		).toThrow("duplicate Job output task: task-report-a");
		expect(() => parse([miss("task-report-a"), miss("unknown")])).toThrow(
			"unknown Job output task: unknown",
		);
	});

	it("rejects unknown ground truth and inconsistent hit flags", () => {
		const validMiss = {
			taskId: "task-report-b",
			hit: false,
			matchedGroundTruthArtifacts: [],
			reason: "No match.",
		};
		expect(() =>
			validateDatasetTrialScoringAgentOutput({
				rawOutput: {
					jobOutputs: [
						{
							taskId: "task-report-a",
							hit: true,
							matchedGroundTruthArtifacts: ["unknown.txt"],
							reason: "Match.",
						},
						validMiss,
					],
					summary: "Summary",
				},
				groundTruthArtifacts,
				jobOutputs,
			}),
		).toThrow("unknown ground-truth artifact: unknown.txt");

		expect(() =>
			validateDatasetTrialScoringAgentOutput({
				rawOutput: {
					jobOutputs: [
						{
							taskId: "task-report-a",
							hit: true,
							matchedGroundTruthArtifacts: [],
							reason: "Contradiction.",
						},
						validMiss,
					],
					summary: "Summary",
				},
				groundTruthArtifacts,
				jobOutputs,
			}),
		).toThrow("hit flag is inconsistent for Job output task: task-report-a");
	});

	it("instructs the evaluator to inspect all local artifacts conservatively", () => {
		const prompt = buildDatasetTrialScoringPrompt(
			"/task/comparison-manifest.json",
		);
		expect(prompt).toContain("/task/comparison-manifest.json");
		expect(prompt).toContain("exactly one jobOutputs entry");
		expect(prompt).toContain("Do not use the network");
	});
});
