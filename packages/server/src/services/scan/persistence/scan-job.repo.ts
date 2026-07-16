import { db } from "@vulseek/server/db";
import { scanJobs, tasks } from "@vulseek/server/db/schema";
import type { ScanRuntimeSettings } from "@vulseek/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, or, sql } from "drizzle-orm";
import {
	normalizeLegacyVerificationSchema,
	SCAN_PIPELINE_DEFINITIONS,
	type ScanPipelineDefinitions,
} from "../pipeline/scan-pipeline-definitions";
import { normalizeScanRuntimeSettings } from "../runtime-settings";
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
	scanRuntimeSettings: scanJobs.scanRuntimeSettings,
	scanPipelineDefinitionSnapshot: scanJobs.scanPipelineDefinitionSnapshot,
	commitWindow: scanJobs.commitWindow,
	applicationId: scanJobs.applicationId,
	composeId: scanJobs.composeId,
	createdAt: scanJobs.createdAt,
	startedAt: scanJobs.startedAt,
	finishedAt: scanJobs.finishedAt,
	errorMessage: scanJobs.errorMessage,
	scanningThreadId: scanJobs.scanningThreadId,
	inputTokens: scanJobs.inputTokens,
	outputTokens: scanJobs.outputTokens,
	thoughtTokens: scanJobs.thoughtTokens,
	totalTokens: scanJobs.totalTokens,
	cachedReadTokens: scanJobs.cachedReadTokens,
	cachedWriteTokens: scanJobs.cachedWriteTokens,
	estimatedCost: scanJobs.estimatedCost,
	repositoryTaskId: tasks.taskId,
	repositoryTaskStatus: sql<
		typeof tasks.$inferSelect.status
	>`coalesce(${tasks.status}, 'pending')`,
};

export const findScanJobByIdRepo = async (scanJobId: string) => {
	const scanJob = await db
		.select(selectScanJobWithRepositoryTaskStatus)
		.from(scanJobs)
		.leftJoin(
			tasks,
			and(
				eq(tasks.scanJobId, scanJobs.scanJobId),
				or(
					eq(tasks.stageName, "repository-profile"),
					eq(tasks.stageName, "delta-scope"),
				),
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

export const sumClaudeCodeCachedReadTokensByScanJobIdRepo = async (
	scanJobId: string,
) =>
	await db
		.select({
			cachedReadTokens: sql<number>`coalesce(sum(case when ${tasks.agentProfile}->>'provider' = 'claude_code' then coalesce(${tasks.cachedReadTokens}, 0) else 0 end), 0)`,
		})
		.from(tasks)
		.where(eq(tasks.scanJobId, scanJobId))
		.then((rows) => Number(rows[0]?.cachedReadTokens ?? 0));

export const listScanJobsByApplicationIdRepo = async (applicationId: string) =>
	await db
		.select(selectScanJobWithRepositoryTaskStatus)
		.from(scanJobs)
		.leftJoin(
			tasks,
			and(
				eq(tasks.scanJobId, scanJobs.scanJobId),
				or(
					eq(tasks.stageName, "repository-profile"),
					eq(tasks.stageName, "delta-scope"),
				),
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
				or(
					eq(tasks.stageName, "repository-profile"),
					eq(tasks.stageName, "delta-scope"),
				),
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
				or(
					eq(tasks.stageName, "repository-profile"),
					eq(tasks.stageName, "delta-scope"),
				),
			),
		)
		.where(
			sql`${scanJobs.status} in ('pending', 'running', 'finalizing')`,
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
	scanRuntimeSettings?: ScanRuntimeSettings | null;
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
				(input.scanType === "delta"
					? "Delta Scan Job"
					: "Full Scan Job"),
			description: input.description || "",
			triggerSource: input.triggerSource || "manual",
			commitSha: input.commitSha,
			baseSha: input.baseSha,
			targetRef: input.targetRef,
			targetTag: input.targetTag,
			scanRuntimeSettings: normalizeScanRuntimeSettings(
				input.scanRuntimeSettings ?? {},
			),
			scanPipelineDefinitionSnapshot: SCAN_PIPELINE_DEFINITIONS,
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
		name:
			input.scanType === "delta" ? "delta-scoping" : "repository-profiling",
		stageName:
			input.scanType === "delta" ? "delta-scope" : "repository-profile",
		status: "pending",
	});

	return created[0];
};

export const updateScanJobRuntimeSettingsRepo = async (
	scanJobId: string,
	scanRuntimeSettings: ScanRuntimeSettings,
) => {
	const updated = await db
		.update(scanJobs)
		.set({
			scanRuntimeSettings: normalizeScanRuntimeSettings(scanRuntimeSettings),
		})
		.where(eq(scanJobs.scanJobId, scanJobId))
		.returning();

	if (!updated[0]) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Scan job not found" });
	}

	return updated[0];
};

const hasUsableScanPipelineDefinitionSnapshot = (
	value: unknown,
): value is ScanPipelineDefinitions =>
	Boolean(
		value &&
			typeof value === "object" &&
			"stages" in value &&
			"pipelines" in value,
	);

export const loadScanJobPipelineDefinitionSnapshotRepo = async (scanJobId: string) => {
	const [row] = await db
		.select({ scanPipelineDefinitionSnapshot: scanJobs.scanPipelineDefinitionSnapshot })
		.from(scanJobs)
		.where(eq(scanJobs.scanJobId, scanJobId))
		.limit(1);
	if (!row) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Scan job not found" });
	}
	if (hasUsableScanPipelineDefinitionSnapshot(row.scanPipelineDefinitionSnapshot)) {
		return normalizeLegacyVerificationSchema(
			row.scanPipelineDefinitionSnapshot,
		);
	}
	throw new TRPCError({
		code: "INTERNAL_SERVER_ERROR",
		message: "Scan job pipeline definition snapshot is missing or invalid",
	});
};

export const updateScanJobPipelineDefinitionSnapshotRepo = async (
	scanJobId: string,
	scanPipelineDefinitionSnapshot: ScanPipelineDefinitions,
) => {
	const updated = await db
		.update(scanJobs)
		.set({ scanPipelineDefinitionSnapshot })
		.where(eq(scanJobs.scanJobId, scanJobId))
		.returning();
	if (!updated[0]) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Scan job not found" });
	}
	return updated[0];
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

	if (
		status === "finished" ||
		status === "partially_finished" ||
		status === "failed" ||
		status === "canceled"
	) {
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
	if (
		repositoryTaskStatus === "launching" ||
		repositoryTaskStatus === "launched" ||
		repositoryTaskStatus === "starting" ||
		repositoryTaskStatus === "running"
	) {
		repositoryTaskPatch.startedAt = new Date().toISOString();
		repositoryTaskPatch.completedAt = null;
	}
	if (
		repositoryTaskStatus === "completed" ||
		repositoryTaskStatus === "failed" ||
		repositoryTaskStatus === "exited" ||
		repositoryTaskStatus === "canceled"
	) {
		repositoryTaskPatch.completedAt = new Date().toISOString();
	}
	await db
		.update(tasks)
		.set(repositoryTaskPatch)
		.where(eq(tasks.taskId, scanJobId));
	return await findScanJobByIdRepo(scanJobId);
};

export const updateScanJobScanningThreadIdRepo = async (
	scanJobId: string,
	scanningThreadId: string,
) => {
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
	if (typeof input.commitWindow === "number")
		patch.commitWindow = input.commitWindow;
	const updated = await db
		.update(scanJobs)
		.set(patch)
		.where(eq(scanJobs.scanJobId, scanJobId))
		.returning();
	return updated[0] || null;
};
