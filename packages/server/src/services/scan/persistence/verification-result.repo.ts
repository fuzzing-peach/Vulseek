import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@dokploy/server/db";
import {
	candidateVerificationTasks,
	scanTaskStatusEnum,
	vulnerabilityCandidates,
} from "@dokploy/server/db/schema";

export const createVerificationResultRepo = async (input: {
  scanJobId: string;
  vulnerabilityCandidateId: string;
  result: string;
  isBug?: boolean;
  isSecurity?: boolean;
  confidence?: number;
  score?: number;
  reportPath?: string;
  issueDraftPath?: string;
  pocPath?: string;
  dockerfilePath?: string;
  runScriptPath?: string;
  runtimeSeconds?: number;
  threadId?: string;
  containerName?: string;
  summary?: string;
}) => {
  const existing = await db
    .select()
    .from(candidateVerificationTasks)
    .where(
      eq(
        candidateVerificationTasks.vulnerabilityCandidateId,
        input.vulnerabilityCandidateId,
      ),
    )
    .limit(1)
    .then((rows) => rows[0] || null);

  const now = new Date().toISOString();
  const values = {
    scanJobId: input.scanJobId,
    vulnerabilityCandidateId: input.vulnerabilityCandidateId,
    status: "completed" as const,
    result: input.result,
    isBug: input.isBug,
    isSecurity: input.isSecurity,
    confidence: input.confidence,
    score: input.score,
    reportPath: input.reportPath,
    issueDraftPath: input.issueDraftPath,
    pocPath: input.pocPath,
    dockerfilePath: input.dockerfilePath,
    runScriptPath: input.runScriptPath,
    runtimeSeconds: input.runtimeSeconds,
    threadId: input.threadId,
    containerName: input.containerName,
    summary: input.summary || "",
    completedAt: now,
    updatedAt: now,
  };
  const created = existing
    ? await db
        .update(candidateVerificationTasks)
        .set(values)
        .where(
          eq(
            candidateVerificationTasks.vulnerabilityCandidateId,
            input.vulnerabilityCandidateId,
          ),
        )
        .returning()
    : await db
        .insert(candidateVerificationTasks)
        .values(values)
        .returning();

  if (!created[0]) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Error creating verification result",
    });
  }

	return created[0];
};

export const ensureCandidateVerificationTaskRepo = async (input: {
	scanJobId: string;
	vulnerabilityCandidateId: string;
}) => {
	const existing = await db
		.select()
		.from(candidateVerificationTasks)
		.where(
			eq(
				candidateVerificationTasks.vulnerabilityCandidateId,
				input.vulnerabilityCandidateId,
			),
		)
		.limit(1)
		.then((rows) => rows[0] || null);

	if (existing) {
		return existing;
	}

	const created = await db
		.insert(candidateVerificationTasks)
		.values({
			scanJobId: input.scanJobId,
			vulnerabilityCandidateId: input.vulnerabilityCandidateId,
			status: "queued",
		})
		.returning();

	if (!created[0]) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error creating candidate verification task",
		});
	}

	return created[0];
};

export const updateCandidateVerificationTaskRepo = async (
	candidateVerificationTaskId: string,
	patch: Partial<typeof candidateVerificationTasks.$inferSelect>,
) => {
	const updated = await db
		.update(candidateVerificationTasks)
		.set({
			...patch,
			updatedAt: new Date().toISOString(),
		})
		.where(
			eq(
				candidateVerificationTasks.candidateVerificationTaskId,
				candidateVerificationTaskId,
			),
		)
		.returning();

	if (!updated[0]) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Candidate verification task not found",
		});
	}

	return updated[0];
};

export const updateCandidateVerificationTaskStatusRepo = async (
	candidateVerificationTaskId: string,
	status: (typeof scanTaskStatusEnum.enumValues)[number],
	errorMessage?: string,
) => {
	const patch: Partial<typeof candidateVerificationTasks.$inferSelect> = {
		status,
		errorMessage,
	};
	if (status === "running") {
		patch.startedAt = new Date().toISOString();
		patch.completedAt = null;
	}
	if (status === "completed" || status === "failed") {
		patch.completedAt = new Date().toISOString();
	}

	const updated = await db
		.update(candidateVerificationTasks)
		.set({
			...patch,
			updatedAt: new Date().toISOString(),
		})
		.where(
			eq(
				candidateVerificationTasks.candidateVerificationTaskId,
				candidateVerificationTaskId,
			),
		)
		.returning();

	if (!updated[0]) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Candidate verification task not found",
		});
	}

	return updated[0];
};

