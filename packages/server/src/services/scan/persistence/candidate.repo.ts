import { TRPCError } from "@trpc/server";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@dokploy/server/db";
import { vulnerabilityCandidateStatusEnum, vulnerabilityCandidates } from "@dokploy/server/db/schema";

export const findVulnerabilityCandidatesByScanJobIdRepo = async (scanJobId: string) =>
  await db.select().from(vulnerabilityCandidates).where(eq(vulnerabilityCandidates.scanJobId, scanJobId)).orderBy(desc(vulnerabilityCandidates.createdAt));

export const findVulnerabilityCandidateByIdRepo = async (
  vulnerabilityCandidateId: string,
) => {
  const candidate = await db
    .select()
    .from(vulnerabilityCandidates)
    .where(
      eq(
        vulnerabilityCandidates.vulnerabilityCandidateId,
        vulnerabilityCandidateId,
      ),
    )
    .limit(1)
    .then((rows) => rows[0] || null);

  if (!candidate) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Vulnerability candidate not found",
    });
  }

  return candidate;
};

export const createVulnerabilityCandidateRepo = async (input: {
  scanJobId: string;
  scanFunctionTaskId?: string;
  title: string;
  description?: string;
  filePath?: string;
  line?: number;
  confidence?: number;
  score?: number;
  status?: (typeof vulnerabilityCandidateStatusEnum.enumValues)[number];
  currentStage?: "analyzing" | "fuzzing" | "verifying";
}) => {
  const existing = await db
    .select()
    .from(vulnerabilityCandidates)
    .where(
      sql`${vulnerabilityCandidates.scanJobId} = ${input.scanJobId}
        and ${vulnerabilityCandidates.title} = ${input.title}
        and ${vulnerabilityCandidates.filePath} is not distinct from ${input.filePath ?? null}
        and ${vulnerabilityCandidates.line} is not distinct from ${input.line ?? null}`,
    )
    .limit(1)
    .then((rows) => rows[0] || null);

  if (existing) {
    const patch: Partial<typeof vulnerabilityCandidates.$inferSelect> = {
      updatedAt: new Date().toISOString(),
    };
    if (input.description && input.description !== existing.description) {
      patch.description = input.description;
    }
    if (typeof input.confidence === "number") {
      patch.confidence = input.confidence;
    }
    if (typeof input.score === "number") {
      patch.score = input.score;
    }
    if (input.scanFunctionTaskId && input.scanFunctionTaskId !== existing.scanFunctionTaskId) {
      patch.scanFunctionTaskId = input.scanFunctionTaskId;
    }
    if (Object.keys(patch).length > 1) {
      await db
        .update(vulnerabilityCandidates)
        .set(patch)
        .where(
          eq(
            vulnerabilityCandidates.vulnerabilityCandidateId,
            existing.vulnerabilityCandidateId,
          ),
        );
    }
    return existing;
  }

  const created = await db
    .insert(vulnerabilityCandidates)
    .values({
      scanJobId: input.scanJobId,
      scanFunctionTaskId: input.scanFunctionTaskId,
      title: input.title,
      description: input.description || "",
      filePath: input.filePath,
      line: input.line,
      confidence: input.confidence,
      score: input.score,
      status: input.status || "queued",
      currentStage: input.currentStage || "analyzing",
      updatedAt: new Date().toISOString(),
    })
    .returning();

  if (!created[0]) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Error creating vulnerability candidate",
    });
  }

  return created[0];
};

export const updateVulnerabilityCandidateRepo = async (
  vulnerabilityCandidateId: string,
  patch: Partial<typeof vulnerabilityCandidates.$inferSelect>,
) => {
  const updated = await db
    .update(vulnerabilityCandidates)
    .set({
      ...patch,
      updatedAt: new Date().toISOString(),
    })
    .where(
      eq(
        vulnerabilityCandidates.vulnerabilityCandidateId,
        vulnerabilityCandidateId,
      ),
    )
    .returning();

  return updated[0] || null;
};

export const updateVulnerabilityCandidateStatusRepo = async (
  vulnerabilityCandidateId: string,
  status: (typeof vulnerabilityCandidateStatusEnum.enumValues)[number],
) =>
  await updateVulnerabilityCandidateRepo(vulnerabilityCandidateId, {
    status,
  });

export const updateVulnerabilityCandidateCurrentStageRepo = async (
  vulnerabilityCandidateId: string,
  currentStage: "analyzing" | "fuzzing" | "verifying",
) =>
  await updateVulnerabilityCandidateRepo(vulnerabilityCandidateId, {
    currentStage,
  });

export const updateVulnerabilityCandidateAnalysisThreadIdRepo = async (
  vulnerabilityCandidateId: string,
  analysisThreadId: string,
) =>
  await updateVulnerabilityCandidateRepo(vulnerabilityCandidateId, {
    analysisThreadId,
  });

export const updateVulnerabilityCandidateVerifierThreadIdRepo = async (
  vulnerabilityCandidateId: string,
  verifierThreadId: string,
) =>
  await updateVulnerabilityCandidateRepo(vulnerabilityCandidateId, {
    verifierThreadId,
  });

export const updateVulnerabilityCandidateRiskMetricsRepo = async (
  vulnerabilityCandidateId: string,
  input: {
    confidence?: number;
    score?: number;
  },
) => {
  const patch: Partial<typeof vulnerabilityCandidates.$inferSelect> = {};
  if (input.confidence !== undefined) {
    patch.confidence = input.confidence;
  }
  if (input.score !== undefined) {
    patch.score = input.score;
  }
  return await updateVulnerabilityCandidateRepo(vulnerabilityCandidateId, patch);
};

export const resetFailedAnalysisCandidateForRetryRepo = async (
  vulnerabilityCandidateId: string,
) =>
  await updateVulnerabilityCandidateRepo(vulnerabilityCandidateId, {
    status: "queued",
    currentStage: "analyzing",
  });

export const resetFailedVerificationCandidateForRetryRepo = async (
  vulnerabilityCandidateId: string,
) =>
  await updateVulnerabilityCandidateRepo(vulnerabilityCandidateId, {
    status: "queued",
    currentStage: "verifying",
  });
