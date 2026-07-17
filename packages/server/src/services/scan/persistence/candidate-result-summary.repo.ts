import { db } from "@vulseek/server/db";
import {
	candidateResultProjections,
	vulnerabilityCandidates,
} from "@vulseek/server/db/schema";
import { and, eq, sql } from "drizzle-orm";
import type { CandidateResultSummaryGroup } from "./candidate-result-summary";

export const listCandidateResultSummaryGroupsByScanJobIdRepo = async (
	scanJobId: string,
): Promise<CandidateResultSummaryGroup[]> =>
	await db
		.select({
			analysisResult: candidateResultProjections.analysisResult,
			verificationResult: candidateResultProjections.verificationResult,
			triageResult: candidateResultProjections.triageResult,
			count: sql<number>`count(*)::int`,
		})
		.from(vulnerabilityCandidates)
		.leftJoin(
			candidateResultProjections,
			and(
				eq(
					candidateResultProjections.scanJobId,
					vulnerabilityCandidates.scanJobId,
				),
				eq(
					candidateResultProjections.vulnerabilityCandidateId,
					vulnerabilityCandidates.vulnerabilityCandidateId,
				),
			),
		)
		.where(eq(vulnerabilityCandidates.scanJobId, scanJobId))
		.groupBy(
			candidateResultProjections.analysisResult,
			candidateResultProjections.verificationResult,
			candidateResultProjections.triageResult,
		);
