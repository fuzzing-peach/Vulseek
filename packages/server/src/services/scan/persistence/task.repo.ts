import { db } from "@dokploy/server/db";
import { type taskStatusEnum, tasks } from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, count, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import {
	analysisSchema,
	triageSchema,
	verificationSchema,
} from "../artifacts/contracts/domain-object.contract";
import { createShortTaskId } from "../task-id";
import type { AnalysisResult, TriageResult, VerificationResult } from "../types";
import { readCandidateIdFromTaskInputArtifact } from "./task-artifact-resolver";

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
				inArray(tasks.status, ["launching", "running"]),
			),
		)
		.orderBy(desc(tasks.createdAt));

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
				inArray(tasks.status, ["launching", "running"]),
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
	const updated = await db
		.update(tasks)
		.set({
			...input.patch,
			status: input.to,
			updatedAt: now,
			...(input.to === "launching" || input.to === "running"
				? { startedAt: now, completedAt: null }
				: {}),
			...(input.to === "completed" ||
			input.to === "failed" ||
			input.to === "exited"
				? { completedAt: now }
				: {}),
		})
		.where(
			and(eq(tasks.taskId, input.taskId), inArray(tasks.status, input.from)),
		)
		.returning();

	return updated[0] || null;
};

export const updateTaskRepo = async (
	taskId: string,
	patch: Partial<typeof tasks.$inferSelect>,
) => {
	const updated = await db
		.update(tasks)
		.set({
			...patch,
			updatedAt: new Date().toISOString(),
		})
		.where(eq(tasks.taskId, taskId))
		.returning();

	if (!updated[0]) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Task not found",
		});
	}

	return updated[0];
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

	if (input.status === "launching" || input.status === "running") {
		patch.startedAt = new Date().toISOString();
		patch.completedAt = null;
	}

	if (
		input.status === "completed" ||
		input.status === "failed" ||
		input.status === "exited"
	) {
		patch.completedAt = new Date().toISOString();
	}

	return await updateTaskRepo(input.taskId, patch);
};

export const bindTaskRuntimeRepo = async (input: {
	taskId: string;
	containerName?: string | null;
	threadId?: string | null;
	agentProfile?: typeof tasks.$inferSelect.agentProfile;
}) =>
	await updateTaskRepo(input.taskId, {
		containerName: input.containerName,
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
	const updated = await db
		.update(tasks)
		.set({
			status: "pending",
			errorMessage: null,
			startedAt: null,
			completedAt: null,
			containerName: null,
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

	if (!updated[0]) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Task not found",
		});
	}

	return updated[0];
};

export const requeueTaskRepo = async (taskId: string) => {
	const updated = await db
		.update(tasks)
		.set({
			status: "pending",
			errorMessage: null,
			startedAt: null,
			completedAt: null,
			containerName: null,
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

	if (!updated[0]) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Task not found",
		});
	}

	return updated[0];
};

export const listAnalysisResultsByScanJobIdRepo = async (
	scanJobId: string,
): Promise<AnalysisResult[]> => {
	const analysisTasks = await listTasksByScanJobAndStageRepo({
		scanJobId,
		stageName: "analyze",
	});
	return (
		await Promise.all(analysisTasks.map(buildAnalysisTaskResultView))
	).filter((item): item is AnalysisResult => Boolean(item));
};

export const listVerificationResultsByScanJobIdRepo = async (
	scanJobId: string,
): Promise<VerificationResult[]> => {
	const verificationTasks = await listTasksByScanJobAndStageRepo({
		scanJobId,
		stageName: "verify",
	});
	return (
		await Promise.all(verificationTasks.map(buildVerificationTaskResultView))
	).filter((item): item is VerificationResult => Boolean(item));
};

export const listTriageResultsByScanJobIdRepo = async (
	scanJobId: string,
): Promise<TriageResult[]> => {
	const triageTasks = await listTasksByScanJobAndStageRepo({
		scanJobId,
		stageName: "triage",
	});
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
			if (task.stageName !== "analyze") {
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
			if (task.stageName !== "verify") {
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
			if (task.stageName !== "triage") {
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
