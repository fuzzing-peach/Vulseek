import { TRPCError } from "@trpc/server";
import { db } from "@vulseek/server/db";
import type { ScanRuntimeSettings } from "@vulseek/server/db/schema";
import { scanJobs, tasks } from "@vulseek/server/db/schema";
import { and, desc, eq, ilike, or, type SQL, sql } from "drizzle-orm";
import {
	loadScanPipelineDefinitions,
	normalizeLegacyVerificationSchema,
	normalizePipelineDefinitionSnapshot,
	type ScanPipelineDefinitions,
} from "../pipeline/scan-pipeline-definitions";
import { normalizeScanRuntimeSettings } from "../runtime-settings";
import { getPipelineIdForScanType, type ScanType } from "../scan-type";
import { resolveStageTaskName } from "../stage-task-name";
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
	datasetEvaluationTrialId: scanJobs.datasetEvaluationTrialId,
	pipelineId: scanJobs.pipelineId,
	pipelineVersionId: scanJobs.pipelineVersionId,
	pipelineYamlSnapshot: scanJobs.pipelineYamlSnapshot,
	pipelineCompiledSnapshot: scanJobs.pipelineCompiledSnapshot,
	maxTasks: scanJobs.maxTasks,
	deadlineAt: scanJobs.deadlineAt,
	taskCount: scanJobs.taskCount,
	terminationReason: scanJobs.terminationReason,
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

const scanJobRootStageName = sql<string>`
	jsonb_extract_path_text(
		${scanJobs.scanPipelineDefinitionSnapshot},
		VARIADIC ARRAY['pipelines', ${scanJobs.scanType}::text, 'rootStageId']::text[]
	)
`;

