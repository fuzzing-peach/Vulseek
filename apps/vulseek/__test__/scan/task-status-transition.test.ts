import { describe, expect, it } from "vitest";
import { buildTaskStatusTransitionPatch } from "../../../../packages/server/src/services/scan/persistence/task-status-transition";

describe("task status transition patch", () => {
	it("stores the original route when a task completes", () => {
		const patch = buildTaskStatusTransitionPatch({
			to: "completed",
			now: "2026-07-25T00:00:00.000Z",
			terminalRouteKey: "new-surface",
			patch: { output: { review: "structured" } },
		});

		expect(patch).toMatchObject({
			status: "completed",
			output: { review: "structured" },
			downstreamRouteKey: "new-surface",
			completedAt: "2026-07-25T00:00:00.000Z",
		});
	});

	it("does not add a route to a failure transition", () => {
		const patch = buildTaskStatusTransitionPatch({
			to: "failed",
			now: "2026-07-25T00:00:00.000Z",
			terminalRouteKey: "new-surface",
		});

		expect(patch).not.toHaveProperty("downstreamRouteKey");
	});
});
