import {
	classifyCandidateTaskStage,
	deriveCandidateTaskExecutionState,
} from "@vulseek/server/services/scan/state/candidate-task-state";
import { expect, test } from "vitest";

test("classifyCandidateTaskStage maps analysis and verification stage names", () => {
	expect(classifyCandidateTaskStage("analyze-finding")).toBe("analysis");
	expect(classifyCandidateTaskStage("critique-finding")).toBe("analysis");
	expect(classifyCandidateTaskStage("verify-finding")).toBe("verification");
	expect(classifyCandidateTaskStage("triage-finding")).toBe("verification");
	expect(classifyCandidateTaskStage("scan-target")).toBeNull();
});

test("deriveCandidateTaskExecutionState prefers active verification work over older analysis tasks", () => {
	const state = deriveCandidateTaskExecutionState([
		{
			taskId: "analysis-1",
			stageName: "analyze-finding",
			status: "completed",
			createdAt: "2026-07-09T10:00:00.000Z",
		},
		{
			taskId: "verification-1",
			stageName: "verify-finding",
			status: "running",
			createdAt: "2026-07-09T10:10:00.000Z",
		},
	]);

	expect(state.activePhase).toBe("verification");
	expect(state.activeTask?.taskId).toBe("verification-1");
	expect(state.latestTask?.taskId).toBe("verification-1");
	expect(state.isTerminal).toBe(false);
	expect(state.canRerunAnalysis).toBe(false);
});

test("deriveCandidateTaskExecutionState treats completed analysis as rerunnable terminal work", () => {
	const state = deriveCandidateTaskExecutionState([
		{
			taskId: "analysis-1",
			stageName: "analyze-finding",
			status: "completed",
			createdAt: "2026-07-09T10:00:00.000Z",
		},
	]);

	expect(state.activePhase).toBeNull();
	expect(state.latestPhase).toBe("analysis");
	expect(state.latestTask?.status).toBe("completed");
	expect(state.isTerminal).toBe(true);
	expect(state.canRerunAnalysis).toBe(true);
});

test("deriveCandidateTaskExecutionState treats failed verification as terminal verification work", () => {
	const state = deriveCandidateTaskExecutionState([
		{
			taskId: "analysis-1",
			stageName: "analyze-finding",
			status: "completed",
			createdAt: "2026-07-09T10:00:00.000Z",
		},
		{
			taskId: "verification-1",
			stageName: "verify-finding",
			status: "failed",
			createdAt: "2026-07-09T10:10:00.000Z",
		},
	]);

	expect(state.activePhase).toBeNull();
	expect(state.latestPhase).toBe("verification");
	expect(state.latestTask?.taskId).toBe("verification-1");
	expect(state.isTerminal).toBe(true);
	expect(state.canRerunAnalysis).toBe(true);
});
