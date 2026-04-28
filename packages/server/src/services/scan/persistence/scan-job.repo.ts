import { TRPCError } from "@trpc/server";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@dokploy/server/db";
import {
	scanFunctionTasks,
	scanJobs,
	scanModuleTasks,
	scanRepositoryTasks,
} from "@dokploy/server/db/schema";

const selectScanJobWithRepositoryTaskStatus = {
	scanJobId: scanJobs.scanJobId,
	title: scanJobs.title,
	description: scanJobs.description,
	note: scanJobs.note,
	scanType: scanJobs.scanType,
	status: scanJobs.status,
	scanPhase: scanJobs.scanPhase,
	triggerSource: scanJobs.triggerSource,
	commitSha: scanJobs.commitSha,
	baseSha: scanJobs.baseSha,
	targetRef: scanJobs.targetRef,
	targetTag: scanJobs.targetTag,
	commitWindow: scanJobs.commitWindow,
	moduleTasksTotal: scanJobs.moduleTasksTotal,
	moduleTasksCompleted: scanJobs.moduleTasksCompleted,
	moduleTasksFailed: scanJobs.moduleTasksFailed,
	functionTasksTotal: scanJobs.functionTasksTotal,
	functionTasksCompleted: scanJobs.functionTasksCompleted,
	functionTasksFailed: scanJobs.functionTasksFailed,
	applicationId: scanJobs.applicationId,
	composeId: scanJobs.composeId,
	createdAt: scanJobs.createdAt,
	startedAt: scanJobs.startedAt,
	finishedAt: scanJobs.finishedAt,
	errorMessage: scanJobs.errorMessage,
	scanningThreadId: scanJobs.scanningThreadId,
	repositoryTaskId: scanRepositoryTasks.scanRepositoryTaskId,
	repositoryTaskStatus:
		sql<(typeof scanRepositoryTasks.$inferSelect.status)>`coalesce(${scanRepositoryTasks.status}, 'queued')`,
};

export const findScanJobByIdRepo = async (scanJobId: string) => {
  const scanJob = await db
    .select(selectScanJobWithRepositoryTaskStatus)
    .from(scanJobs)
    .leftJoin(
      scanRepositoryTasks,
      eq(scanRepositoryTasks.scanJobId, scanJobs.scanJobId),
    )
    .where(eq(scanJobs.scanJobId, scanJobId))
    .limit(1)
    .then((rows) => rows[0]);

  if (!scanJob) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Scan job not found" });
  }
  return scanJob;
};

export const listScanJobsByApplicationIdRepo = async (applicationId: string) =>
  await db
    .select(selectScanJobWithRepositoryTaskStatus)
    .from(scanJobs)
    .leftJoin(
      scanRepositoryTasks,
      eq(scanRepositoryTasks.scanJobId, scanJobs.scanJobId),
    )
    .where(eq(scanJobs.applicationId, applicationId))
    .orderBy(desc(scanJobs.createdAt));

export const listScanJobsByComposeIdRepo = async (composeId: string) =>
  await db
    .select(selectScanJobWithRepositoryTaskStatus)
    .from(scanJobs)
    .leftJoin(
      scanRepositoryTasks,
      eq(scanRepositoryTasks.scanJobId, scanJobs.scanJobId),
    )
    .where(eq(scanJobs.composeId, composeId))
    .orderBy(desc(scanJobs.createdAt));

export const listUnfinishedScanJobsRepo = async () =>
  await db
    .select(selectScanJobWithRepositoryTaskStatus)
    .from(scanJobs)
    .leftJoin(
      scanRepositoryTasks,
      eq(scanRepositoryTasks.scanJobId, scanJobs.scanJobId),
    )
    .where(
      sql`${scanJobs.status} <> 'completed' and ${scanJobs.status} <> 'failed'`,
    );

