import { db } from "@vulseek/server/db";
import { scanJobCostBackfills, tasks } from "@vulseek/server/db/schema";
import { eq, sql } from "drizzle-orm";
import { computeTaskCost } from "../cost";

const BACKFILL_ID = "v1";

export const backfillScanJobCosts = async () => {
	await db
		.insert(scanJobCostBackfills)
		.values({
			backfillId: BACKFILL_ID,
			status: "pending",
			updatedAt: new Date().toISOString(),
		})
		.onConflictDoNothing();

	const marker = await db
		.select()
		.from(scanJobCostBackfills)
		.where(eq(scanJobCostBackfills.backfillId, BACKFILL_ID))
		.limit(1)
		.then((rows) => rows[0]);
	if (!marker) {
		throw new Error("Scan job cost backfill marker is missing");
	}
	if (marker.status === "completed") {
		return marker;
	}

	let processedCount = 0;
	let skippedCount = 0;
	const skippedTasks: Array<{ taskId: string; reason: string }> = [];
	try {
		await db
			.update(scanJobCostBackfills)
			.set({ status: "running", processedCount: 0, skippedCount: 0, skippedTasks: [], updatedAt: new Date().toISOString() })
			.where(eq(scanJobCostBackfills.backfillId, BACKFILL_ID));

		const historicalTasks = await db.select().from(tasks);
		for (const task of historicalTasks) {
			const estimatedCost = computeTaskCost(
				task.inputTokens,
				task.outputTokens,
				task.cachedReadTokens,
				task.agentProfile,
			);
			if (estimatedCost == null) {
				skippedCount += 1;
				skippedTasks.push({ taskId: task.taskId, reason: "unknown model or pricing provider" });
				continue;
			}
			await db
				.update(tasks)
				.set({ estimatedCost })
				.where(eq(tasks.taskId, task.taskId));
			processedCount += 1;
		}

		await db.execute(sql`
			UPDATE scan_jobs
			SET estimated_cost = COALESCE(aggregates.estimated_cost, 0)
			FROM (
				SELECT "scanJobId", SUM(COALESCE(estimated_cost, 0)) AS estimated_cost
				FROM tasks
				GROUP BY "scanJobId"
			) AS aggregates
			WHERE scan_jobs."scanJobId" = aggregates."scanJobId"
		`);
		await db
			.update(scanJobCostBackfills)
			.set({ status: "completed", processedCount, skippedCount, skippedTasks, updatedAt: new Date().toISOString() })
			.where(eq(scanJobCostBackfills.backfillId, BACKFILL_ID));
		return { processedCount, skippedCount, skippedTasks };
	} catch (error) {
		await db
			.update(scanJobCostBackfills)
			.set({ status: "pending", processedCount, skippedCount, skippedTasks, updatedAt: new Date().toISOString() })
			.where(eq(scanJobCostBackfills.backfillId, BACKFILL_ID))
			.catch(() => {});
		throw error;
	}
};