export const findCandidateVerificationTaskByCandidateIdRepo = async (
	vulnerabilityCandidateId: string,
 ) =>
	await db
		.select()
		.from(candidateVerificationTasks)
		.where(
			eq(
				candidateVerificationTasks.vulnerabilityCandidateId,
				vulnerabilityCandidateId,
			),
		)
		.limit(1)
		.then((rows) => rows[0] || null);

export const listVerificationResultsByScanJobIdRepo = async (scanJobId: string) =>
  await db
    .select({
      verificationResultId: candidateVerificationTasks.candidateVerificationTaskId,
      candidateVerificationTaskId:
        candidateVerificationTasks.candidateVerificationTaskId,
      scanJobId: candidateVerificationTasks.scanJobId,
      vulnerabilityCandidateId:
        candidateVerificationTasks.vulnerabilityCandidateId,
      result: candidateVerificationTasks.result,
      isBug: candidateVerificationTasks.isBug,
      isSecurity: candidateVerificationTasks.isSecurity,
      confidence: candidateVerificationTasks.confidence,
      score: candidateVerificationTasks.score,
      reportPath: candidateVerificationTasks.reportPath,
      issueDraftPath: candidateVerificationTasks.issueDraftPath,
      pocPath: candidateVerificationTasks.pocPath,
      dockerfilePath: candidateVerificationTasks.dockerfilePath,
      runScriptPath: candidateVerificationTasks.runScriptPath,
      runtimeSeconds: candidateVerificationTasks.runtimeSeconds,
      threadId: candidateVerificationTasks.threadId,
      summary: candidateVerificationTasks.summary,
      status: candidateVerificationTasks.status,
      createdAt: candidateVerificationTasks.createdAt,
      updatedAt: candidateVerificationTasks.updatedAt,
    })
    .from(candidateVerificationTasks)
    .innerJoin(
      vulnerabilityCandidates,
      eq(
        candidateVerificationTasks.vulnerabilityCandidateId,
        vulnerabilityCandidates.vulnerabilityCandidateId,
      ),
    )
    .where(eq(vulnerabilityCandidates.scanJobId, scanJobId))
    .orderBy(desc(candidateVerificationTasks.createdAt));

export const findLatestVerificationResultByCandidateIdRepo = async (
  vulnerabilityCandidateId: string,
) => {
  const result = await db
    .select({
      verificationResultId: candidateVerificationTasks.candidateVerificationTaskId,
      candidateVerificationTaskId:
        candidateVerificationTasks.candidateVerificationTaskId,
      scanJobId: candidateVerificationTasks.scanJobId,
      vulnerabilityCandidateId:
        candidateVerificationTasks.vulnerabilityCandidateId,
      result: candidateVerificationTasks.result,
      isBug: candidateVerificationTasks.isBug,
      isSecurity: candidateVerificationTasks.isSecurity,
      confidence: candidateVerificationTasks.confidence,
      score: candidateVerificationTasks.score,
      reportPath: candidateVerificationTasks.reportPath,
      issueDraftPath: candidateVerificationTasks.issueDraftPath,
      pocPath: candidateVerificationTasks.pocPath,
      dockerfilePath: candidateVerificationTasks.dockerfilePath,
      runScriptPath: candidateVerificationTasks.runScriptPath,
      runtimeSeconds: candidateVerificationTasks.runtimeSeconds,
      threadId: candidateVerificationTasks.threadId,
      summary: candidateVerificationTasks.summary,
      status: candidateVerificationTasks.status,
      createdAt: candidateVerificationTasks.createdAt,
      updatedAt: candidateVerificationTasks.updatedAt,
    })
    .from(candidateVerificationTasks)
    .where(
      eq(
        candidateVerificationTasks.vulnerabilityCandidateId,
        vulnerabilityCandidateId,
      ),
    )
    .orderBy(desc(candidateVerificationTasks.createdAt))
    .limit(1);

  return result[0] || null;
};

export const deleteVerificationResultsByCandidateIdRepo = async (
  vulnerabilityCandidateId: string,
) => {
  await db
    .delete(candidateVerificationTasks)
    .where(
      eq(
        candidateVerificationTasks.vulnerabilityCandidateId,
        vulnerabilityCandidateId,
      ),
    );
};
