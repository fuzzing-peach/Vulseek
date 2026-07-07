import { db } from "@vulseek/server/db";
import { scanJobs, type taskStatusEnum, tasks } from "@vulseek/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, asc, count, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import {
	analysisSchema,
	triageSchema,
	verificationSchema,
} from "../artifacts/contracts/domain-object.contract";
import { createShortTaskId } from "../task-id";
import type { AnalysisResult, TriageResult, VerificationResult } from "../types";
import { readCandidateIdFromTaskInputArtifact } from "./task-artifact-resolver";

const tokenUsageKeys = [
	"inputTokens",
	"outputTokens",
	"thoughtTokens",
	"totalTokens",
	"cachedReadTokens",
	"cachedWriteTokens",
] as const;

type TaskTokenUsageKey = (typeof tokenUsageKeys)[number];

const hasTokenUsagePatch = (patch: Partial<typeof tasks.$inferSelect>) =>
	tokenUsageKeys.some((key) => key in patch);

const toTokenCount = (value: number | null | undefined) =>
	typeof value === "number" && Number.isFinite(value) ? value : 0;

const tokenUsageDelta = (
	before: Pick<typeof tasks.$inferSelect, TaskTokenUsageKey>,
	after: Pick<typeof tasks.$inferSelect, TaskTokenUsageKey>,
) => ({
	inputTokens: toTokenCount(after.inputTokens) - toTokenCount(before.inputTokens),
	outputTokens:
		toTokenCount(after.outputTokens) - toTokenCount(before.outputTokens),
	thoughtTokens:
		toTokenCount(after.thoughtTokens) - toTokenCount(before.thoughtTokens),
	totalTokens: toTokenCount(after.totalTokens) - toTokenCount(before.totalTokens),
	cachedReadTokens:
		toTokenCount(after.cachedReadTokens) -
		toTokenCount(before.cachedReadTokens),
	cachedWriteTokens:
		toTokenCount(after.cachedWriteTokens) -
		toTokenCount(before.cachedWriteTokens),
});

const hasNonZeroTokenUsageDelta = (delta: ReturnType<typeof tokenUsageDelta>) =>
	Object.values(delta).some((value) => value !== 0);

const applyScanJobTokenUsageDelta = async (
	tx: typeof db,
	scanJobId: string,
	delta: ReturnType<typeof tokenUsageDelta>,
) => {
	if (!hasNonZeroTokenUsageDelta(delta)) {
		return;
	}
	await tx
		.update(scanJobs)
		.set({
			inputTokens: sql`${scanJobs.inputTokens} + ${delta.inputTokens}`,
			outputTokens: sql`${scanJobs.outputTokens} + ${delta.outputTokens}`,
			thoughtTokens: sql`${scanJobs.thoughtTokens} + ${delta.thoughtTokens}`,
			totalTokens: sql`${scanJobs.totalTokens} + ${delta.totalTokens}`,
			cachedReadTokens: sql`${scanJobs.cachedReadTokens} + ${delta.cachedReadTokens}`,
			cachedWriteTokens: sql`${scanJobs.cachedWriteTokens} + ${delta.cachedWriteTokens}`,
		})
		.where(eq(scanJobs.scanJobId, scanJobId));
};

const buildAnalysisTaskResultView = async (
	task: typeof tasks.$inferSelect,
): Promise<AnalysisResult | null> => {
	const parsedOutput = analysisSchema.safeParse(task.output);
	if (!parsedOutput.success) {
		return null;
	}

	const vulnerabilityCandidateId =
		await readCandidateIdFromTaskInputArtifact(task);
	if (!vulnerabilityCandidateId) {
		return null;
	}

	return {
		taskId: task.taskId,
		scanJobId: task.scanJobId,
		vulnerabilityCandidateId,
		result: parsedOutput.data.result,
		confidence: parsedOutput.data.confidence,
		score: parsedOutput.data.score,
		reportPath: parsedOutput.data.reportPath,
		runtimeSeconds: parsedOutput.data.runtimeSeconds,
		threadId: task.threadId,
		summary: parsedOutput.data.summary,
		createdAt: task.createdAt,
		updatedAt: task.updatedAt,
		status: parsedOutput.data.status ?? task.status,
	};
};

