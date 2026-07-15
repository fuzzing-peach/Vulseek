import { describe, expect, it } from "vitest";
import {
	buildCandidateProjectionPatch,
	compareProjectionResultVersions,
	getCandidateResultRank,
} from "@vulseek/server/services/scan/persistence/candidate-result-projection";

describe("candidate result projection", () => {
	it("assigns stable ranks for analysis and verification outcomes", () => {
		expect(getCandidateResultRank("real_vulnerability")).toBe(4);
		expect(getCandidateResultRank("likely_vulnerability")).toBe(3);
		expect(getCandidateResultRank("true")).toBe(4);
		expect(getCandidateResultRank("false")).toBe(0);
		expect(getCandidateResultRank(null)).toBe(-1);
	});

	it("accepts a newer result and rejects a stale result", () => {
		expect(
			compareProjectionResultVersions(
				{ resultAt: "2026-07-13T10:00:01.000Z", taskId: "new" },
				{ resultAt: "2026-07-13T10:00:00.000Z", taskId: "old" },
			),
		).toBeGreaterThan(0);
		expect(
			compareProjectionResultVersions(
				{ resultAt: "2026-07-13T10:00:00.000Z", taskId: "old" },
				{ resultAt: "2026-07-13T10:00:01.000Z", taskId: "new" },
			),
		).toBeLessThan(0);
	});

	it("builds only the projection stage patch for a validated task output", () => {
		expect(
			buildCandidateProjectionPatch({
				scanJobId: "job-1",
				vulnerabilityCandidateId: "candidate-1",
				taskId: "task-1",
				stageName: "verify-finding",
				output: { id: "result-1", result: "likely" },
				resultAt: "2026-07-13T10:00:00.000Z",
			}),
		).toEqual({
				verificationTaskId: "task-1",
				verificationOutput: { id: "result-1", result: "likely" },
				verificationResult: "likely",
				verificationRank: 3,
				verificationResultAt: "2026-07-13T10:00:00.000Z",
		});
	});

	it("normalizes legacy boolean verification results to strings", () => {
		expect(
			buildCandidateProjectionPatch({
				scanJobId: "job-1",
				vulnerabilityCandidateId: "candidate-1",
				taskId: "task-1",
				stageName: "verify-finding",
				output: { id: "result-1", result: true },
				resultAt: "2026-07-13T10:00:00.000Z",
			}),
		).toMatchObject({
			verificationOutput: { id: "result-1", result: "true" },
			verificationResult: "true",
			verificationRank: 4,
		});
	});
});
