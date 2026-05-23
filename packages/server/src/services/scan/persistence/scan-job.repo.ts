import { TRPCError } from "@trpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@dokploy/server/db";
import {
	scanJobs,
	tasks,
} from "@dokploy/server/db/schema";
import { createTaskRepo } from "./task.repo";

const selectScanJobWithRepositoryTaskStatus = {
	scanJobId: scanJobs.scanJobId,
	title: scanJobs.title,
	description: scanJobs.description,
	note: scanJobs.note,
	scanType: scanJobs.scanType,
	status: scanJobs.status,
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
	repositoryTaskId: tasks.taskId,
	repositoryTaskStatus:
		sql<(typeof tasks.$inferSelect.status)>`coalesce(${tasks.status}, 'pending')`,
};

export const findScanJobByIdRepo = async (scanJobId: string) => {
  const scanJob = await db
    .select(selectScanJobWithRepositoryTaskStatus)
    .from(scanJobs)
    .leftJoin(
      tasks,
      and(
        eq(tasks.scanJobId, scanJobs.scanJobId),
        eq(tasks.stageName, "repository-scan"),
      ),
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
      tasks,
      and(
        eq(tasks.scanJobId, scanJobs.scanJobId),
        eq(tasks.stageName, "repository-scan"),
      ),
    )
    .where(eq(scanJobs.applicationId, applicationId))
    .orderBy(desc(scanJobs.createdAt));

export const listScanJobsByComposeIdRepo = async (composeId: string) =>
  await db
    .select(selectScanJobWithRepositoryTaskStatus)
    .from(scanJobs)
    .leftJoin(
      tasks,
      and(
        eq(tasks.scanJobId, scanJobs.scanJobId),
        eq(tasks.stageName, "repository-scan"),
      ),
    )
    .where(eq(scanJobs.composeId, composeId))
    .orderBy(desc(scanJobs.createdAt));

export const listUnfinishedScanJobsRepo = async () =>
  await db
    .select(selectScanJobWithRepositoryTaskStatus)
    .from(scanJobs)
    .leftJoin(
      tasks,
      and(
        eq(tasks.scanJobId, scanJobs.scanJobId),
        eq(tasks.stageName, "repository-scan"),
      ),
    )
    .where(
      sql`${scanJobs.status} = 'pending' or ${scanJobs.status} = 'running'`,
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
      status: "pending",
    })
    .returning();

  if (!created[0]) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Error creating scan job",
    });
  }

  await createTaskRepo({
    scanJobId: created[0].scanJobId,
    name: "repository-scanning",
    stageName: "repository-scan",
    status: "pending",
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

  if (status === "running") {
    patch.startedAt = new Date().toISOString();
    patch.finishedAt = null;
  }

  if (status === "finished" || status === "canceled") {
    patch.finishedAt = new Date().toISOString();
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
    errorMessage?: string | null;
    repositoryTaskStatus?: typeof tasks.$inferSelect.status;
  },
) => {
  const updated = await db
    .update(scanJobs)
    .set({
      status: input?.status || "pending",
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
      .update(tasks)
      .set({
        status: input.repositoryTaskStatus,
        errorMessage: null,
        startedAt: null,
        completedAt: null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(tasks.taskId, scanJobId));
  }

  return updated[0];
};

export const updateScanJobRepositoryTaskStatusRepo = async (
  scanJobId: string,
  repositoryTaskStatus: typeof tasks.$inferSelect.status,
) => {
  const repositoryTaskPatch: Partial<typeof tasks.$inferSelect> = {
    status: repositoryTaskStatus,
    updatedAt: new Date().toISOString(),
  };
  if (repositoryTaskStatus === "launching" || repositoryTaskStatus === "running") {
    repositoryTaskPatch.startedAt = new Date().toISOString();
    repositoryTaskPatch.completedAt = null;
  }
  if (repositoryTaskStatus === "completed" || repositoryTaskStatus === "failed" || repositoryTaskStatus === "exited") {
    repositoryTaskPatch.completedAt = new Date().toISOString();
  }
  await db
    .update(tasks)
    .set(repositoryTaskPatch)
    .where(eq(tasks.taskId, scanJobId));
  return await findScanJobByIdRepo(scanJobId);
};

export const updateScanJobScanningThreadIdRepo = async (scanJobId: string, scanningThreadId: string) => {
  const updated = await db
    .update(scanJobs)
    .set({ scanningThreadId })
    .where(eq(scanJobs.scanJobId, scanJobId))
    .returning();
  await db
    .update(tasks)
    .set({
      threadId: scanningThreadId,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(tasks.taskId, scanJobId));
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
  const taskRows = await db
    .select({
      stageName: tasks.stageName,
      status: tasks.status,
      count: sql<number>`count(*)::int`,
    })
    .from(tasks)
    .where(eq(tasks.scanJobId, scanJobId))
    .groupBy(tasks.stageName, tasks.status);

  const countBy = (
    stageName: string,
    status?: string,
  ) =>
    taskRows
      .filter(
        (row) =>
          row.stageName === stageName &&
          (status ? row.status === status : true),
      )
      .reduce((sum, row) => sum + row.count, 0);

  const updated = await db
    .update(scanJobs)
    .set({
      moduleTasksTotal: countBy("module-scan"),
      moduleTasksCompleted: countBy("module-scan", "completed"),
      moduleTasksFailed: countBy("module-scan", "failed"),
      functionTasksTotal: countBy("function-scan"),
      functionTasksCompleted: countBy("function-scan", "completed"),
      functionTasksFailed: countBy("function-scan", "failed"),
    })
    .where(eq(scanJobs.scanJobId, scanJobId))
    .returning();
  return updated[0] || null;
};