export const findScanJobByIdRepo = async (scanJobId: string) => {
	const scanJob = await db
		.select(selectScanJobWithRepositoryTaskStatus)
		.from(scanJobs)
		.leftJoin(
			tasks,
			and(
				eq(tasks.scanJobId, scanJobs.scanJobId),
				eq(tasks.stageName, scanJobRootStageName),
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

export const findScanJobRuntimeControlRepo = async (scanJobId: string) =>
	await db
		.select({
			status: scanJobs.status,
			scanRuntimeSettings: scanJobs.scanRuntimeSettings,
		})
		.from(scanJobs)
		.where(eq(scanJobs.scanJobId, scanJobId))
		.limit(1)
		.then((rows) => rows[0] ?? null);

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

export type ScanJobListPageInput = {
	page: number;
	pageSize: number;
	search?: string;
	status?:
		| "pending"
		| "running"
		| "paused"
		| "finalizing"
		| "finished"
		| "partially_finished"
		| "failed"
		| "canceled";
};

const buildScanJobListConditions = (
	baseCondition: SQL,
	input: ScanJobListPageInput,
) => {
	const conditions: Array<SQL<unknown> | undefined> = [baseCondition];
	if (input.status) conditions.push(eq(scanJobs.status, input.status));
	if (input.search) {
		const pattern = `%${input.search}%`;
		conditions.push(
			or(ilike(scanJobs.description, pattern), ilike(scanJobs.note, pattern)),
		);
	}
	return conditions;
};

export const listScanJobsByApplicationIdPageRepo = async (
	applicationId: string,
	input: ScanJobListPageInput,
) => {
	const conditions = buildScanJobListConditions(
		eq(scanJobs.applicationId, applicationId),
		input,
	);
	const [items, total] = await Promise.all([
		db
			.select(selectScanJobWithRepositoryTaskStatus)
			.from(scanJobs)
			.leftJoin(
				tasks,
				and(
					eq(tasks.scanJobId, scanJobs.scanJobId),
					eq(tasks.stageName, scanJobRootStageName),
				),
			)
			.where(and(...conditions))
			.orderBy(desc(scanJobs.createdAt))
			.limit(input.pageSize)
			.offset((input.page - 1) * input.pageSize),
		db
			.select({ count: sql<number>`count(*)` })
			.from(scanJobs)
			.where(and(...conditions))
			.then((rows) => Number(rows[0]?.count ?? 0)),
	]);
	return { items, total };
};

export const listScanJobsByComposeIdPageRepo = async (
	composeId: string,
	input: ScanJobListPageInput,
) => {
	const conditions = buildScanJobListConditions(
		eq(scanJobs.composeId, composeId),
		input,
	);
	const [items, total] = await Promise.all([
		db
			.select(selectScanJobWithRepositoryTaskStatus)
			.from(scanJobs)
			.leftJoin(
				tasks,
				and(
					eq(tasks.scanJobId, scanJobs.scanJobId),
					eq(tasks.stageName, scanJobRootStageName),
				),
			)
			.where(and(...conditions))
			.orderBy(desc(scanJobs.createdAt))
			.limit(input.pageSize)
			.offset((input.page - 1) * input.pageSize),
		db
			.select({ count: sql<number>`count(*)` })
			.from(scanJobs)
			.where(and(...conditions))
			.then((rows) => Number(rows[0]?.count ?? 0)),
	]);
	return { items, total };
};

export const listUnfinishedScanJobsRepo = async () =>
	await db
		.select(selectScanJobWithRepositoryTaskStatus)
		.from(scanJobs)
		.leftJoin(
			tasks,
			and(
				eq(tasks.scanJobId, scanJobs.scanJobId),
				eq(tasks.stageName, scanJobRootStageName),
			),
		)
		.where(sql`${scanJobs.status} in ('pending', 'running', 'finalizing')`);

export const createScanJobRepo = async (input: {
	applicationId?: string | null;
	composeId?: string | null;
	datasetEvaluationTrialId?: string | null;
	scanType: ScanType;
	title?: string | null;
	description?: string | null;
	triggerSource?: string | null;
	commitSha?: string | null;
	baseSha?: string | null;
	targetRef?: string | null;
	targetTag?: string | null;
	scanRuntimeSettings?: ScanRuntimeSettings | null;
	researchScope?: Record<string, unknown> | null;
	scanPipelineDefinitionSnapshot?: Record<string, unknown> | null;
	threatDirection?: {
		focus: string;
		attackerModel: string;
		nonGoals?: string[];
		notes?: string;
	} | null;
	commitWindow?: number | null;
	defaultDeltaCommitWindow: number;
	// V3 snapshot linkage (frozen at run creation).
	pipelineId?: string | null;
	pipelineVersionId?: string | null;
	pipelineYamlSnapshot?: string | null;
	pipelineCompiledSnapshot?: Record<string, unknown> | null;
	maxTasks?: number | null;
	deadlineAt?: string | null;
}) => {
	const pipelineDefinitions = loadScanPipelineDefinitions();
	const pipelineId = getPipelineIdForScanType(input.scanType);
	const created = await db
		.insert(scanJobs)
		.values({
			applicationId: input.applicationId,
			composeId: input.composeId,
			datasetEvaluationTrialId: input.datasetEvaluationTrialId,
			scanType: input.scanType as typeof scanJobs.$inferInsert.scanType,
			title:
				input.title ||
				(input.scanType === "delta"
					? "Delta Scan Job"
					: input.scanType === "research"
						? "Research Scan Job"
						: input.scanType === "tob-goal"
							? "Goal Scan Job"
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
			scanPipelineDefinitionSnapshot:
				input.scanPipelineDefinitionSnapshot ?? pipelineDefinitions,
			commitWindow: input.commitWindow || input.defaultDeltaCommitWindow,
			pipelineId: input.pipelineId ?? null,
			pipelineVersionId: input.pipelineVersionId ?? null,
			pipelineYamlSnapshot: input.pipelineYamlSnapshot ?? null,
			pipelineCompiledSnapshot: input.pipelineCompiledSnapshot ?? null,
			maxTasks: input.maxTasks ?? null,
			deadlineAt: input.deadlineAt ?? null,
			status: "pending",
		})
		.returning();

	if (!created[0]) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error creating scan job",
		});
	}

	// V3 snapshot runs create their own root task from the compiled
	// definition (runPipelineFromSnapshot) — skip the legacy V2 root task.
	if (input.pipelineId) {
		return created[0]!;
	}
	const rootStageId = pipelineDefinitions.pipelines[pipelineId]!.rootStageId;
	const threatDirection =
		input.threatDirection ??
		(input.scanRuntimeSettings &&
		typeof input.scanRuntimeSettings === "object" &&
		"threatDirection" in input.scanRuntimeSettings
			? (input.scanRuntimeSettings as { threatDirection?: unknown })
					.threatDirection
			: undefined);
	const rootInput =
		input.scanType === "research"
			? { researchScope: input.researchScope ?? {} }
			: input.scanType === "tob-goal"
				? {
						threatDirection:
							threatDirection && typeof threatDirection === "object"
								? threatDirection
								: {
										focus:
											"Find one high-impact vulnerability matching the attacker model",
										attackerModel:
											"Remote attacker with network access only; no local credential or admin preconditions",
									},
					}
				: undefined;
	await createTaskRepo({
		scanJobId: created[0].scanJobId,
		name:
			input.scanType === "research" || input.scanType === "tob-goal"
				? resolveStageTaskName(rootStageId, rootInput ?? {})
				: rootStageId,
		stageName: rootStageId,
		status: "pending",
		input: rootInput,
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

export const loadScanJobPipelineDefinitionSnapshotRepo = async (
	scanJobId: string,
) => {
	const [row] = await db
		.select({
			scanPipelineDefinitionSnapshot: scanJobs.scanPipelineDefinitionSnapshot,
		})
		.from(scanJobs)
		.where(eq(scanJobs.scanJobId, scanJobId))
		.limit(1);
	if (!row) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Scan job not found" });
	}
	if (
		hasUsableScanPipelineDefinitionSnapshot(row.scanPipelineDefinitionSnapshot)
	) {
		return normalizePipelineDefinitionSnapshot(
			normalizeLegacyVerificationSchema(row.scanPipelineDefinitionSnapshot),
			{ useBaseline: false },
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
