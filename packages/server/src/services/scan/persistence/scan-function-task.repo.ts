import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@dokploy/server/db";
import { scanTaskStatusEnum, scanFunctionTasks } from "@dokploy/server/db/schema";
import { recalculateScanTaskCountsRepo } from "./scan-job.repo";

export const findScanFunctionTaskByIdRepo = async (scanFunctionTaskId: string) => {
  const task = await db
    .select()
    .from(scanFunctionTasks)
    .where(eq(scanFunctionTasks.scanFunctionTaskId, scanFunctionTaskId))
    .limit(1)
    .then((rows) => rows[0] || null);
  if (!task) throw new TRPCError({ code: "NOT_FOUND", message: "Scan function task not found" });
  return task;
};

export const listScanFunctionTasksByScanJobIdRepo = async (scanJobId: string) =>
  await db.select().from(scanFunctionTasks).where(eq(scanFunctionTasks.scanJobId, scanJobId)).orderBy(desc(scanFunctionTasks.createdAt));

export const listScanFunctionTasksByModuleTaskIdRepo = async (
  scanModuleTaskId: string,
) =>
  await db
    .select()
    .from(scanFunctionTasks)
    .where(eq(scanFunctionTasks.scanModuleTaskId, scanModuleTaskId))
    .orderBy(desc(scanFunctionTasks.createdAt));

export const findScanFunctionTaskByScanJobAndFunctionIdRepo = async (
  scanJobId: string,
  functionId: string,
) =>
  await db
    .select()
    .from(scanFunctionTasks)
    .where(
      and(
        eq(scanFunctionTasks.scanJobId, scanJobId),
        eq(scanFunctionTasks.functionId, functionId),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] || null);

export const createScanFunctionTaskRepo = async (input: {
  scanJobId: string;
  scanModuleTaskId: string;
  moduleId: string;
  moduleName: string;
  functionId: string;
  functionName: string;
  filePath?: string;
  line?: number;
  priority?: number;
  attempt?: number;
  score?: number;
  riskType?: string;
  summary?: string;
  functionScanMdPath?: string;
  functionScanJsonPath?: string;
  containerName?: string;
  threadId?: string;
}) => {
  const created = await db
    .insert(scanFunctionTasks)
    .values({
      scanJobId: input.scanJobId,
      scanModuleTaskId: input.scanModuleTaskId,
      moduleId: input.moduleId,
      moduleName: input.moduleName,
      functionId: input.functionId,
      functionName: input.functionName,
      filePath: input.filePath,
      line: input.line,
      priority: input.priority ?? 0,
      attempt: input.attempt ?? 0,
      score: input.score,
      riskType: input.riskType,
      summary: input.summary,
      functionScanMdPath: input.functionScanMdPath,
      functionScanJsonPath: input.functionScanJsonPath,
      containerName: input.containerName,
      threadId: input.threadId,
    })
    .returning();

  await recalculateScanTaskCountsRepo(input.scanJobId);

  if (!created[0]) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Error creating scan function task" });
  }

  return created[0];
};

export const updateScanFunctionTaskRepo = async (
  scanFunctionTaskId: string,
  patch: Partial<typeof scanFunctionTasks.$inferSelect>,
) => {
  const now = new Date().toISOString();
  const updated = await db
    .update(scanFunctionTasks)
    .set({
      ...patch,
      updatedAt: now,
    })
    .where(eq(scanFunctionTasks.scanFunctionTaskId, scanFunctionTaskId))
    .returning();

  const row = updated[0];
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Scan function task not found" });
  }

  await recalculateScanTaskCountsRepo(row.scanJobId);
  return row;
};

export const updateScanFunctionTaskStatusRepo = async (
  scanFunctionTaskId: string,
  status: (typeof scanTaskStatusEnum.enumValues)[number],
  errorMessage?: string,
) => {
  const patch: Partial<typeof scanFunctionTasks.$inferSelect> = {
    status,
    errorMessage,
  };
  if (status === "running") {
    patch.startedAt = new Date().toISOString();
  }
  if (status === "completed" || status === "failed") {
    patch.completedAt = new Date().toISOString();
  }
  return await updateScanFunctionTaskRepo(scanFunctionTaskId, patch);
};

export const resetFailedScanFunctionTaskForRetryRepo = async (
  scanFunctionTaskId: string,
) => {
  const updated = await db
    .update(scanFunctionTasks)
    .set({
      status: "queued",
      errorMessage: null,
      startedAt: null,
      completedAt: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(scanFunctionTasks.scanFunctionTaskId, scanFunctionTaskId))
    .returning();

  const row = updated[0];
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Scan function task not found" });
  }

  await recalculateScanTaskCountsRepo(row.scanJobId);
  return row;
};

export const upsertFunctionTaskFromPlanRepo = async (input: {
  scanJobId: string;
  functionId: string;
  scanModuleTaskId: string;
  moduleId: string;
  moduleName: string;
  functionName: string;
  filePath?: string;
  line?: number;
  priority: number;
  score?: number;
  riskType?: string;
  summary?: string;
}) => {
  const existing = await findScanFunctionTaskByScanJobAndFunctionIdRepo(
    input.scanJobId,
    input.functionId,
  );

  const patch = {
    scanModuleTaskId: input.scanModuleTaskId,
    moduleId: input.moduleId,
    moduleName: input.moduleName,
    functionName: input.functionName,
    filePath: input.filePath,
    line: input.line,
    priority: input.priority,
    score: input.score,
    riskType: input.riskType,
    summary: input.summary,
  };

  if (existing) {
    return await updateScanFunctionTaskRepo(
      existing.scanFunctionTaskId,
      patch,
    );
  }

  return await createScanFunctionTaskRepo({
    scanJobId: input.scanJobId,
    scanModuleTaskId: input.scanModuleTaskId,
    moduleId: input.moduleId,
    moduleName: input.moduleName,
    functionId: input.functionId,
    functionName: input.functionName,
    filePath: input.filePath,
    line: input.line,
    priority: input.priority,
    attempt: 0,
    score: input.score,
    riskType: input.riskType,
    summary: input.summary,
    functionScanJsonPath: undefined,
    functionScanMdPath: undefined,
  });
};