const buildVerificationTaskResultView = async (
	task: typeof tasks.$inferSelect,
): Promise<VerificationResult | null> => {
	const parsedOutput = verificationSchema.safeParse(task.output);
	if (!parsedOutput.success) {
		return null;
	}

	const vulnerabilityCandidateId =
		await readCandidateIdFromTaskInputArtifact(task);
	if (!vulnerabilityCandidateId) {
		return null;
	}

	return {
		taskId: task.taskId,
		scanJobId: task.scanJobId,
		vulnerabilityCandidateId,
		result: parsedOutput.data.result,
		confidence: parsedOutput.data.confidence,
		score: parsedOutput.data.score,
		reportPath: parsedOutput.data.reportPath,
		runtimeSeconds: parsedOutput.data.runtimeSeconds,
		threadId: task.threadId,
		summary: parsedOutput.data.summary,
		createdAt: task.createdAt,
		updatedAt: task.updatedAt,
		status: parsedOutput.data.status ?? task.status,
	};
};

const buildTriageTaskResultView = async (
	task: typeof tasks.$inferSelect,
): Promise<TriageResult | null> => {
	const parsedOutput = triageSchema.safeParse(task.output);
	if (!parsedOutput.success) {
		return null;
	}

	const vulnerabilityCandidateId =
		await readCandidateIdFromTaskInputArtifact(task);
	if (!vulnerabilityCandidateId) {
		return null;
	}

	return {
		taskId: task.taskId,
		scanJobId: task.scanJobId,
		vulnerabilityCandidateId,
		result: parsedOutput.data.result,
		disqualifier: parsedOutput.data.disqualifier,
		disqualifierReason: parsedOutput.data.disqualifierReason,
		securityClassification: parsedOutput.data.securityClassification,
		isSecurityIssue: parsedOutput.data.isSecurityIssue,
		impactType: parsedOutput.data.impactType,
		cvssVector: parsedOutput.data.cvssVector,
		cvssScore: parsedOutput.data.cvssScore,
		cvssSeverity: parsedOutput.data.cvssSeverity,
		exploitability: parsedOutput.data.exploitability,
		isExploitable: parsedOutput.data.isExploitable,
		commonTriggerConditions: parsedOutput.data.commonTriggerConditions,
		hardeningOrRobustness: parsedOutput.data.hardeningOrRobustness,
		epssProbability30d: parsedOutput.data.epssProbability30d,
		epssSource: parsedOutput.data.epssSource,
		confidence: null,
		score: parsedOutput.data.cvssScore,
		reportPath: parsedOutput.data.reportPath,
		runtimeSeconds: parsedOutput.data.runtimeSeconds,
		threadId: task.threadId,
		summary: parsedOutput.data.summary,
		createdAt: task.createdAt,
		updatedAt: task.updatedAt,
		status: parsedOutput.data.status ?? task.status,
	};
};

