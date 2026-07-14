import { db } from "@vulseek/server/db";
import {
	candidateMetadata,
	candidateResultProjections,
	candidateResultProjectionBackfills,
	tasks,
	vulnerabilityCandidates,
} from "@vulseek/server/db/schema";
import {
	and,
	asc,
	count,
	desc,
	eq,
	ilike,
	inArray,
	sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
	analysisSchema,
	triageSchema,
	verificationSchema,
} from "../artifacts/contracts/domain-object.contract";
import type { AnalysisResult, TriageResult, VerificationResult } from "../types";
import { toCandidateRecord } from "./candidate.repo";

export type CandidateProjectionListInput = {
	scanJobId: string;
	page: number;
	pageSize: number;
	query?: string;
	analysisResults?: string[];
	verifyResults?: string[];
	triageResults?: string[];
	sortKey:
		| "latestResultUpdatedAt"
		| "createdAt"
		| "candidate"
		| "analysis"
		| "verify"
		| "score";
	sortDirection: "asc" | "desc";
};

const analysisTask = alias(tasks, "candidate_analysis_task");
const verificationTask = alias(tasks, "candidate_verification_task");
const triageTask = alias(tasks, "candidate_triage_task");

const buildConditions = (input: CandidateProjectionListInput) => {
	const conditions = [eq(vulnerabilityCandidates.scanJobId, input.scanJobId)];
	if (input.analysisResults && input.analysisResults.length > 0) {
		conditions.push(
			inArray(candidateResultProjections.analysisResult, input.analysisResults),
		);
	}
	if (input.verifyResults && input.verifyResults.length > 0) {
		conditions.push(
			inArray(
				candidateResultProjections.verificationResult,
				input.verifyResults,
			),
		);
	}
	if (input.triageResults && input.triageResults.length > 0) {
		conditions.push(
			inArray(candidateResultProjections.triageResult, input.triageResults),
		);
	}

	const query = input.query?.trim().toLowerCase();
	if (query) {
		const searchText = sql<string>`lower(concat_ws(E'\\n',
			${vulnerabilityCandidates.title},
			${vulnerabilityCandidates.description},
			${candidateMetadata.note},
			${candidateMetadata.tags}::text,
			${vulnerabilityCandidates.filePath},
			${vulnerabilityCandidates.line}::text,
			${candidateResultProjections.analysisResult},
			${candidateResultProjections.analysisOutput}->>'reportPath',
			${candidateResultProjections.analysisOutput}->>'threadId',
			${candidateResultProjections.verificationResult},
			${candidateResultProjections.verificationOutput}->>'confidence',
			${candidateResultProjections.verificationOutput}->>'score',
			${candidateResultProjections.verificationOutput}->>'reportPath',
			${candidateResultProjections.verificationOutput}->>'threadId',
			${candidateResultProjections.triageResult},
			${candidateResultProjections.triageOutput}->>'disqualifier',
			${candidateResultProjections.triageOutput}->>'disqualifierReason',
			${candidateResultProjections.triageOutput}->>'securityClassification',
			${candidateResultProjections.triageOutput}->>'impactType',
			${candidateResultProjections.triageOutput}->>'cvssSeverity',
			${candidateResultProjections.triageOutput}->>'cvssScore',
			${candidateResultProjections.triageOutput}->>'epssProbability30d',
			${candidateResultProjections.triageOutput}->>'reportPath',
			${vulnerabilityCandidates.score}::text
		))`;
		conditions.push(ilike(searchText, `%${query}%`));
	}
	return conditions;
};

const buildOrderBy = (input: CandidateProjectionListInput) => {
	const direction = input.sortDirection === "asc" ? asc : desc;
	const order = (() => {
		switch (input.sortKey) {
			case "createdAt":
				return vulnerabilityCandidates.createdAt;
			case "candidate":
				return sql`lower(${vulnerabilityCandidates.title})`;
			case "analysis":
				return sql`coalesce(${candidateResultProjections.analysisRank}, -1)`;
			case "verify":
				return sql`coalesce(${candidateResultProjections.verificationRank}, -1)`;
			case "score":
				return sql`coalesce(${vulnerabilityCandidates.score}, -1)`;
			default:
				return sql`coalesce(${candidateResultProjections.latestResultAt}, ${vulnerabilityCandidates.createdAt})`;
		}
	})();
	return [direction(order), direction(vulnerabilityCandidates.title), asc(vulnerabilityCandidates.vulnerabilityCandidateId)];
};

