import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { db } from "@dokploy/server/db";
import { scanRepositoryTasks, scanTaskStatusEnum } from "@dokploy/server/db/schema";

export const createScanRepositoryTaskRepo = async (input: {
	scanJobId: string;
	status?: (typeof scanTaskStatusEnum.enumValues)[number];
	containerName?: string;
	threadId?: string;
	repositoryScanMdPath?: string;
	repositoryScanJsonPath?: string;
	modulePlanJsonPath?: string;
}) => {
	const created = await db
		.insert(scanRepositoryTasks)
		.values({
			scanJobId: input.scanJobId,
			status: input.status ?? "queued",
			containerName: input.containerName,
			threadId: input.threadId,
			repositoryScanMdPath: input.repositoryScanMdPath,
			repositoryScanJsonPath: input.repositoryScanJsonPath,
			modulePlanJsonPath: input.modulePlanJsonPath,
		})
		.returning();

	if (!created[0]) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error creating scan repository task",
		});
	}

	return created[0];
};

export const findScanRepositoryTaskByScanJobIdRepo = async (scanJobId: string) => {
	const row = await db
		.select()
		.from(scanRepositoryTasks)
		.where(eq(scanRepositoryTasks.scanJobId, scanJobId))
		.limit(1)
		.then((rows) => rows[0] || null);

	if (!row) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Scan repository task not found",
		});
	}

	return row;
};

export const findScanRepositoryTaskByIdRepo = async (
	scanRepositoryTaskId: string,
) => {
	const row = await db
		.select()
		.from(scanRepositoryTasks)
		.where(eq(scanRepositoryTasks.scanRepositoryTaskId, scanRepositoryTaskId))
		.limit(1)
		.then((rows) => rows[0] || null);

	if (!row) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Scan repository task not found",
		});
	}

	return row;
};

export const updateScanRepositoryTaskRepo = async (
	scanRepositoryTaskId: string,
	patch: Partial<typeof scanRepositoryTasks.$inferSelect>,
) => {
	const updated = await db
		.update(scanRepositoryTasks)
		.set({
			...patch,
			updatedAt: new Date().toISOString(),
		})
		.where(eq(scanRepositoryTasks.scanRepositoryTaskId, scanRepositoryTaskId))
		.returning();

	if (!updated[0]) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Scan repository task not found",
		});
	}

	return updated[0];
};

export const updateScanRepositoryTaskStatusRepo = async (
	scanRepositoryTaskId: string,
	status: (typeof scanTaskStatusEnum.enumValues)[number],
	errorMessage?: string,
) => {
	const patch: Partial<typeof scanRepositoryTasks.$inferSelect> = {
		status,
		errorMessage,
	};
	if (status === "running") {
		patch.startedAt = new Date().toISOString();
	}
	if (status === "completed" || status === "failed") {
		patch.completedAt = new Date().toISOString();
	}
	return await updateScanRepositoryTaskRepo(scanRepositoryTaskId, patch);
};
