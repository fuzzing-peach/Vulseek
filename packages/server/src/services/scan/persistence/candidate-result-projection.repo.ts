import { db } from "@vulseek/server/db";
import {
	candidateResultProjections,
	tasks,
	vulnerabilityCandidates,
} from "@vulseek/server/db/schema";
import { and, eq } from "drizzle-orm";
import {
	analysisSchema,
	triageSchema,
	verificationSchema,
} from "../artifacts/contracts/domain-object.contract";
import {
	buildCandidateProjectionPatch,
	compareProjectionResultVersions,
} from "./candidate-result-projection";

export const CANDIDATE_RESULT_STAGE_NAMES = [
	"analyze-finding",
	"verify-finding",
	"triage-finding",
] as const;

export type CandidateResultStageName =
	(typeof CANDIDATE_RESULT_STAGE_NAMES)[number];

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type TaskRecord = typeof tasks.$inferSelect;

const stageColumns = {
	"analyze-finding": {
		taskId: "analysisTaskId",
		resultAt: "analysisResultAt",
	},
	"verify-finding": {
		taskId: "verificationTaskId",
		resultAt: "verificationResultAt",
	},
	"triage-finding": {
		taskId: "triageTaskId",
		resultAt: "triageResultAt",
	},
} as const;

const parseStageOutput = (stageName: string, output: unknown) => {
	if (stageName === "analyze-finding") {
		return analysisSchema.safeParse(output);
	}
	if (stageName === "verify-finding") {
		return verificationSchema.safeParse(output);
	}
	if (stageName === "triage-finding") {
		return triageSchema.safeParse(output);
	}
	return { success: false as const };
};

const latestResultAt = (
	row: typeof candidateResultProjections.$inferSelect,
	patch: Record<string, unknown>,
) => {
	const values = [
		row.analysisResultAt,
		row.verificationResultAt,
		row.triageResultAt,
		patch.analysisResultAt,
		patch.verificationResultAt,
		patch.triageResultAt,
	].filter((value): value is string => typeof value === "string");
	return values.sort((left, right) => Date.parse(right) - Date.parse(left))[0] || null;
};

export const upsertCandidateResultProjectionTx = async (
	tx: DbTransaction,
	task: TaskRecord,
	vulnerabilityCandidateId = task.vulnerabilityCandidateId,
) => {
	if (
		!vulnerabilityCandidateId ||
		!CANDIDATE_RESULT_STAGE_NAMES.includes(
			task.stageName as CandidateResultStageName,
		)
	) {
		return false;
	}

	const parsedOutput = parseStageOutput(task.stageName, task.output);
	if (!parsedOutput.success) {
		return false;
	}

	const candidate = await tx
		.select({
			vulnerabilityCandidateId: vulnerabilityCandidates.vulnerabilityCandidateId,
		})
		.from(vulnerabilityCandidates)
		.where(
			and(
				eq(vulnerabilityCandidates.scanJobId, task.scanJobId),
				eq(
					vulnerabilityCandidates.vulnerabilityCandidateId,
					vulnerabilityCandidateId,
				),
			),
		)
		.limit(1);
	if (!candidate[0]) {
		throw new Error(
			`Candidate ${vulnerabilityCandidateId} not found for scan job ${task.scanJobId}`,
		);
	}

	const resultAt = task.completedAt || task.updatedAt || task.createdAt;
	const patch = buildCandidateProjectionPatch({
		scanJobId: task.scanJobId,
		vulnerabilityCandidateId,
		taskId: task.taskId,
		stageName: task.stageName,
		output: parsedOutput.data,
		resultAt,
	});
	const existing = await tx
		.select()
		.from(candidateResultProjections)
		.where(
			and(
				eq(candidateResultProjections.scanJobId, task.scanJobId),
				eq(
					candidateResultProjections.vulnerabilityCandidateId,
					vulnerabilityCandidateId,
				),
			),
		)
		.limit(1)
		.then((rows) => rows[0] || null);

	if (existing) {
		const columns = stageColumns[
			task.stageName as CandidateResultStageName
		];
		const oldTaskId = existing[columns.taskId];
		const oldResultAt = existing[columns.resultAt];
		if (
			typeof oldTaskId === "string" &&
			typeof oldResultAt === "string" &&
			compareProjectionResultVersions(
				{ resultAt, taskId: task.taskId },
				{ resultAt: oldResultAt, taskId: oldTaskId },
			) < 0
		) {
			return false;
		}
		await tx
			.update(candidateResultProjections)
			.set({
				...patch,
				latestResultAt: latestResultAt(existing, patch),
				updatedAt: new Date().toISOString(),
			})
			.where(
				and(
					eq(candidateResultProjections.scanJobId, task.scanJobId),
					eq(
					candidateResultProjections.vulnerabilityCandidateId,
					vulnerabilityCandidateId,
				),
				),
			);
		return true;
	}

	await tx.insert(candidateResultProjections).values({
		scanJobId: task.scanJobId,
		vulnerabilityCandidateId,
		...patch,
		latestResultAt: resultAt,
	});
	return true;
};

export const validateCandidateResultOutput = (stageName: string, output: unknown) =>
	parseStageOutput(stageName, output).success;