type ProjectionRow = {
	candidate: typeof vulnerabilityCandidates.$inferSelect;
	metadata: typeof candidateMetadata.$inferSelect | null;
	projection: typeof candidateResultProjections.$inferSelect | null;
	analysisTask: typeof analysisTask.$inferSelect | null;
	verificationTask: typeof verificationTask.$inferSelect | null;
	triageTask: typeof triageTask.$inferSelect | null;
};

const buildAnalysisResult = (row: ProjectionRow): AnalysisResult | null => {
	if (!row.projection?.analysisOutput) {
		return null;
	}
	const parsed = analysisSchema.safeParse(row.projection.analysisOutput);
	if (!parsed.success || !row.projection.analysisTaskId) {
		return null;
	}
	return {
		taskId: row.projection.analysisTaskId,
		scanJobId: row.candidate.scanJobId,
		vulnerabilityCandidateId: row.candidate.vulnerabilityCandidateId,
		producerTaskId: row.candidate.producerTaskId,
		result: parsed.data.result,
		confidence: parsed.data.confidence,
		score: parsed.data.score,
		reportPath: parsed.data.reportPath,
		runtimeSeconds: parsed.data.runtimeSeconds,
		threadId: row.analysisTask?.threadId ?? null,
		summary: parsed.data.summary,
		createdAt: row.analysisTask?.createdAt ?? row.projection.analysisResultAt ?? row.candidate.createdAt,
		updatedAt: row.analysisTask?.updatedAt ?? row.projection.analysisResultAt ?? row.candidate.updatedAt,
		status: parsed.data.status ?? row.analysisTask?.status,
	};
};

const buildVerificationResult = (row: ProjectionRow): VerificationResult | null => {
	if (!row.projection?.verificationOutput) {
		return null;
	}
	const parsed = verificationSchema.safeParse(row.projection.verificationOutput);
	if (!parsed.success || !row.projection.verificationTaskId) {
		return null;
	}
	return {
		taskId: row.projection.verificationTaskId,
		scanJobId: row.candidate.scanJobId,
		vulnerabilityCandidateId: row.candidate.vulnerabilityCandidateId,
		producerTaskId: row.candidate.producerTaskId,
		result: parsed.data.result,
		confidence: parsed.data.confidence,
		score: parsed.data.score,
		reportPath: parsed.data.reportPath,
		runtimeSeconds: parsed.data.runtimeSeconds,
		threadId: row.verificationTask?.threadId ?? null,
		summary: parsed.data.summary,
		createdAt: row.verificationTask?.createdAt ?? row.projection.verificationResultAt ?? row.candidate.createdAt,
		updatedAt: row.verificationTask?.updatedAt ?? row.projection.verificationResultAt ?? row.candidate.updatedAt,
		status: parsed.data.status ?? row.verificationTask?.status,
	};
};

const buildTriageResult = (row: ProjectionRow): TriageResult | null => {
	if (!row.projection?.triageOutput) {
		return null;
	}
	const parsed = triageSchema.safeParse(row.projection.triageOutput);
	if (!parsed.success || !row.projection.triageTaskId) {
		return null;
	}
	return {
		taskId: row.projection.triageTaskId,
		scanJobId: row.candidate.scanJobId,
		vulnerabilityCandidateId: row.candidate.vulnerabilityCandidateId,
		producerTaskId: row.candidate.producerTaskId,
		result: parsed.data.result,
		disqualifier: parsed.data.disqualifier,
		disqualifierReason: parsed.data.disqualifierReason,
		securityClassification: parsed.data.securityClassification,
		isSecurityIssue: parsed.data.isSecurityIssue,
		impactType: parsed.data.impactType,
		cvssVector: parsed.data.cvssVector,
		cvssScore: parsed.data.cvssScore,
		cvssSeverity: parsed.data.cvssSeverity,
		exploitability: parsed.data.exploitability,
		isExploitable: parsed.data.isExploitable,
		commonTriggerConditions: parsed.data.commonTriggerConditions,
		hardeningOrRobustness: parsed.data.hardeningOrRobustness,
		epssProbability30d: parsed.data.epssProbability30d,
		epssSource: parsed.data.epssSource,
		confidence: null,
		score: parsed.data.cvssScore,
		reportPath: parsed.data.reportPath,
		runtimeSeconds: parsed.data.runtimeSeconds,
		threadId: row.triageTask?.threadId ?? null,
		summary: parsed.data.summary,
		createdAt: row.triageTask?.createdAt ?? row.projection.triageResultAt ?? row.candidate.createdAt,
		updatedAt: row.triageTask?.updatedAt ?? row.projection.triageResultAt ?? row.candidate.updatedAt,
		status: parsed.data.status ?? row.triageTask?.status,
	};
};

