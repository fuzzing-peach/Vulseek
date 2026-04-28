import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@dokploy/server/db";
import {
	candidateAnalysisTasks,
	scanTaskStatusEnum,
	vulnerabilityCandidates,
} from "@dokploy/server/db/schema";

export const createAnalysisResultRepo = async (input: {
  scanJobId: string;
  vulnerabilityCandidateId: string;
  result: string;
  confidence?: number;
  score?: number;
  reportPath?: string;
  runtimeSeconds?: number;
  threadId?: string;
  containerName?: string;
  summary?: string;
}) => {
  const existing = await db
    .select()
    .from(candidateAnalysisTasks)
    .where(
      eq(
        candidateAnalysisTasks.vulnerabilityCandidateId,
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
    confidence: input.confidence,
    score: input.score,
    reportPath: input.reportPath,
    runtimeSeconds: input.runtimeSeconds,
    threadId: input.threadId,
    containerName: input.containerName,
    summary: input.summary || "",
    completedAt: now,
    updatedAt: now,
  };

  const created = existing
    ? await db
        .update(candidateAnalysisTasks)
        .set(values)
        .where(
          eq(
            candidateAnalysisTasks.vulnerabilityCandidateId,
            input.vulnerabilityCandidateId,
          ),
        )
        .returning()
    : await db
        .insert(candidateAnalysisTasks)
        .values(values)
        .returning();

  if (!created[0]) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Error creating analysis result",
    });
  }

	return created[0];
};

export const ensureCandidateAnalysisTaskRepo = async (input: {
	scanJobId: string;
	vulnerabilityCandidateId: string;
}) => {
	const existing = await db
		.select()
		.from(candidateAnalysisTasks)
		.where(
			eq(
				candidateAnalysisTasks.vulnerabilityCandidateId,
				input.vulnerabilityCandidateId,
			),
		)
		.limit(1)
		.then((rows) => rows[0] || null);

	if (existing) {
		return existing;
	}

	const created = await db
		.insert(candidateAnalysisTasks)
		.values({
			scanJobId: input.scanJobId,
			vulnerabilityCandidateId: input.vulnerabilityCandidateId,
			status: "queued",
		})
		.returning();

	if (!created[0]) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error creating candidate analysis task",
		});
	}

	return created[0];
};

export const updateCandidateAnalysisTaskRepo = async (
	candidateAnalysisTaskId: string,
	patch: Partial<typeof candidateAnalysisTasks.$inferSelect>,
) => {
	const updated = await db
		.update(candidateAnalysisTasks)
		.set({
			...patch,
			updatedAt: new Date().toISOString(),
		})
		.where(
			eq(
				candidateAnalysisTasks.candidateAnalysisTaskId,
				candidateAnalysisTaskId,
			),
		)
		.returning();

	if (!updated[0]) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Candidate analysis task not found",
		});
	}

	return updated[0];
};

export const updateCandidateAnalysisTaskStatusRepo = async (
	candidateAnalysisTaskId: string,
	status: (typeof scanTaskStatusEnum.enumValues)[number],
	errorMessage?: string,
) => {
	const patch: Partial<typeof candidateAnalysisTasks.$inferSelect> = {
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
		.update(candidateAnalysisTasks)
		.set({
			...patch,
			updatedAt: new Date().toISOString(),
		})
		.where(
			eq(
				candidateAnalysisTasks.candidateAnalysisTaskId,
				candidateAnalysisTaskId,
			),
		)
		.returning();

	if (!updated[0]) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Candidate analysis task not found",
		});
	}

	return updated[0];
};

export const findCandidateAnalysisTaskByCandidateIdRepo = async (
	vulnerabilityCandidateId: string,
 ) =>
	await db
		.select()
		.from(candidateAnalysisTasks)
		.where(
			eq(
				candidateAnalysisTasks.vulnerabilityCandidateId,
				vulnerabilityCandidateId,
			),
		)
		.limit(1)
		.then((rows) => rows[0] || null);

export const listAnalysisResultsByScanJobIdRepo = async (scanJobId: string) =>
  await db
    .select({
      analysisResultId: candidateAnalysisTasks.candidateAnalysisTaskId,
      candidateAnalysisTaskId: candidateAnalysisTasks.candidateAnalysisTaskId,
      scanJobId: candidateAnalysisTasks.scanJobId,
      vulnerabilityCandidateId: candidateAnalysisTasks.vulnerabilityCandidateId,
      result: candidateAnalysisTasks.result,
      confidence: candidateAnalysisTasks.confidence,
      score: candidateAnalysisTasks.score,
      reportPath: candidateAnalysisTasks.reportPath,
      runtimeSeconds: candidateAnalysisTasks.runtimeSeconds,
      threadId: candidateAnalysisTasks.threadId,
      summary: candidateAnalysisTasks.summary,
      status: candidateAnalysisTasks.status,
      createdAt: candidateAnalysisTasks.createdAt,
      updatedAt: candidateAnalysisTasks.updatedAt,
    })
    .from(candidateAnalysisTasks)
    .innerJoin(
      vulnerabilityCandidates,
      eq(
        candidateAnalysisTasks.vulnerabilityCandidateId,
        vulnerabilityCandidates.vulnerabilityCandidateId,
      ),
    )
    .where(eq(vulnerabilityCandidates.scanJobId, scanJobId))
    .orderBy(desc(candidateAnalysisTasks.createdAt));

export const findLatestAnalysisResultByCandidateIdRepo = async (
  vulnerabilityCandidateId: string,
) => {
  const result = await db
    .select({
      analysisResultId: candidateAnalysisTasks.candidateAnalysisTaskId,
      candidateAnalysisTaskId: candidateAnalysisTasks.candidateAnalysisTaskId,
      scanJobId: candidateAnalysisTasks.scanJobId,
      vulnerabilityCandidateId: candidateAnalysisTasks.vulnerabilityCandidateId,
      result: candidateAnalysisTasks.result,
      confidence: candidateAnalysisTasks.confidence,
      score: candidateAnalysisTasks.score,
      reportPath: candidateAnalysisTasks.reportPath,
      runtimeSeconds: candidateAnalysisTasks.runtimeSeconds,
      threadId: candidateAnalysisTasks.threadId,
      summary: candidateAnalysisTasks.summary,
      status: candidateAnalysisTasks.status,
      createdAt: candidateAnalysisTasks.createdAt,
      updatedAt: candidateAnalysisTasks.updatedAt,
    })
    .from(candidateAnalysisTasks)
    .where(
      eq(candidateAnalysisTasks.vulnerabilityCandidateId, vulnerabilityCandidateId),
    )
    .orderBy(desc(candidateAnalysisTasks.createdAt))
    .limit(1);

  return result[0] || null;
};

export const deleteAnalysisResultsByCandidateIdRepo = async (
  vulnerabilityCandidateId: string,
) => {
  await db
    .delete(candidateAnalysisTasks)
    .where(
      eq(
        candidateAnalysisTasks.vulnerabilityCandidateId,
        vulnerabilityCandidateId,
      ),
    );
};
