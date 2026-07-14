import { describe, expect, it } from "vitest";
import { buildTaskQueueMetrics } from "../../components/dashboard/scanning/task-queue-metrics";

describe("buildTaskQueueMetrics", () => {
	it("uses the pipeline concurrency after runtime data was split", () => {
		expect(
			buildTaskQueueMetrics(
				{
					queuedCount: 10,
					pendingCount: 10,
					launchingCount: 0,
					launchedCount: 0,
					runningCount: 4,
					startingCount: 0,
					completedCount: 0,
					exitedCount: 0,
				},
				4,
			),
		).toEqual({ queued: 10, running: 4, done: 0, concurrencyLimit: 4 });
	});
});