export const createScanJobRepo = async (input: {
  applicationId?: string | null;
  composeId?: string | null;
  scanType: string;
  title?: string | null;
  description?: string | null;
  triggerSource?: string | null;
  commitSha?: string | null;
  baseSha?: string | null;
  targetRef?: string | null;
  targetTag?: string | null;
  commitWindow?: number | null;
  defaultDeltaCommitWindow: number;
}) => {
  const created = await db
    .insert(scanJobs)
    .values({
      applicationId: input.applicationId,
      composeId: input.composeId,
      scanType: input.scanType as typeof scanJobs.$inferInsert.scanType,
      title:
        input.title ||
        (input.scanType === "delta" ? "Delta Scan Job" : "Full Scan Job"),
      description: input.description || "",
      triggerSource: input.triggerSource || "manual",
      commitSha: input.commitSha,
      baseSha: input.baseSha,
      targetRef: input.targetRef,
      targetTag: input.targetTag,
      commitWindow: input.commitWindow || input.defaultDeltaCommitWindow,
      status: "queued",
      scanPhase: "queued",
    })
    .returning();

  if (!created[0]) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Error creating scan job",
    });
  }

  await db.insert(scanRepositoryTasks).values({
    scanJobId: created[0].scanJobId,
    status: "queued",
  });

  return created[0];
};

export const updateScanJobNoteRepo = async (
  scanJobId: string,
  note: string | null,
) => {
  const updated = await db
    .update(scanJobs)
    .set({ note })
    .where(eq(scanJobs.scanJobId, scanJobId))
    .returning();

  if (!updated[0]) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Scan job not found" });
  }

  return updated[0];
};

export const updateScanJobStatusRepo = async (
  scanJobId: string,
  status: typeof scanJobs.$inferSelect.status,
  errorMessage?: string,
) => {
  const patch: Partial<typeof scanJobs.$inferSelect> = {
    status,
  };

  if (status === "analyzing") {
    patch.scanPhase = "analyzing";
  }

  if (status === "verifying") {
    patch.scanPhase = "verifying";
  }

  if (status === "scanning") {
    patch.startedAt = new Date().toISOString();
  }

  if (status === "completed" || status === "failed") {
    patch.finishedAt = new Date().toISOString();
    patch.scanPhase = status;
  }

  if (errorMessage) {
    patch.errorMessage = errorMessage;
  }

  const updated = await db
    .update(scanJobs)
    .set(patch)
    .where(eq(scanJobs.scanJobId, scanJobId))
    .returning();

  if (!updated[0]) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Scan job not found" });
  }

  return updated[0];
};

export const resetScanJobForRetryRepo = async (
  scanJobId: string,
  input?: {
    status?: typeof scanJobs.$inferSelect.status;
    scanPhase?: typeof scanJobs.$inferSelect.scanPhase;
    errorMessage?: string | null;
    repositoryTaskStatus?: typeof scanRepositoryTasks.$inferSelect.status;
  },
) => {
  const updated = await db
    .update(scanJobs)
    .set({
      status: input?.status || "queued",
      scanPhase: input?.scanPhase || "queued",
      errorMessage:
        input && "errorMessage" in input ? (input.errorMessage ?? null) : null,
      finishedAt: null,
      startedAt: null,
    })
    .where(eq(scanJobs.scanJobId, scanJobId))
    .returning();

  if (!updated[0]) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Scan job not found" });
  }

  if (input?.repositoryTaskStatus) {
    await db
      .update(scanRepositoryTasks)
      .set({
        status: input.repositoryTaskStatus,
        errorMessage: null,
        startedAt: null,
        completedAt: null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(scanRepositoryTasks.scanJobId, scanJobId));
  }

  return updated[0];
};

export const resetScanJobForCandidateRetryRepo = async (
  scanJobId: string,
  status: "analyzing" | "verifying",
) => {
  const updated = await db
    .update(scanJobs)
    .set({
      status,
      scanPhase: status,
      errorMessage: null,
      finishedAt: null,
    })
    .where(eq(scanJobs.scanJobId, scanJobId))
    .returning();

  if (!updated[0]) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Scan job not found" });
  }

  return updated[0];
};