export const createTaskRepo = async (input: {
	taskId?: string;
	scanJobId: string;
	parentTaskId?: string | null;
	name: string;
	stageName: string;
	status?: (typeof taskStatusEnum.enumValues)[number];
	priority?: number | null;
	attempt?: number;
	agentProfile?: typeof tasks.$inferSelect.agentProfile;
	containerName?: string | null;
	containerIndex?: number | null;
	threadId?: string | null;
	runtimeMode?: typeof tasks.$inferSelect.runtimeMode;
	forkedFromTaskId?: string | null;
	forkedFromThreadId?: string | null;
	input?: typeof tasks.$inferSelect.input;
	output?: typeof tasks.$inferSelect.output;
	inputTokens?: number | null;
	outputTokens?: number | null;
	thoughtTokens?: number | null;
	totalTokens?: number | null;
	cachedReadTokens?: number | null;
	cachedWriteTokens?: number | null;
	errorMessage?: string | null;
	exitReason?: typeof tasks.$inferSelect.exitReason;
	exitNote?: string | null;
	stageGroupInstanceId?: string | null;
	startedAt?: string | null;
	completedAt?: string | null;
}) => {
	const hasExplicitTaskId = Boolean(input.taskId);
	let created: Array<typeof tasks.$inferSelect> = [];
	let lastError: unknown = null;
	for (let attempt = 0; attempt < (hasExplicitTaskId ? 1 : 5); attempt += 1) {
		try {
			created = await db
				.insert(tasks)
				.values({
					taskId: input.taskId || createShortTaskId(),
					scanJobId: input.scanJobId,
					parentTaskId: input.parentTaskId ?? null,
					name: input.name,
					stageName: input.stageName,
					status: input.status ?? "pending",
					priority: input.priority ?? null,
					attempt: input.attempt ?? 0,
					agentProfile: input.agentProfile ?? null,
					containerName: input.containerName ?? null,
					containerIndex: input.containerIndex ?? null,
					threadId: input.threadId ?? null,
					runtimeMode: input.runtimeMode ?? "new_session",
					forkedFromTaskId: input.forkedFromTaskId ?? null,
					forkedFromThreadId: input.forkedFromThreadId ?? null,
					input: input.input ?? null,
					output: input.output ?? null,
					inputTokens: input.inputTokens ?? null,
					outputTokens: input.outputTokens ?? null,
					thoughtTokens: input.thoughtTokens ?? null,
					totalTokens: input.totalTokens ?? null,
					cachedReadTokens: input.cachedReadTokens ?? null,
					cachedWriteTokens: input.cachedWriteTokens ?? null,
					errorMessage: input.errorMessage ?? null,
					exitReason: input.exitReason ?? null,
					exitNote: input.exitNote ?? null,
					stageGroupInstanceId: input.stageGroupInstanceId ?? null,
					startedAt: input.startedAt ?? null,
					completedAt: input.completedAt ?? null,
				})
				.returning();
			lastError = null;
			break;
		} catch (error) {
			lastError = error;
			if (
				hasExplicitTaskId ||
				!error ||
				typeof error !== "object" ||
				(error as { code?: string }).code !== "23505"
			) {
				throw error;
			}
		}
	}

	if (!created[0]) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Error creating task${lastError ? `: ${String(lastError)}` : ""}`,
		});
	}

	if (hasTokenUsagePatch(input)) {
		await applyScanJobTokenUsageDelta(
			db,
			created[0].scanJobId,
			tokenUsageDelta(
				{
					inputTokens: null,
					outputTokens: null,
					thoughtTokens: null,
					totalTokens: null,
					cachedReadTokens: null,
					cachedWriteTokens: null,
				},
				created[0],
			),
		);
	}

	return created[0];
};

export const findTaskByIdRepo = async (taskId: string) => {
	const task = await db
		.select()
		.from(tasks)
		.where(eq(tasks.taskId, taskId))
		.limit(1)
		.then((rows) => rows[0] || null);

	if (!task) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Task not found",
		});
	}

	return task;
};

export const listTasksByScanJobIdRepo = async (scanJobId: string) =>
	await db
		.select()
		.from(tasks)
		.where(eq(tasks.scanJobId, scanJobId))
		.orderBy(desc(tasks.createdAt));

export const listTaskRuntimeIntervalsByScanJobIdRepo = async (
	scanJobId: string,
) =>
	await db
		.select({
			status: tasks.status,
			createdAt: tasks.createdAt,
			startedAt: tasks.startedAt,
			completedAt: tasks.completedAt,
			updatedAt: tasks.updatedAt,
		})
		.from(tasks)
		.where(
			and(
				eq(tasks.scanJobId, scanJobId),
				inArray(tasks.status, [
					"launching",
					"launched",
					"starting",
					"running",
					"completed",
					"failed",
					"exited",
					"canceled",
				]),
			),
		);

export const listTasksByScanJobAndStatusesRepo = async (input: {
	scanJobId: string;
	statuses: Array<(typeof taskStatusEnum.enumValues)[number]>;
}) =>
	await db
		.select()
		.from(tasks)
		.where(
			and(
				eq(tasks.scanJobId, input.scanJobId),
				inArray(tasks.status, input.statuses),
			),
		)
		.orderBy(desc(tasks.updatedAt));

export const listTaskStatusCountsByScanJobIdRepo = async (scanJobId: string) =>
	await db
		.select({
			stageName: tasks.stageName,
			status: tasks.status,
			count: count(),
		})
		.from(tasks)
		.where(eq(tasks.scanJobId, scanJobId))
		.groupBy(tasks.stageName, tasks.status);

export const listTerminalTasksPageByScanJobIdRepo = async (input: {
	scanJobId: string;
	page: number;
	pageSize: number;
	query?: string;
	stageName?: string;
	status?: (typeof taskStatusEnum.enumValues)[number];
}) => {
	const pageSize = Math.max(1, Math.min(100, input.pageSize));
	const requestedPage = Math.max(1, input.page);
	const terminalStatuses: Array<(typeof taskStatusEnum.enumValues)[number]> = [
		"completed",
		"failed",
		"exited",
		"canceled",
	];
	const trimmedQuery = input.query?.trim() || "";
	const conditions = [
		eq(tasks.scanJobId, input.scanJobId),
		inArray(tasks.status, terminalStatuses),
		input.stageName ? eq(tasks.stageName, input.stageName) : undefined,
		input.status ? eq(tasks.status, input.status) : undefined,
		trimmedQuery
			? or(
					ilike(tasks.taskId, `%${trimmedQuery}%`),
					ilike(tasks.name, `%${trimmedQuery}%`),
					ilike(tasks.stageName, `%${trimmedQuery}%`),
					ilike(tasks.errorMessage, `%${trimmedQuery}%`),
				)
			: undefined,
	].filter(Boolean);
	const where = and(...conditions);
	const [{ total = 0 } = { total: 0 }] = await db
		.select({ total: count() })
		.from(tasks)
		.where(where);
	const totalPages = Math.max(1, Math.ceil(total / pageSize));
	const page = Math.min(requestedPage, totalPages);
	const items = await db
		.select()
		.from(tasks)
		.where(where)
		.orderBy(
			desc(sql<string>`coalesce(${tasks.completedAt}, ${tasks.updatedAt})`),
		)
		.limit(pageSize)
		.offset((page - 1) * pageSize);

	return {
		items,
		total,
		page,
		pageSize,
		totalPages,
	};
};

export const listChildTasksByParentTaskIdRepo = async (parentTaskId: string) =>
	await db
		.select()
		.from(tasks)
		.where(eq(tasks.parentTaskId, parentTaskId))
		.orderBy(desc(tasks.createdAt));

export const listCandidateDescendantTasksByFunctionTaskIdRepo = async (input: {
	scanFunctionTaskId: string;
	vulnerabilityCandidateId: string;
}) => {
	const directChildren = await listChildTasksByParentTaskIdRepo(
		input.scanFunctionTaskId,
	);
	const candidateRoots: Array<typeof tasks.$inferSelect> = [];
	for (const task of directChildren) {
		const candidateId = await readCandidateIdFromTaskInputArtifact(task).catch(
			() => null,
		);
		if (candidateId === input.vulnerabilityCandidateId) {
			candidateRoots.push(task);
		}
	}

	const descendants: Array<typeof tasks.$inferSelect> = [];
	const queue = [...candidateRoots];
	const seenTaskIds = new Set<string>();
	while (queue.length > 0) {
		const task = queue.shift();
		if (!task || seenTaskIds.has(task.taskId)) {
			continue;
		}
		seenTaskIds.add(task.taskId);
		descendants.push(task);
		const children = await listChildTasksByParentTaskIdRepo(task.taskId);
		for (const child of children) {
			if (!seenTaskIds.has(child.taskId)) {
				queue.push(child);
			}
		}
	}

	return descendants.sort((left, right) =>
		right.createdAt.localeCompare(left.createdAt),
	);
};

export const listChildTasksByParentTaskIdAndStageRepo = async (input: {
	parentTaskId: string;
	stageName: string;
}) =>
	await db
		.select()
		.from(tasks)
		.where(
			and(
				eq(tasks.parentTaskId, input.parentTaskId),
				eq(tasks.stageName, input.stageName),
			),
		)
		.orderBy(desc(tasks.createdAt));

export const listTasksByScanJobAndStageRepo = async (input: {
	scanJobId: string;
	stageName: string;
}) =>
	await db
		.select()
		.from(tasks)
		.where(
			and(
				eq(tasks.scanJobId, input.scanJobId),
				eq(tasks.stageName, input.stageName),
			),
		)
		.orderBy(desc(tasks.createdAt));

export const listActiveTasksByScanJobAndStageRepo = async (input: {
	scanJobId: string;
	stageName: string;
}) =>
	await db
		.select()
		.from(tasks)
		.where(
			and(
				eq(tasks.scanJobId, input.scanJobId),
				eq(tasks.stageName, input.stageName),
				inArray(tasks.status, ["launching", "launched", "starting", "running"]),
			),
		)
		.orderBy(asc(tasks.createdAt));

export const countActiveTasksByScanJobAndStageRepo = async (input: {
	scanJobId: string;
	stageName: string;
}) => {
	const row = await db
		.select({ count: count() })
		.from(tasks)
		.where(
			and(
				eq(tasks.scanJobId, input.scanJobId),
				eq(tasks.stageName, input.stageName),
				inArray(tasks.status, ["launching", "launched", "starting", "running"]),
			),
		)
		.then((rows) => rows[0]);
	return row?.count ?? 0;
};

export const transitionTaskStatusRepo = async (input: {
	taskId: string;
	from: Array<(typeof taskStatusEnum.enumValues)[number]>;
	to: (typeof taskStatusEnum.enumValues)[number];
	patch?: Partial<typeof tasks.$inferSelect>;
}) => {
	const now = new Date().toISOString();
	const patch = {
		...input.patch,
		status: input.to,
		updatedAt: now,
		...(input.to === "launching" ||
		input.to === "launched" ||
		input.to === "starting" ||
		input.to === "running"
			? { startedAt: now, completedAt: null }
			: {}),
		...(input.to === "completed" ||
		input.to === "failed" ||
		input.to === "exited" ||
		input.to === "canceled"
			? { completedAt: now }
			: {}),
	};

	const updated = hasTokenUsagePatch(input.patch || {})
		? await db.transaction(async (tx) => {
				const previous = await tx
					.select()
					.from(tasks)
					.where(
						and(
							eq(tasks.taskId, input.taskId),
							inArray(tasks.status, input.from),
						),
					)
					.limit(1)
					.then((rows) => rows[0] || null);
				if (!previous) {
					return null;
				}
				const rows = await tx
					.update(tasks)
					.set(patch)
					.where(
						and(
							eq(tasks.taskId, input.taskId),
							inArray(tasks.status, input.from),
						),
					)
					.returning();
				const updatedTask = rows[0] || null;
				if (!updatedTask) {
					return null;
				}
				await applyScanJobTokenUsageDelta(
					tx,
					updatedTask.scanJobId,
					tokenUsageDelta(previous, updatedTask),
				);
				return updatedTask;
			})
		: await db
				.update(tasks)
				.set(patch)
				.where(
					and(eq(tasks.taskId, input.taskId), inArray(tasks.status, input.from)),
				)
				.returning()
				.then((rows) => rows[0] || null);

	return updated;
};

export const updateTaskRepo = async (
	taskId: string,
	patch: Partial<typeof tasks.$inferSelect>,
) => {
	const nextPatch = {
		...patch,
		updatedAt: new Date().toISOString(),
	};
	const updated = hasTokenUsagePatch(patch)
		? await db.transaction(async (tx) => {
				const previous = await tx
					.select()
					.from(tasks)
					.where(eq(tasks.taskId, taskId))
					.limit(1)
					.then((rows) => rows[0] || null);
				if (!previous) {
					return null;
				}
				const rows = await tx
					.update(tasks)
					.set(nextPatch)
					.where(eq(tasks.taskId, taskId))
					.returning();
				const updatedTask = rows[0] || null;
				if (!updatedTask) {
					return null;
				}
				await applyScanJobTokenUsageDelta(
					tx,
					updatedTask.scanJobId,
					tokenUsageDelta(previous, updatedTask),
				);
				return updatedTask;
			})
		: await db
				.update(tasks)
				.set(nextPatch)
				.where(eq(tasks.taskId, taskId))
				.returning()
				.then((rows) => rows[0] || null);

	if (!updated) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Task not found",
		});
	}

	return updated;
};

export const updateTaskStatusRepo = async (input: {
	taskId: string;
	status: (typeof taskStatusEnum.enumValues)[number];
	errorMessage?: string | null;
}) => {
	const patch: Partial<typeof tasks.$inferSelect> = {
		status: input.status,
		errorMessage: input.errorMessage ?? null,
	};

	if (
		input.status === "launching" ||
		input.status === "launched" ||
		input.status === "starting" ||
		input.status === "running"
	) {
		patch.startedAt = new Date().toISOString();
		patch.completedAt = null;
	}

	if (
		input.status === "completed" ||
		input.status === "failed" ||
		input.status === "exited" ||
		input.status === "canceled"
	) {
		patch.completedAt = new Date().toISOString();
	}

	return await updateTaskRepo(input.taskId, patch);
};

export const bindTaskRuntimeRepo = async (input: {
	taskId: string;
	containerName?: string | null;
	containerIndex?: number | null;
	threadId?: string | null;
	agentProfile?: typeof tasks.$inferSelect.agentProfile;
}) =>
	await updateTaskRepo(input.taskId, {
		containerName: input.containerName,
		...(input.containerIndex !== undefined
			? { containerIndex: input.containerIndex }
			: {}),
		threadId: input.threadId,
		agentProfile: input.agentProfile,
	});

export const storeTaskInputRepo = async (
	taskId: string,
	input: typeof tasks.$inferSelect.input,
) => await updateTaskRepo(taskId, { input });

export const storeTaskOutputRepo = async (
	taskId: string,
	output: typeof tasks.$inferSelect.output,
) => await updateTaskRepo(taskId, { output });

export const resetFailedTaskForRetryRepo = async (taskId: string) => {
	const updated = await db.transaction(async (tx) => {
		const previous = await tx
			.select()
			.from(tasks)
			.where(eq(tasks.taskId, taskId))
			.limit(1)
			.then((rows) => rows[0] || null);
		if (!previous) {
			return null;
		}
		const rows = await tx
			.update(tasks)
			.set({
				status: "pending",
				errorMessage: null,
				startedAt: null,
				completedAt: null,
				containerName: null,
				containerIndex: null,
				threadId: null,
				output: null,
				inputTokens: null,
				outputTokens: null,
				thoughtTokens: null,
				totalTokens: null,
				cachedReadTokens: null,
				cachedWriteTokens: null,
				attempt: sql`${tasks.attempt} + 1`,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(tasks.taskId, taskId))
			.returning();
		const updatedTask = rows[0] || null;
		if (!updatedTask) {
			return null;
		}
		await applyScanJobTokenUsageDelta(
			tx,
			updatedTask.scanJobId,
			tokenUsageDelta(previous, updatedTask),
		);
		return updatedTask;
	});

	if (!updated) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Task not found",
		});
	}

	return updated;
};

export const requeueTaskRepo = async (taskId: string) => {
	const updated = await db.transaction(async (tx) => {
		const previous = await tx
			.select()
			.from(tasks)
			.where(eq(tasks.taskId, taskId))
			.limit(1)
			.then((rows) => rows[0] || null);
		if (!previous) {
			return null;
		}
		const rows = await tx
			.update(tasks)
			.set({
				status: "pending",
				errorMessage: null,
				startedAt: null,
				completedAt: null,
				containerName: null,
				containerIndex: null,
				threadId: null,
				output: null,
				inputTokens: null,
				outputTokens: null,
				thoughtTokens: null,
				totalTokens: null,
				cachedReadTokens: null,
				cachedWriteTokens: null,
				attempt: sql`${tasks.attempt} + 1`,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(tasks.taskId, taskId))
			.returning();
		const updatedTask = rows[0] || null;
		if (!updatedTask) {
			return null;
		}
		await applyScanJobTokenUsageDelta(
			tx,
			updatedTask.scanJobId,
			tokenUsageDelta(previous, updatedTask),
		);
		return updatedTask;
	});

	if (!updated) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Task not found",
		});
	}

	return updated;
};

export const listAnalysisResultsByScanJobIdRepo = async (
	scanJobId: string,
): Promise<AnalysisResult[]> => {
	const analysisTasks = (
		await Promise.all(
			["analyze-finding", "analyze"].map((stageName) =>
				listTasksByScanJobAndStageRepo({ scanJobId, stageName }),
			),
		)
	).flat();
	return (
		await Promise.all(analysisTasks.map(buildAnalysisTaskResultView))
	).filter((item): item is AnalysisResult => Boolean(item));
};

export const listVerificationResultsByScanJobIdRepo = async (
	scanJobId: string,
): Promise<VerificationResult[]> => {
	const verificationTasks = (
		await Promise.all(
			["verify-finding", "verify"].map((stageName) =>
				listTasksByScanJobAndStageRepo({ scanJobId, stageName }),
			),
		)
	).flat();
	return (
		await Promise.all(verificationTasks.map(buildVerificationTaskResultView))
	).filter((item): item is VerificationResult => Boolean(item));
};

export const listTriageResultsByScanJobIdRepo = async (
	scanJobId: string,
): Promise<TriageResult[]> => {
	const triageTasks = (
		await Promise.all(
			["triage-finding", "triage"].map((stageName) =>
				listTasksByScanJobAndStageRepo({ scanJobId, stageName }),
			),
		)
	).flat();
	return (
		await Promise.all(triageTasks.map(buildTriageTaskResultView))
	).filter((item): item is TriageResult => Boolean(item));
};

export const findLatestAnalysisResultByCandidateIdRepo = async (input: {
	scanJobId: string;
	vulnerabilityCandidateId: string;
	scanFunctionTaskId?: string | null;
}): Promise<AnalysisResult | null> => {
	if (input.scanFunctionTaskId) {
		const candidateTasks =
			await listCandidateDescendantTasksByFunctionTaskIdRepo({
				scanFunctionTaskId: input.scanFunctionTaskId,
				vulnerabilityCandidateId: input.vulnerabilityCandidateId,
			});
		for (const task of candidateTasks) {
			if (task.stageName !== "analyze" && task.stageName !== "analyze-finding") {
				continue;
			}
			const result = await buildAnalysisTaskResultView(task);
			if (result?.vulnerabilityCandidateId === input.vulnerabilityCandidateId) {
				return result;
			}
		}
		return null;
	}

	return (
		(await listAnalysisResultsByScanJobIdRepo(input.scanJobId)).find(
			(result) =>
				result.vulnerabilityCandidateId === input.vulnerabilityCandidateId,
		) || null
	);
};

export const findLatestVerificationResultByCandidateIdRepo = async (input: {
	scanJobId: string;
	vulnerabilityCandidateId: string;
	scanFunctionTaskId?: string | null;
}): Promise<VerificationResult | null> => {
	if (input.scanFunctionTaskId) {
		const candidateTasks =
			await listCandidateDescendantTasksByFunctionTaskIdRepo({
				scanFunctionTaskId: input.scanFunctionTaskId,
				vulnerabilityCandidateId: input.vulnerabilityCandidateId,
			});
		for (const task of candidateTasks) {
			if (task.stageName !== "verify" && task.stageName !== "verify-finding") {
				continue;
			}
			const result = await buildVerificationTaskResultView(task);
			if (result?.vulnerabilityCandidateId === input.vulnerabilityCandidateId) {
				return result;
			}
		}
		return null;
	}

	return (
		(await listVerificationResultsByScanJobIdRepo(input.scanJobId)).find(
			(result) =>
				result.vulnerabilityCandidateId === input.vulnerabilityCandidateId,
		) || null
	);
};

export const findLatestTriageResultByCandidateIdRepo = async (input: {
	scanJobId: string;
	vulnerabilityCandidateId: string;
	scanFunctionTaskId?: string | null;
}): Promise<TriageResult | null> => {
	if (input.scanFunctionTaskId) {
		const candidateTasks =
			await listCandidateDescendantTasksByFunctionTaskIdRepo({
				scanFunctionTaskId: input.scanFunctionTaskId,
				vulnerabilityCandidateId: input.vulnerabilityCandidateId,
			});
		for (const task of candidateTasks) {
			if (task.stageName !== "triage" && task.stageName !== "triage-finding") {
				continue;
			}
			const result = await buildTriageTaskResultView(task);
			if (result?.vulnerabilityCandidateId === input.vulnerabilityCandidateId) {
				return result;
			}
		}
		return null;
	}

	return (
		(await listTriageResultsByScanJobIdRepo(input.scanJobId)).find(
			(result) =>
				result.vulnerabilityCandidateId === input.vulnerabilityCandidateId,
		) || null
	);
};

export const countTasksByScanJobAndStatusRepo = async (scanJobId: string) =>
	await db
		.select({
			status: tasks.status,
			count: sql<number>`count(*)::int`,
		})
		.from(tasks)
		.where(eq(tasks.scanJobId, scanJobId))
		.groupBy(tasks.status);

export const countOpenTasksByScanJobIdRepo = async (scanJobId: string) => {
	const [row] = await db
		.select({
			count: sql<number>`count(*)::int`,
		})
		.from(tasks)
		.where(
			and(
				eq(tasks.scanJobId, scanJobId),
				inArray(tasks.status, [
					"pending",
					"launching",
					"launched",
					"starting",
					"running",
				]),
			),
		);
	return Number(row?.count || 0);
};

export const cancelOpenTasksByScanJobIdRepo = async (
	scanJobId: string,
	errorMessage?: string | null,
) =>
	await db
		.update(tasks)
		.set({
			status: "canceled",
			errorMessage: errorMessage ?? null,
			completedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		})
		.where(
			and(
				eq(tasks.scanJobId, scanJobId),
				inArray(tasks.status, [
					"pending",
					"launching",
					"launched",
					"starting",
					"running",
				]),
			),
		)
		.returning();

export const countTasksByScanJobStageAndStatusRepo = async (
	scanJobId: string,
) =>
	await db
		.select({
			stageName: tasks.stageName,
			status: tasks.status,
			count: sql<number>`count(*)::int`,
		})
		.from(tasks)
		.where(eq(tasks.scanJobId, scanJobId))
		.groupBy(tasks.stageName, tasks.status);