export const findCandidateProjectionPageRepo = async (
	input: CandidateProjectionListInput,
) => {
	const conditions = buildConditions(input);
	const totalRow = await db
		.select({ count: count() })
		.from(vulnerabilityCandidates)
		.leftJoin(
			candidateMetadata,
			and(
				eq(candidateMetadata.scanJobId, vulnerabilityCandidates.scanJobId),
				eq(
					candidateMetadata.vulnerabilityCandidateId,
					vulnerabilityCandidates.vulnerabilityCandidateId,
				),
			),
		)
		.leftJoin(
			candidateResultProjections,
			and(
				eq(candidateResultProjections.scanJobId, vulnerabilityCandidates.scanJobId),
				eq(
					candidateResultProjections.vulnerabilityCandidateId,
					vulnerabilityCandidates.vulnerabilityCandidateId,
				),
			),
		)
		.where(and(...conditions))
		.then((rows) => rows[0]?.count ?? 0);

	const pageSize = Math.max(1, Math.min(100, input.pageSize));
	const total = Number(totalRow);
	const totalPages = Math.max(1, Math.ceil(total / pageSize));
	const page = Math.min(Math.max(1, input.page), totalPages);
	const rows = await db
		.select({
			candidate: vulnerabilityCandidates,
			metadata: candidateMetadata,
			projection: candidateResultProjections,
			analysisTask,
			verificationTask,
			triageTask,
		})
		.from(vulnerabilityCandidates)
		.leftJoin(
			candidateMetadata,
			and(
				eq(candidateMetadata.scanJobId, vulnerabilityCandidates.scanJobId),
				eq(
					candidateMetadata.vulnerabilityCandidateId,
					vulnerabilityCandidates.vulnerabilityCandidateId,
				),
			),
		)
		.leftJoin(
			candidateResultProjections,
			and(
				eq(candidateResultProjections.scanJobId, vulnerabilityCandidates.scanJobId),
				eq(
					candidateResultProjections.vulnerabilityCandidateId,
					vulnerabilityCandidates.vulnerabilityCandidateId,
				),
			),
		)
		.leftJoin(
			analysisTask,
			eq(analysisTask.taskId, candidateResultProjections.analysisTaskId),
		)
		.leftJoin(
			verificationTask,
			eq(verificationTask.taskId, candidateResultProjections.verificationTaskId),
		)
		.leftJoin(
			triageTask,
			eq(triageTask.taskId, candidateResultProjections.triageTaskId),
		)
		.where(and(...conditions))
		.orderBy(...buildOrderBy(input))
		.limit(pageSize)
		.offset((page - 1) * pageSize);

	const items = rows.map((row) => {
		const candidate = toCandidateRecord(row.candidate, row.metadata ?? undefined);
		return {
			...candidate,
			latestAnalysisResult: buildAnalysisResult(row),
			latestVerificationResult: buildVerificationResult(row),
			latestTriageResult: buildTriageResult(row),
		};
	});

	return { items, total, page, pageSize, totalPages };
};

export const isCandidateProjectionBackfillComplete = async () =>
	await db
		.select({ status: candidateResultProjectionBackfills.status })
		.from(candidateResultProjectionBackfills)
		.where(eq(candidateResultProjectionBackfills.backfillId, "v1"))
		.limit(1)
		.then((rows) => rows[0]?.status === "completed");
