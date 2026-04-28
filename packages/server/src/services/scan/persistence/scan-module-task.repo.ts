import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@dokploy/server/db";
import { scanTaskStatusEnum, scanModuleTasks } from "@dokploy/server/db/schema";
import { recalculateScanTaskCountsRepo } from "./scan-job.repo";

export const findScanModuleTaskByIdRepo = async (scanModuleTaskId: string) => {
  const task = await db
    .select()
    .from(scanModuleTasks)
    .where(eq(scanModuleTasks.scanModuleTaskId, scanModuleTaskId))
    .limit(1)
    .then((rows) => rows[0] || null);
  if (!task) throw new TRPCError({ code: "NOT_FOUND", message: "Scan module task not found" });
  return task;
};

export const listScanModuleTasksByScanJobIdRepo = async (scanJobId: string) =>
  await db.select().from(scanModuleTasks).where(eq(scanModuleTasks.scanJobId, scanJobId)).orderBy(desc(scanModuleTasks.createdAt));

export const findScanModuleTaskByScanJobAndModuleIdRepo = async (
  scanJobId: string,
  moduleId: string,
) =>
  await db
    .select()
    .from(scanModuleTasks)
    .where(
      and(
        eq(scanModuleTasks.scanJobId, scanJobId),
        eq(scanModuleTasks.moduleId, moduleId),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] || null);

export const createScanModuleTaskRepo = async (input: {
  scanJobId: string;
  moduleId: string;
  moduleName: string;
  priority?: number;
  attempt?: number;
  moduleScanMdPath?: string;
  moduleScanJsonPath?: string;
  functionPlanJsonPath?: string;
  containerName?: string;
  threadId?: string;
}) => {
  const created = await db
    .insert(scanModuleTasks)
    .values({
      scanJobId: input.scanJobId,
      moduleId: input.moduleId,
      moduleName: input.moduleName,
      priority: input.priority ?? 0,
      attempt: input.attempt ?? 0,
      moduleScanMdPath: input.moduleScanMdPath,
      moduleScanJsonPath: input.moduleScanJsonPath,
      functionPlanJsonPath: input.functionPlanJsonPath,
      containerName: input.containerName,
      threadId: input.threadId,
    })
    .returning();

  await recalculateScanTaskCountsRepo(input.scanJobId);

  if (!created[0]) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Error creating scan module task" });
  }

  return created[0];
};

export const updateScanModuleTaskRepo = async (
  scanModuleTaskId: string,
  patch: Partial<typeof scanModuleTasks.$inferSelect>,
) => {
  const now = new Date().toISOString();
  const updated = await db
    .update(scanModuleTasks)
    .set({
      ...patch,
      updatedAt: now,
    })
    .where(eq(scanModuleTasks.scanModuleTaskId, scanModuleTaskId))
    .returning();

  const row = updated[0];
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Scan module task not found" });
  }

  await recalculateScanTaskCountsRepo(row.scanJobId);
  return row;
};

export const updateScanModuleTaskStatusRepo = async (
  scanModuleTaskId: string,
  status: (typeof scanTaskStatusEnum.enumValues)[number],
  errorMessage?: string,
) => {
  const patch: Partial<typeof scanModuleTasks.$inferSelect> = {
    status,
    errorMessage,
  };
  if (status === "running") {
    patch.startedAt = new Date().toISOString();
  }
  if (status === "completed" || status === "failed") {
    patch.completedAt = new Date().toISOString();
  }
  return await updateScanModuleTaskRepo(scanModuleTaskId, patch);
};

export const resetFailedScanModuleTaskForRetryRepo = async (
  scanModuleTaskId: string,
) => {
  const updated = await db
    .update(scanModuleTasks)
    .set({
      status: "queued",
      errorMessage: null,
      startedAt: null,
      completedAt: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(scanModuleTasks.scanModuleTaskId, scanModuleTaskId))
    .returning();

  const row = updated[0];
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Scan module task not found" });
  }

  await recalculateScanTaskCountsRepo(row.scanJobId);
  return row;
};

export const upsertModuleTaskFromPlanRepo = async (input: {
  scanJobId: string;
  moduleId: string;
  moduleName: string;
  priority: number;
  moduleScanMdPath?: string;
  moduleScanJsonPath?: string;
  functionPlanJsonPath?: string;
  status?: (typeof scanTaskStatusEnum.enumValues)[number];
  attempt?: number;
  startedAt?: string;
  completedAt?: string;
  errorMessage?: string;
}) => {
  const existing = await findScanModuleTaskByScanJobAndModuleIdRepo(
    input.scanJobId,
    input.moduleId,
  );

  const patch = {
    moduleName: input.moduleName,
    priority: input.priority,
    moduleScanMdPath: input.moduleScanMdPath,
    moduleScanJsonPath: input.moduleScanJsonPath,
    functionPlanJsonPath: input.functionPlanJsonPath,
    status: input.status,
    attempt: input.attempt,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    errorMessage: input.errorMessage,
  };

  if (existing) {
    return await updateScanModuleTaskRepo(existing.scanModuleTaskId, patch);
  }

  return await createScanModuleTaskRepo({
    scanJobId: input.scanJobId,
    moduleId: input.moduleId,
    moduleName: input.moduleName,
    priority: input.priority,
    attempt: input.attempt,
    moduleScanMdPath: input.moduleScanMdPath,
    moduleScanJsonPath: input.moduleScanJsonPath,
    functionPlanJsonPath: input.functionPlanJsonPath,
  });
};
