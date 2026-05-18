import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@dokploy/server/db";
import {
	scanStageGroupInstances,
	scanStageGroupLaneMemberships,
	scanStageLaneRuntimes,
} from "@dokploy/server/db/schema";

export type StageLaneRuntime = typeof scanStageLaneRuntimes.$inferSelect;
export type StageGroupInstance = typeof scanStageGroupInstances.$inferSelect;
export type StageGroupLaneMembership =
	typeof scanStageGroupLaneMemberships.$inferSelect;

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
	excludedLaneIndexes?: number[];
}): Promise<StageLaneRuntime | null> => {
	await ensureStageLaneRuntimesRepo(input);
	const excludedLaneIndexes = new Set(input.excludedLaneIndexes || []);
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
		if (
			lane.laneIndex >= input.laneCount ||
			excludedLaneIndexes.has(lane.laneIndex)
		) {
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

export const claimSpecificStageLaneRuntimeRepo = async (input: {
	scanJobId: string;
	stageName: string;
	laneIndex: number;
	laneCount: number;
	taskId: string;
}): Promise<StageLaneRuntime | null> => {
	if (input.laneIndex >= input.laneCount) {
		return null;
	}
	await ensureStageLaneRuntimesRepo(input);
	return await db
		.update(scanStageLaneRuntimes)
		.set({
			activeTaskId: input.taskId,
			status: "active",
			updatedAt: new Date().toISOString(),
		})
		.where(
			and(
				eq(scanStageLaneRuntimes.scanJobId, input.scanJobId),
				eq(scanStageLaneRuntimes.stageName, input.stageName),
				eq(scanStageLaneRuntimes.laneIndex, input.laneIndex),
				isNull(scanStageLaneRuntimes.activeTaskId),
			),
		)
		.returning()
		.then((rows) => rows[0] || null);
};

export const findStageLaneRuntimeByActiveTaskIdRepo = async (taskId: string) =>
	await db
		.select()
		.from(scanStageLaneRuntimes)
		.where(eq(scanStageLaneRuntimes.activeTaskId, taskId))
		.limit(1)
		.then((rows) => rows[0] || null);

export const findStageLaneRuntimeRepo = async (input: {
	scanJobId: string;
	stageName: string;
	laneIndex: number;
}) =>
	await db
		.select()
		.from(scanStageLaneRuntimes)
		.where(
			and(
				eq(scanStageLaneRuntimes.scanJobId, input.scanJobId),
				eq(scanStageLaneRuntimes.stageName, input.stageName),
				eq(scanStageLaneRuntimes.laneIndex, input.laneIndex),
			),
		)
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

export const resetStageLaneRuntimeByLaneForExitRepo = async (input: {
	scanJobId: string;
	stageName: string;
	laneIndex: number;
	taskId?: string | null;
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
			lastExitTaskId: input.taskId ?? null,
			lastExitAt: now,
			updatedAt: now,
		})
		.where(
			and(
				eq(scanStageLaneRuntimes.scanJobId, input.scanJobId),
				eq(scanStageLaneRuntimes.stageName, input.stageName),
				eq(scanStageLaneRuntimes.laneIndex, input.laneIndex),
			),
		)
		.returning();
};

export const findActiveStageGroupInstanceByLeaderLaneRepo = async (input: {
	scanJobId: string;
	groupName: string;
	leaderStageName: string;
	leaderLaneIndex: number;
}) =>
	await db
		.select()
		.from(scanStageGroupInstances)
		.where(
			and(
				eq(scanStageGroupInstances.scanJobId, input.scanJobId),
				eq(scanStageGroupInstances.groupName, input.groupName),
				eq(scanStageGroupInstances.leaderStageName, input.leaderStageName),
				eq(scanStageGroupInstances.leaderLaneIndex, input.leaderLaneIndex),
				eq(scanStageGroupInstances.status, "active"),
			),
		)
		.limit(1)
		.then((rows) => rows[0] || null);

export const createStageGroupInstanceRepo = async (input: {
	scanJobId: string;
	groupName: string;
	leaderStageName: string;
	leaderLaneIndex: number;
	leaderTaskId: string;
}) => {
	const created = await db
		.insert(scanStageGroupInstances)
		.values({
			scanJobId: input.scanJobId,
			groupName: input.groupName,
			leaderStageName: input.leaderStageName,
			leaderLaneIndex: input.leaderLaneIndex,
			leaderTaskId: input.leaderTaskId,
			status: "active",
		})
		.returning()
		.then((rows) => rows[0]);
	if (!created) {
		throw new Error("Failed to create stage group instance");
	}
	return created;
};

export const ensureStageGroupLaneMembershipRepo = async (input: {
	groupInstanceId: string;
	stageName: string;
	laneIndex: number;
	role: "leader" | "member";
}) =>
	await db
		.insert(scanStageGroupLaneMemberships)
		.values({
			groupInstanceId: input.groupInstanceId,
			stageName: input.stageName,
			laneIndex: input.laneIndex,
			role: input.role,
		})
		.onConflictDoUpdate({
			target: [
				scanStageGroupLaneMemberships.groupInstanceId,
				scanStageGroupLaneMemberships.stageName,
			],
			set: {
				laneIndex: input.laneIndex,
				role: input.role,
				updatedAt: new Date().toISOString(),
			},
		});

export const findStageGroupLaneMembershipRepo = async (input: {
	groupInstanceId: string;
	stageName: string;
}) =>
	await db
		.select()
		.from(scanStageGroupLaneMemberships)
		.where(
			and(
				eq(scanStageGroupLaneMemberships.groupInstanceId, input.groupInstanceId),
				eq(scanStageGroupLaneMemberships.stageName, input.stageName),
			),
		)
		.limit(1)
		.then((rows) => rows[0] || null);

export const listActiveStageGroupLaneMembershipsForStageRepo = async (input: {
	scanJobId: string;
	stageName: string;
}) =>
	await db
		.select({
			groupInstanceId: scanStageGroupLaneMemberships.groupInstanceId,
			stageName: scanStageGroupLaneMemberships.stageName,
			laneIndex: scanStageGroupLaneMemberships.laneIndex,
			role: scanStageGroupLaneMemberships.role,
		})
		.from(scanStageGroupLaneMemberships)
		.innerJoin(
			scanStageGroupInstances,
			eq(
				scanStageGroupLaneMemberships.groupInstanceId,
				scanStageGroupInstances.groupInstanceId,
			),
		)
		.where(
			and(
				eq(scanStageGroupInstances.scanJobId, input.scanJobId),
				eq(scanStageGroupInstances.status, "active"),
				eq(scanStageGroupLaneMemberships.stageName, input.stageName),
			),
		);

export const findStageGroupInstanceByIdRepo = async (groupInstanceId: string) =>
	await db
		.select()
		.from(scanStageGroupInstances)
		.where(eq(scanStageGroupInstances.groupInstanceId, groupInstanceId))
		.limit(1)
		.then((rows) => rows[0] || null);

export const listStageGroupInstancesByScanJobIdRepo = async (scanJobId: string) =>
	await db
		.select()
		.from(scanStageGroupInstances)
		.where(eq(scanStageGroupInstances.scanJobId, scanJobId));

export const markStageGroupInstanceExitedRepo = async (groupInstanceId: string) =>
	await db
		.update(scanStageGroupInstances)
		.set({
			status: "exited",
			updatedAt: new Date().toISOString(),
		})
		.where(eq(scanStageGroupInstances.groupInstanceId, groupInstanceId))
		.returning()
		.then((rows) => rows[0] || null);

export const listStageGroupLaneMembershipsRepo = async (groupInstanceId: string) =>
	await db
		.select()
		.from(scanStageGroupLaneMemberships)
		.where(eq(scanStageGroupLaneMemberships.groupInstanceId, groupInstanceId));