export const updateScanJobPhaseRepo = async (scanJobId: string, scanPhase: typeof scanJobs.$inferSelect.scanPhase) => {
  const updated = await db
    .update(scanJobs)
    .set({ scanPhase })
    .where(eq(scanJobs.scanJobId, scanJobId))
    .returning();
  if (!updated[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Scan job not found" });
  return updated[0];
};

export const updateScanJobRepositoryTaskStatusRepo = async (
  scanJobId: string,
  repositoryTaskStatus: typeof scanRepositoryTasks.$inferSelect.status,
) => {
  const repositoryTaskPatch: Partial<typeof scanRepositoryTasks.$inferSelect> = {
    status: repositoryTaskStatus,
    updatedAt: new Date().toISOString(),
  };
  if (repositoryTaskStatus === "running") {
    repositoryTaskPatch.startedAt = new Date().toISOString();
  }
  if (repositoryTaskStatus === "completed" || repositoryTaskStatus === "failed") {
    repositoryTaskPatch.completedAt = new Date().toISOString();
  }
  await db
    .update(scanRepositoryTasks)
    .set(repositoryTaskPatch)
    .where(eq(scanRepositoryTasks.scanJobId, scanJobId));
  return await findScanJobByIdRepo(scanJobId);
};

export const updateScanJobScanningThreadIdRepo = async (scanJobId: string, scanningThreadId: string) => {
  const updated = await db
    .update(scanJobs)
    .set({ scanningThreadId })
    .where(eq(scanJobs.scanJobId, scanJobId))
    .returning();
  await db
    .update(scanRepositoryTasks)
    .set({
      threadId: scanningThreadId,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(scanRepositoryTasks.scanJobId, scanJobId));
  return updated[0] || null;
};

export const updateScanJobTargetContextRepo = async (
  scanJobId: string,
  input: {
    targetRef?: string | null;
    targetTag?: string | null;
    commitSha?: string | null;
    baseSha?: string | null;
    commitWindow?: number | null;
  },
) => {
  const patch: Partial<typeof scanJobs.$inferSelect> = {};
  if (input.targetRef !== undefined) patch.targetRef = input.targetRef || null;
  if (input.targetTag !== undefined) patch.targetTag = input.targetTag || null;
  if (input.commitSha !== undefined) patch.commitSha = input.commitSha || null;
  if (input.baseSha !== undefined) patch.baseSha = input.baseSha || null;
  if (typeof input.commitWindow === "number") patch.commitWindow = input.commitWindow;
  const updated = await db
    .update(scanJobs)
    .set(patch)
    .where(eq(scanJobs.scanJobId, scanJobId))
    .returning();
  return updated[0] || null;
};

export const recalculateScanTaskCountsRepo = async (scanJobId: string) => {
  const moduleRows = await db
    .select({ status: scanModuleTasks.status, count: sql<number>`count(*)::int` })
    .from(scanModuleTasks)
    .where(eq(scanModuleTasks.scanJobId, scanJobId))
    .groupBy(scanModuleTasks.status);
  const functionRows = await db
    .select({ status: scanFunctionTasks.status, count: sql<number>`count(*)::int` })
    .from(scanFunctionTasks)
    .where(eq(scanFunctionTasks.scanJobId, scanJobId))
    .groupBy(scanFunctionTasks.status);

  const countBy = (rows: Array<{ status: string; count: number }>, key: string) =>
    rows.filter((row) => row.status === key).reduce((sum, row) => sum + row.count, 0);

  const updated = await db
    .update(scanJobs)
    .set({
      moduleTasksTotal: moduleRows.reduce((sum, row) => sum + row.count, 0),
      moduleTasksCompleted: countBy(moduleRows, "completed"),
      moduleTasksFailed: countBy(moduleRows, "failed"),
      functionTasksTotal: functionRows.reduce((sum, row) => sum + row.count, 0),
      functionTasksCompleted: countBy(functionRows, "completed"),
      functionTasksFailed: countBy(functionRows, "failed"),
    })
    .where(eq(scanJobs.scanJobId, scanJobId))
    .returning();
  return updated[0] || null;
};

export const listScanModuleTasksByScanJobIdRepo = async (scanJobId: string) =>
  await db.select().from(scanModuleTasks).where(eq(scanModuleTasks.scanJobId, scanJobId)).orderBy(desc(scanModuleTasks.createdAt));
