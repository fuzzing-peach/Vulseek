import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@dokploy/server/db";
import { scanStageLaneRuntimes } from "@dokploy/server/db/schema";

export type StageLaneRuntime = typeof scanStageLaneRuntimes.$inferSelect;

export const ensureStageLaneRuntimesRepo = async (input: {
	scanJobId: string;
	stageName: string;
	laneCount: number;
}) => {
	const now = new Date().toISOString();
	await db
		.insert(scanStageLaneRuntimes)
		.values(
			Array.from({ length: Math.max(0, input.laneCount) }, (_, laneIndex) => ({
				scanJobId: input.scanJobId,
				stageName: input.stageName,
				laneIndex,
				status: "idle" as const,
				createdAt: now,
				updatedAt: now,
			})),
		)
		.onConflictDoNothing();
};

export const claimIdleStageLaneRuntimeRepo = async (input: {
	scanJobId: string;
	stageName: string;
	laneCount: number;
	taskId: string;
	forkedFromTaskId?: string | null;
	forkedFromThreadId?: string | null;
}): Promise<StageLaneRuntime | null> => {
	await ensureStageLaneRuntimesRepo(input);
	const lanes = await db
		.select()
		.from(scanStageLaneRuntimes)
		.where(
			and(
				eq(scanStageLaneRuntimes.scanJobId, input.scanJobId),
				eq(scanStageLaneRuntimes.stageName, input.stageName),
				isNull(scanStageLaneRuntimes.activeTaskId),
			),
		)
		.orderBy(asc(scanStageLaneRuntimes.laneIndex));

	for (const lane of lanes) {
		if (lane.laneIndex >= input.laneCount) {
			continue;
		}
		const updated = await db
			.update(scanStageLaneRuntimes)
			.set({
				activeTaskId: input.taskId,
				status: "active",
				...(lane.threadId
					? {}
					: {
							forkedFromTaskId: input.forkedFromTaskId ?? null,
							forkedFromThreadId: input.forkedFromThreadId ?? null,
						}),
				updatedAt: new Date().toISOString(),
			})
			.where(
				and(
					eq(scanStageLaneRuntimes.scanJobId, input.scanJobId),
					eq(scanStageLaneRuntimes.stageName, input.stageName),
					eq(scanStageLaneRuntimes.laneIndex, lane.laneIndex),
					isNull(scanStageLaneRuntimes.activeTaskId),
				),
			)
			.returning();
		if (updated[0]) {
			return updated[0];
		}
	}

	return null;
};

export const findStageLaneRuntimeByActiveTaskIdRepo = async (taskId: string) =>
	await db
		.select()
		.from(scanStageLaneRuntimes)
		.where(eq(scanStageLaneRuntimes.activeTaskId, taskId))
		.limit(1)
		.then((rows) => rows[0] || null);

export const bindStageLaneRuntimeRepo = async (input: {
	scanJobId: string;
	stageName: string;
	laneIndex: number;
	containerName?: string | null;
	threadId?: string | null;
}) =>
	await db
		.update(scanStageLaneRuntimes)
		.set({
			...(input.containerName !== undefined
				? { containerName: input.containerName }
				: {}),
			...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
			updatedAt: new Date().toISOString(),
		})
		.where(
			and(
				eq(scanStageLaneRuntimes.scanJobId, input.scanJobId),
				eq(scanStageLaneRuntimes.stageName, input.stageName),
				eq(scanStageLaneRuntimes.laneIndex, input.laneIndex),
			),
		)
		.returning()
		.then((rows) => rows[0] || null);

export const resetClaimedStageLaneRuntimeForFreshStartRepo = async (input: {
	scanJobId: string;
	stageName: string;
	laneIndex: number;
	forkedFromTaskId?: string | null;
	forkedFromThreadId?: string | null;
}) =>
	await db
		.update(scanStageLaneRuntimes)
		.set({
			containerName: null,
			threadId: null,
			forkedFromTaskId: input.forkedFromTaskId ?? null,
			forkedFromThreadId: input.forkedFromThreadId ?? null,
			updatedAt: new Date().toISOString(),
		})
		.where(
			and(
				eq(scanStageLaneRuntimes.scanJobId, input.scanJobId),
				eq(scanStageLaneRuntimes.stageName, input.stageName),
				eq(scanStageLaneRuntimes.laneIndex, input.laneIndex),
			),
		)
		.returning()
		.then((rows) => rows[0] || null);

export const releaseStageLaneRuntimeRepo = async (taskId: string) =>
	await db
		.update(scanStageLaneRuntimes)
		.set({
			activeTaskId: null,
			status: "idle",
			updatedAt: new Date().toISOString(),
		})
		.where(eq(scanStageLaneRuntimes.activeTaskId, taskId))
		.returning();

export const resetStageLaneRuntimeForExitRepo = async (input: {
	taskId: string;
}) => {
	const now = new Date().toISOString();
	return await db
		.update(scanStageLaneRuntimes)
		.set({
			containerName: null,
			threadId: null,
			activeTaskId: null,
			forkedFromTaskId: null,
			forkedFromThreadId: null,
			status: "idle",
			lastExitTaskId: input.taskId,
			lastExitAt: now,
			updatedAt: now,
		})
		.where(eq(scanStageLaneRuntimes.activeTaskId, input.taskId))
		.returning();
};
