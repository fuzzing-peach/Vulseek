import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { db } from "@dokploy/server/db";
import {
	analysisResults,
	type apiCheckoutScanEnvironment,
	type apiCreateScanJob,
	scanFunctionTasks,
	scanJobs,
	scanModuleTasks,
	scanPhaseEnum,
	scanJobStatusEnum,
	scanTaskStatusEnum,
	verificationResults,
	vulnerabilityCandidateStatusEnum,
	vulnerabilityCandidates,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { Queue } from "bullmq";
import { and, desc, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { SandboxAgent } from "sandbox-agent";
import { Agent, type Dispatcher } from "undici";
import { execAsync } from "../utils/process/execAsync";
import { getGlobalContainerEnvironmentPairs } from "../utils/docker/utils";
import {
	prepareSandboxAgentRuntime,
} from "./sandbox-agent/runtime";
import { findApplicationById } from "./application";
import { findComposeById } from "./compose";

export const DEFAULT_DELTA_COMMIT_WINDOW = 3;
const DEFAULT_FULL_SCAN_MODULE_CONCURRENCY = 4;
const DEFAULT_FULL_SCAN_FUNCTION_CONCURRENCY = 4;
const DEFAULT_ANALYSIS_CONCURRENCY = 2;
const DEFAULT_VERIFY_CONCURRENCY = 1;
const ACP_HTTP_TIMEOUT_MS = 15 * 60 * 1000;

export type ScanJob = typeof scanJobs.$inferSelect;
export type ScanModuleTask = typeof scanModuleTasks.$inferSelect;
export type ScanFunctionTask = typeof scanFunctionTasks.$inferSelect;
export type VulnerabilityCandidate = typeof vulnerabilityCandidates.$inferSelect;
export type AnalysisResult = typeof analysisResults.$inferSelect;
export type VerificationResult = typeof verificationResults.$inferSelect;
type VulnerabilityCandidateStage = "analyzing" | "fuzzing" | "verifying";

type JsonRpcMessage = {
	id?: number | string;
	method?: string;
	params?: Record<string, unknown>;
	result?: Record<string, unknown>;
	error?: {
		code?: number;
		message?: string;
		data?: unknown;
	};
};

type JsonRpcMessageWithLine = {
	line: number;
	timestamp?: string;
	message: JsonRpcMessage;
};

type SandboxAgentSessionEvent = {
	id?: string;
	eventIndex?: number;
	sessionId?: string;
	createdAt?: string;
	connectionId?: string;
	sender?: string;
	payload?: unknown;
};

type ScanRuntimeLiveAction = {
	itemId: string;
	itemType: string;
	actionType: string;
	actionText: string;
};

export const MAX_CANDIDATE_ANALYSIS_WORKER_CONCURRENCY = 16;
export const MAX_CANDIDATE_VERIFICATION_WORKER_CONCURRENCY = 16;
export const MAX_SCAN_MODULE_WORKER_CONCURRENCY = 32;
export const MAX_SCAN_FUNCTION_WORKER_CONCURRENCY = 32;

export const SCAN_MODULE_QUEUE_NAME = "scan-module";
export const SCAN_FUNCTION_QUEUE_NAME = "scan-function";
export const SCAN_CANDIDATE_ANALYSIS_QUEUE_NAME = "scan-candidate-analysis";
export const SCAN_CANDIDATE_VERIFICATION_QUEUE_NAME =
	"scan-candidate-verification";

export type ScanModuleQueueJob = {
	scanJobId: string;
	scanModuleTaskId: string;
};

export type ScanFunctionQueueJob = {
	scanJobId: string;
	scanFunctionTaskId: string;
};

export type ScanCandidateQueueJob = {
	scanJobId: string;
	vulnerabilityCandidateId: string;
};

type RequestInitWithDispatcher = RequestInit & {
	dispatcher?: Dispatcher;
};

const acpHttpDispatcher = new Agent({
	headersTimeout: ACP_HTTP_TIMEOUT_MS,
	bodyTimeout: ACP_HTTP_TIMEOUT_MS,
});

const sandboxAgentFetch: typeof fetch = async (input, init) => {
	const nextInit: RequestInitWithDispatcher = {
		...(init || {}),
		dispatcher:
			(init as RequestInitWithDispatcher | undefined)?.dispatcher ||
			acpHttpDispatcher,
	};
	return fetch(input, nextInit);
};

const parseRedisConnection = (url?: string) => {
	if (!url) {
		return {
			host: process.env.REDIS_HOST || "dokploy-redis-dev",
			port: process.env.REDIS_PORT
				? Number.parseInt(process.env.REDIS_PORT, 10)
				: 6379,
		};
	}

	try {
		const parsed = new URL(url);
		return {
			host: parsed.hostname || "dokploy-redis-dev",
			port: parsed.port ? Number.parseInt(parsed.port, 10) : 6379,
		};
	} catch {
		return {
			host: url,
			port: 6379,
		};
	}
};

const bullRedisConnection = parseRedisConnection(process.env.REDIS_URL);

const moduleScanQueue = new Queue<ScanModuleQueueJob>(SCAN_MODULE_QUEUE_NAME, {
	connection: bullRedisConnection,
});

const functionScanQueue = new Queue<ScanFunctionQueueJob>(
	SCAN_FUNCTION_QUEUE_NAME,
	{
		connection: bullRedisConnection,
	},
);

const candidateAnalysisQueue = new Queue<ScanCandidateQueueJob>(
	SCAN_CANDIDATE_ANALYSIS_QUEUE_NAME,
	{
		connection: bullRedisConnection,
	},
);

const candidateVerificationQueue = new Queue<ScanCandidateQueueJob>(
	SCAN_CANDIDATE_VERIFICATION_QUEUE_NAME,
	{
		connection: bullRedisConnection,
	},
);

type VerificationExecutionState = {
	active: number;
	waiters: Array<() => void>;
};

type ScanTaskExecutionState = {
	active: number;
	waiters: Array<() => void>;
};

type AnalysisExecutionState = {
	active: number;
	waiters: Array<() => void>;
};

const moduleExecutionStateByKey = new Map<string, ScanTaskExecutionState>();
const functionExecutionStateByKey = new Map<string, ScanTaskExecutionState>();
const verificationExecutionStateByKey = new Map<
	string,
	VerificationExecutionState
>();
const analysisExecutionStateByKey = new Map<string, AnalysisExecutionState>();

const getVerificationExecutionState = (key: string) => {
	const existing = verificationExecutionStateByKey.get(key);
	if (existing) {
		return existing;
	}

	const state: VerificationExecutionState = {
		active: 0,
		waiters: [],
	};
	verificationExecutionStateByKey.set(key, state);
	return state;
};

const getScanTaskExecutionState = (
	stateMap: Map<string, ScanTaskExecutionState>,
	key: string,
) => {
	const existing = stateMap.get(key);
	if (existing) {
		return existing;
	}

	const state: ScanTaskExecutionState = {
		active: 0,
		waiters: [],
	};
	stateMap.set(key, state);
	return state;
};

const acquireScanTaskExecutionSlot = async (
	stateMap: Map<string, ScanTaskExecutionState>,
	key: string,
	limit: number,
) =>
	await new Promise<() => void>((resolve) => {
		const normalizedLimit = Math.max(1, limit);
		const tryAcquire = () => {
			const state = getScanTaskExecutionState(stateMap, key);
			if (state.active < normalizedLimit) {
				state.active += 1;
				resolve(() => {
					const current = stateMap.get(key);
					if (!current) {
						return;
					}

					current.active = Math.max(0, current.active - 1);
					const next = current.waiters.shift();
					if (next) {
						queueMicrotask(next);
						return;
					}

					if (current.active === 0) {
						stateMap.delete(key);
					}
				});
				return;
			}

			state.waiters.push(tryAcquire);
		};

		tryAcquire();
	});

const acquireVerificationExecutionSlot = async (
	key: string,
	limit: number,
) =>
	await new Promise<() => void>((resolve) => {
		const normalizedLimit = Math.max(1, limit);
		const tryAcquire = () => {
			const state = getVerificationExecutionState(key);
			if (state.active < normalizedLimit) {
				state.active += 1;
				resolve(() => {
					const current = verificationExecutionStateByKey.get(key);
					if (!current) {
						return;
					}

					current.active = Math.max(0, current.active - 1);
					const next = current.waiters.shift();
					if (next) {
						queueMicrotask(next);
						return;
					}

					if (current.active === 0) {
						verificationExecutionStateByKey.delete(key);
					}
				});
				return;
			}

			state.waiters.push(tryAcquire);
		};

		tryAcquire();
	});

const getAnalysisExecutionState = (key: string) => {
	const existing = analysisExecutionStateByKey.get(key);
	if (existing) {
		return existing;
	}

	const state: AnalysisExecutionState = {
		active: 0,
		waiters: [],
	};
	analysisExecutionStateByKey.set(key, state);
	return state;
};

const acquireAnalysisExecutionSlot = async (key: string, limit: number) =>
	await new Promise<() => void>((resolve) => {
		const normalizedLimit = Math.max(1, limit);
		const tryAcquire = () => {
			const state = getAnalysisExecutionState(key);
			if (state.active < normalizedLimit) {
				state.active += 1;
				resolve(() => {
					const current = analysisExecutionStateByKey.get(key);
					if (!current) {
						return;
					}

					current.active = Math.max(0, current.active - 1);
					const next = current.waiters.shift();
					if (next) {
						queueMicrotask(next);
						return;
					}

					if (current.active === 0) {
						analysisExecutionStateByKey.delete(key);
					}
				});
				return;
			}

			state.waiters.push(tryAcquire);
		};

		tryAcquire();
	});

const sleep = async (ms: number) =>
	await new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});

const SANDBOX_AGENT_PROMPT_TIMEOUT_MS = 15 * 60 * 1000;

type AgentProfileLike = {
	agentProfileId: string;
	name: string;
	provider: "codex" | "claude_code";
	baseUrl: string;
	apiKey: string;
	model: string;
	thinkingLevel: string;
	isEnabled: boolean;
};

const extractNamedString = (
	value: unknown,
	keys: string[],
): string | null => {
	if (!value || typeof value !== "object") {
		return null;
	}

	const record = value as Record<string, unknown>;
	for (const key of keys) {
		if (typeof record[key] === "string") {
			return record[key] as string;
		}
	}

	return null;
};

const extractTurnErrorMessage = (value: unknown): string | null => {
	if (!value || typeof value !== "object") {
		return null;
	}

	const record = value as Record<string, unknown>;
	const directMessage = extractNamedString(record.error, ["message"]);
	if (directMessage) {
		return directMessage;
	}

	return extractNamedString(value, ["message", "additionalDetails"]);
};

const withTimeout = async <T>(
	promise: Promise<T>,
	timeoutMs: number,
	errorFactory: () => Error,
): Promise<T> =>
	await new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(errorFactory());
		}, timeoutMs);

		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
			);
		});

const isPromptPayloadSchemaError = (error: unknown) => {
	if (!(error instanceof Error)) {
		return false;
	}

	const message = error.message.toLowerCase();
	return (
		(message.includes("invalid") ||
			message.includes("schema") ||
			message.includes("string")) &&
		!message.includes("timed out")
	);
};

export const createScanJob = async (input: typeof apiCreateScanJob._type) => {
	const created = await db
		.insert(scanJobs)
		.values({
			applicationId: input.applicationId,
			composeId: input.composeId,
			scanType: input.scanType,
			title:
				input.title ||
				(input.scanType === "delta" ? "Delta Scan Job" : "Full Scan Job"),
			description: input.description || "",
			triggerSource: input.triggerSource || "manual",
			commitSha: input.commitSha,
			baseSha: input.baseSha,
			targetRef: input.targetRef,
			targetTag: input.targetTag,
			commitWindow: input.commitWindow || DEFAULT_DELTA_COMMIT_WINDOW,
			status: "queued",
			scanPhase: "queued",
			repositoryTaskStatus: "queued",
		})
		.returning();

	if (!created[0]) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error creating scan job",
		});
	}

	return created[0];
};

export const findScanJobById = async (scanJobId: string) => {
	const scanJob = await db
		.select()
		.from(scanJobs)
		.where(eq(scanJobs.scanJobId, scanJobId))
		.limit(1)
		.then((rows) => rows[0]);

	if (!scanJob) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Scan job not found",
		});
	}

	return scanJob;
};

export const findAllScanJobsByApplicationId = async (applicationId: string) =>
	await db
		.select()
		.from(scanJobs)
		.where(eq(scanJobs.applicationId, applicationId))
		.orderBy(desc(scanJobs.createdAt));

export const findAllScanJobsByComposeId = async (composeId: string) =>
	await db
		.select()
		.from(scanJobs)
		.where(eq(scanJobs.composeId, composeId))
		.orderBy(desc(scanJobs.createdAt));

export const updateScanJobNote = async (
	scanJobId: string,
	note: string | null,
) => {
	const updated = await db
		.update(scanJobs)
		.set({ note })
		.where(eq(scanJobs.scanJobId, scanJobId))
		.returning();

	if (!updated[0]) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Scan job not found",
		});
	}

	return updated[0];
};

export const updateScanJobStatus = async (
	scanJobId: string,
	status: (typeof scanJobStatusEnum.enumValues)[number],
	errorMessage?: string,
) => {
	const patch: Partial<ScanJob> = {
		status,
	};

	if (status === "analyzing") {
		patch.scanPhase = "analyzing";
	}

	if (status === "verifying") {
		patch.scanPhase = "verifying";
	}

	if (status === "scanning") {
		patch.startedAt = new Date().toISOString();
	}

	if (status === "completed" || status === "failed") {
		patch.finishedAt = new Date().toISOString();
		patch.scanPhase = status;
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
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Scan job not found",
		});
	}

	return updated[0];
};

export const resetScanJobForRetry = async (
	scanJobId: string,
	input?: {
		status?: (typeof scanJobStatusEnum.enumValues)[number];
		scanPhase?: (typeof scanPhaseEnum.enumValues)[number];
		errorMessage?: string | null;
		repositoryTaskStatus?: (typeof scanTaskStatusEnum.enumValues)[number];
	},
) => {
	const updated = await db
		.update(scanJobs)
		.set({
			status: input?.status || "queued",
			scanPhase: input?.scanPhase || "queued",
			errorMessage:
				input && "errorMessage" in input ? (input.errorMessage ?? null) : null,
			finishedAt: null,
			startedAt: null,
			repositoryTaskStatus:
				input?.repositoryTaskStatus || undefined,
		})
		.where(eq(scanJobs.scanJobId, scanJobId))
		.returning();

	if (!updated[0]) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Scan job not found",
		});
	}

	return updated[0];
};

export const updateScanJobPhase = async (
	scanJobId: string,
	scanPhase: (typeof scanPhaseEnum.enumValues)[number],
) => {
	const updated = await db
		.update(scanJobs)
		.set({
			scanPhase,
		})
		.where(eq(scanJobs.scanJobId, scanJobId))
		.returning();

	if (!updated[0]) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Scan job not found",
		});
	}

	return updated[0];
};

export const updateScanJobRepositoryTaskStatus = async (
	scanJobId: string,
	repositoryTaskStatus: (typeof scanTaskStatusEnum.enumValues)[number],
) => {
	const updated = await db
		.update(scanJobs)
		.set({
			repositoryTaskStatus,
		})
		.where(eq(scanJobs.scanJobId, scanJobId))
		.returning();

	if (!updated[0]) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Scan job not found",
		});
	}

	return updated[0];
};

export const recalculateScanTaskCounts = async (scanJobId: string) => {
	const moduleRows = await db
		.select({
			status: scanModuleTasks.status,
			count: sql<number>`count(*)::int`,
		})
		.from(scanModuleTasks)
		.where(eq(scanModuleTasks.scanJobId, scanJobId))
		.groupBy(scanModuleTasks.status);

	const functionRows = await db
		.select({
			status: scanFunctionTasks.status,
			count: sql<number>`count(*)::int`,
		})
		.from(scanFunctionTasks)
		.where(eq(scanFunctionTasks.scanJobId, scanJobId))
		.groupBy(scanFunctionTasks.status);

	const moduleCounts = {
		total: 0,
		completed: 0,
		failed: 0,
	};
	for (const row of moduleRows) {
		moduleCounts.total += row.count;
		if (row.status === "completed") {
			moduleCounts.completed += row.count;
		}
		if (row.status === "failed") {
			moduleCounts.failed += row.count;
		}
	}

	const functionCounts = {
		total: 0,
		completed: 0,
		failed: 0,
	};
	for (const row of functionRows) {
		functionCounts.total += row.count;
		if (row.status === "completed") {
			functionCounts.completed += row.count;
		}
		if (row.status === "failed") {
			functionCounts.failed += row.count;
		}
	}

	const updated = await db
		.update(scanJobs)
		.set({
			moduleTasksTotal: moduleCounts.total,
			moduleTasksCompleted: moduleCounts.completed,
			moduleTasksFailed: moduleCounts.failed,
			functionTasksTotal: functionCounts.total,
			functionTasksCompleted: functionCounts.completed,
			functionTasksFailed: functionCounts.failed,
		})
		.where(eq(scanJobs.scanJobId, scanJobId))
		.returning();

	return updated[0] || null;
};

export const createScanModuleTask = async (input: {
	scanJobId: string;
	moduleId: string;
	moduleName: string;
	priority?: number;
	attempt?: number;
	moduleScanMdPath?: string;
	moduleScanJsonPath?: string;
	functionPlanJsonPath?: string;
	containerName?: string;
	threadId?: string;
}) => {
	const created = await db
		.insert(scanModuleTasks)
		.values({
			scanJobId: input.scanJobId,
			moduleId: input.moduleId,
			moduleName: input.moduleName,
			priority: input.priority ?? 0,
			attempt: input.attempt ?? 0,
			moduleScanMdPath: input.moduleScanMdPath,
			moduleScanJsonPath: input.moduleScanJsonPath,
			functionPlanJsonPath: input.functionPlanJsonPath,
			containerName: input.containerName,
			threadId: input.threadId,
		})
		.returning();

	await recalculateScanTaskCounts(input.scanJobId);

	if (!created[0]) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error creating scan module task",
		});
	}

	return created[0];
};

export const findScanModuleTasksByScanJobId = async (scanJobId: string) =>
	await db
		.select()
		.from(scanModuleTasks)
		.where(eq(scanModuleTasks.scanJobId, scanJobId))
		.orderBy(desc(scanModuleTasks.createdAt));

export const findScanModuleTaskById = async (scanModuleTaskId: string) => {
	const task = await db
		.select()
		.from(scanModuleTasks)
		.where(eq(scanModuleTasks.scanModuleTaskId, scanModuleTaskId))
		.limit(1)
		.then((rows) => rows[0] || null);

	if (!task) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Scan module task not found",
		});
	}

	return task;
};

export const updateScanModuleTask = async (
	scanModuleTaskId: string,
	patch: Partial<ScanModuleTask>,
) => {
	const now = new Date().toISOString();
	const updated = await db
		.update(scanModuleTasks)
		.set({
			...patch,
			updatedAt: now,
		})
		.where(eq(scanModuleTasks.scanModuleTaskId, scanModuleTaskId))
		.returning();

	const row = updated[0];
	if (!row) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Scan module task not found",
		});
	}

	await recalculateScanTaskCounts(row.scanJobId);
	return row;
};

export const updateScanModuleTaskStatus = async (
	scanModuleTaskId: string,
	status: (typeof scanTaskStatusEnum.enumValues)[number],
	errorMessage?: string,
) => {
	const patch: Partial<ScanModuleTask> = {
		status,
		errorMessage,
	};
	if (status === "running") {
		patch.startedAt = new Date().toISOString();
	}
	if (status === "completed" || status === "failed") {
		patch.completedAt = new Date().toISOString();
	}
	return await updateScanModuleTask(scanModuleTaskId, patch);
};

export const createScanFunctionTask = async (input: {
	scanJobId: string;
	scanModuleTaskId: string;
	moduleId: string;
	moduleName: string;
	functionId: string;
	functionName: string;
	filePath?: string;
	line?: number;
	priority?: number;
	attempt?: number;
	score?: number;
	riskType?: string;
	summary?: string;
	functionScanMdPath?: string;
	functionScanJsonPath?: string;
	containerName?: string;
	threadId?: string;
}) => {
	const created = await db
		.insert(scanFunctionTasks)
		.values({
			scanJobId: input.scanJobId,
			scanModuleTaskId: input.scanModuleTaskId,
			moduleId: input.moduleId,
			moduleName: input.moduleName,
			functionId: input.functionId,
			functionName: input.functionName,
			filePath: input.filePath,
			line: input.line,
			priority: input.priority ?? 0,
			attempt: input.attempt ?? 0,
			score: input.score,
			riskType: input.riskType,
			summary: input.summary,
			functionScanMdPath: input.functionScanMdPath,
			functionScanJsonPath: input.functionScanJsonPath,
			containerName: input.containerName,
			threadId: input.threadId,
		})
		.returning();

	await recalculateScanTaskCounts(input.scanJobId);

	if (!created[0]) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error creating scan function task",
		});
	}

	return created[0];
};

export const findScanFunctionTasksByScanJobId = async (scanJobId: string) =>
	await db
		.select()
		.from(scanFunctionTasks)
		.where(eq(scanFunctionTasks.scanJobId, scanJobId))
		.orderBy(desc(scanFunctionTasks.createdAt));

export const findScanFunctionTaskById = async (scanFunctionTaskId: string) => {
	const task = await db
		.select()
		.from(scanFunctionTasks)
		.where(eq(scanFunctionTasks.scanFunctionTaskId, scanFunctionTaskId))
		.limit(1)
		.then((rows) => rows[0] || null);

	if (!task) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Scan function task not found",
		});
	}

	return task;
};

export const findScanFunctionTasksByModuleTaskId = async (
	scanModuleTaskId: string,
) =>
	await db
		.select()
		.from(scanFunctionTasks)
		.where(eq(scanFunctionTasks.scanModuleTaskId, scanModuleTaskId))
		.orderBy(desc(scanFunctionTasks.createdAt));

export const updateScanFunctionTask = async (
	scanFunctionTaskId: string,
	patch: Partial<ScanFunctionTask>,
) => {
	const now = new Date().toISOString();
	const updated = await db
		.update(scanFunctionTasks)
		.set({
			...patch,
			updatedAt: now,
		})
		.where(eq(scanFunctionTasks.scanFunctionTaskId, scanFunctionTaskId))
		.returning();

	const row = updated[0];
	if (!row) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Scan function task not found",
		});
	}

	await recalculateScanTaskCounts(row.scanJobId);
	return row;
};

export const updateScanFunctionTaskStatus = async (
	scanFunctionTaskId: string,
	status: (typeof scanTaskStatusEnum.enumValues)[number],
	errorMessage?: string,
) => {
	const patch: Partial<ScanFunctionTask> = {
		status,
		errorMessage,
	};
	if (status === "running") {
		patch.startedAt = new Date().toISOString();
	}
	if (status === "completed" || status === "failed") {
		patch.completedAt = new Date().toISOString();
	}
	return await updateScanFunctionTask(scanFunctionTaskId, patch);
};

export const retryFailedFullScanTasks = async (scanJobId: string) => {
	const scanJob = await findScanJobById(scanJobId);
	if (scanJob.scanType !== "full") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Retry failed scanning tasks is only supported for full scan jobs",
		});
	}
	if (scanJob.status !== "failed") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Only failed full scan jobs can retry failed scanning tasks",
		});
	}

	const [moduleTasks, functionTasks] = await Promise.all([
		findScanModuleTasksByScanJobId(scanJobId),
		findScanFunctionTasksByScanJobId(scanJobId),
	]);

	const runningModuleTask = moduleTasks.find((task) => task.status === "running");
	const runningFunctionTask = functionTasks.find((task) => task.status === "running");
	if (
		scanJob.repositoryTaskStatus === "running" ||
		runningModuleTask ||
		runningFunctionTask
	) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Scan job is still running scanning tasks",
		});
	}

	const failedModuleTasks = moduleTasks.filter((task) => task.status === "failed");
	const failedFunctionTasks = functionTasks.filter((task) => task.status === "failed");

	if (failedModuleTasks.length === 0 && failedFunctionTasks.length === 0) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "No failed module or function scanning tasks to retry",
		});
	}

	const now = new Date().toISOString();
	for (const task of failedModuleTasks) {
		await db
			.update(scanModuleTasks)
			.set({
				status: "queued",
				errorMessage: null,
				startedAt: null,
				completedAt: null,
				updatedAt: now,
			})
			.where(eq(scanModuleTasks.scanModuleTaskId, task.scanModuleTaskId));
	}

	for (const task of failedFunctionTasks) {
		await db
			.update(scanFunctionTasks)
			.set({
				status: "queued",
				errorMessage: null,
				startedAt: null,
				completedAt: null,
				updatedAt: now,
			})
			.where(eq(scanFunctionTasks.scanFunctionTaskId, task.scanFunctionTaskId));
	}

	await recalculateScanTaskCounts(scanJobId);
	const nextPhase =
		failedModuleTasks.length > 0 ? "module_scanning" : "function_scanning";
	await resetScanJobForRetry(scanJobId, {
		status: "queued",
		scanPhase: nextPhase,
		errorMessage: null,
		repositoryTaskStatus: scanJob.repositoryTaskStatus,
	});

	return {
		scanJobId,
		retriedModuleTasks: failedModuleTasks.length,
		retriedFunctionTasks: failedFunctionTasks.length,
	};
};

const resetScanJobForCandidateRetry = async (
	scanJobId: string,
	status: "analyzing" | "verifying",
) => {
	const updated = await db
		.update(scanJobs)
		.set({
			status,
			scanPhase: status,
			errorMessage: null,
			finishedAt: null,
		})
		.where(eq(scanJobs.scanJobId, scanJobId))
		.returning();

	if (!updated[0]) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Scan job not found",
		});
	}

	return updated[0];
};

export const retryFailedAnalysisTasks = async (scanJobId: string) => {
	await findScanJobById(scanJobId);

	const candidates = await findVulnerabilityCandidatesByScanJobId(scanJobId);
	const failedAnalysisCandidates = candidates.filter(
		(candidate) =>
			candidate.status === "failed" && candidate.currentStage === "analyzing",
	);

	if (failedAnalysisCandidates.length === 0) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "No failed analysis tasks to retry",
		});
	}

	const now = new Date().toISOString();
	await Promise.all(
		failedAnalysisCandidates.map(async (candidate) => {
			await removeQueuedCandidateAnalysisWork(
				candidate.vulnerabilityCandidateId,
			).catch(() => {});
			await deleteAnalysisResultsByCandidateId(
				candidate.vulnerabilityCandidateId,
			);
			await resetCandidateAnalysisRuntimeFiles(
				scanJobId,
				candidate.vulnerabilityCandidateId,
			).catch(() => {});
			await updateVulnerabilityCandidateAnalysisThreadId(
				candidate.vulnerabilityCandidateId,
				"",
			).catch(() => {});
			await syncVulnerabilityCandidateResolvedRiskMetrics(
				candidate.vulnerabilityCandidateId,
			).catch(() => {});
			await db
				.update(vulnerabilityCandidates)
				.set({
					status: "queued",
					currentStage: "analyzing",
					updatedAt: now,
				})
				.where(
					eq(
						vulnerabilityCandidates.vulnerabilityCandidateId,
						candidate.vulnerabilityCandidateId,
					),
				);
			await enqueueCandidateAnalysisWork(
				scanJobId,
				candidate.vulnerabilityCandidateId,
			);
		}),
	);

	await resetScanJobForCandidateRetry(scanJobId, "analyzing");

	return {
		scanJobId,
		retriedCandidates: failedAnalysisCandidates.length,
	};
};

export const retryFailedVerificationTasks = async (scanJobId: string) => {
	await findScanJobById(scanJobId);

	const candidates = await findVulnerabilityCandidatesByScanJobId(scanJobId);
	const failedVerificationCandidates = candidates.filter(
		(candidate) =>
			candidate.status === "failed" && candidate.currentStage === "verifying",
	);

	if (failedVerificationCandidates.length === 0) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "No failed verification tasks to retry",
		});
	}

	const now = new Date().toISOString();
	await Promise.all(
		failedVerificationCandidates.map(async (candidate) => {
			await removeQueuedCandidateVerificationWork(
				candidate.vulnerabilityCandidateId,
			).catch(() => {});
			await deleteVerificationResultsByCandidateId(
				candidate.vulnerabilityCandidateId,
			);
			await resetCandidateVerifierRuntimeFiles(
				scanJobId,
				candidate.vulnerabilityCandidateId,
			).catch(() => {});
			await updateVulnerabilityCandidateVerifierThreadId(
				candidate.vulnerabilityCandidateId,
				"",
			).catch(() => {});
			await syncVulnerabilityCandidateResolvedRiskMetrics(
				candidate.vulnerabilityCandidateId,
			).catch(() => {});
			await db
				.update(vulnerabilityCandidates)
				.set({
					status: "queued",
					currentStage: "verifying",
					updatedAt: now,
				})
				.where(
					eq(
						vulnerabilityCandidates.vulnerabilityCandidateId,
						candidate.vulnerabilityCandidateId,
					),
				);
			await enqueueCandidateVerificationWork(
				scanJobId,
				candidate.vulnerabilityCandidateId,
			);
		}),
	);

	await resetScanJobForCandidateRetry(scanJobId, "verifying");

	return {
		scanJobId,
		retriedCandidates: failedVerificationCandidates.length,
	};
};

const updateScanJobScanningThreadId = async (
	scanJobId: string,
	scanningThreadId: string,
) => {
	const updated = await db
		.update(scanJobs)
		.set({
			scanningThreadId,
		})
		.where(eq(scanJobs.scanJobId, scanJobId))
		.returning();

	return updated[0] || null;
};

const updateScanJobTargetContext = async (
	scanJobId: string,
	input: {
		targetRef?: string | null;
		targetTag?: string | null;
		commitSha?: string | null;
		baseSha?: string | null;
		commitWindow?: number | null;
	},
) => {
	const patch: Partial<ScanJob> = {};

	if (input.targetRef !== undefined) {
		patch.targetRef = input.targetRef || null;
	}
	if (input.targetTag !== undefined) {
		patch.targetTag = input.targetTag || null;
	}
	if (input.commitSha !== undefined) {
		patch.commitSha = input.commitSha || null;
	}
	if (input.baseSha !== undefined) {
		patch.baseSha = input.baseSha || null;
	}
	if (typeof input.commitWindow === "number") {
		patch.commitWindow = input.commitWindow;
	}

	const updated = await db
		.update(scanJobs)
		.set(patch)
		.where(eq(scanJobs.scanJobId, scanJobId))
		.returning();

	return updated[0] || null;
};

export const createVulnerabilityCandidate = async (input: {
	scanJobId: string;
	title: string;
	description?: string;
	filePath?: string;
	line?: number;
	confidence?: number;
	score?: number;
	status?: (typeof vulnerabilityCandidateStatusEnum.enumValues)[number];
	currentStage?: VulnerabilityCandidateStage;
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
		const patch: Partial<VulnerabilityCandidate> = {
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

export const findVulnerabilityCandidatesByScanJobId = async (scanJobId: string) =>
	await db
		.select()
		.from(vulnerabilityCandidates)
		.where(eq(vulnerabilityCandidates.scanJobId, scanJobId))
		.orderBy(desc(vulnerabilityCandidates.createdAt));

export const findVulnerabilityCandidatesWithLatestAnalysisResultByScanJobId = async (
	scanJobId: string,
) => {
	const [candidates, analysisResultsList, verificationResultsList] = await Promise.all([
		findVulnerabilityCandidatesByScanJobId(scanJobId),
		findAnalysisResultsByScanJobId(scanJobId),
		findVerificationResultsByScanJobId(scanJobId),
	]);

	const latestAnalysisResultByCandidateId = new Map<string, AnalysisResult>();
	for (const analysisResult of analysisResultsList) {
		if (
			!latestAnalysisResultByCandidateId.has(
				analysisResult.vulnerabilityCandidateId,
			)
		) {
			latestAnalysisResultByCandidateId.set(
				analysisResult.vulnerabilityCandidateId,
				analysisResult as AnalysisResult,
			);
		}
	}

	const latestVerificationResultByCandidateId = new Map<
		string,
		VerificationResult
	>();
	for (const verificationResult of verificationResultsList) {
		if (
			!latestVerificationResultByCandidateId.has(
				verificationResult.vulnerabilityCandidateId,
			)
		) {
			latestVerificationResultByCandidateId.set(
				verificationResult.vulnerabilityCandidateId,
				verificationResult as VerificationResult,
			);
		}
	}

	return candidates.map((candidate) => {
		const latestAnalysisResult = latestAnalysisResultByCandidateId.get(
			candidate.vulnerabilityCandidateId,
		);
		const latestVerificationResult = latestVerificationResultByCandidateId.get(
			candidate.vulnerabilityCandidateId,
		);
		const analysisReportPath = buildCandidateAnalysisReportPath(
			candidate.scanJobId,
			candidate.vulnerabilityCandidateId,
		);
		const verificationArtifactPaths = buildCandidateVerificationArtifactPaths(
			candidate.scanJobId,
			candidate.vulnerabilityCandidateId,
		);
		const resolvedConfidence =
			typeof latestVerificationResult?.confidence === "number"
				? latestVerificationResult.confidence
				: typeof latestAnalysisResult?.confidence === "number"
					? latestAnalysisResult.confidence
					: candidate.confidence;
		const resolvedScore =
			typeof latestVerificationResult?.score === "number"
				? latestVerificationResult.score
				: typeof latestAnalysisResult?.score === "number"
					? latestAnalysisResult.score
					: candidate.score;

		return {
			...candidate,
			confidence: resolvedConfidence,
			score: resolvedScore,
			latestAnalysisResult: latestAnalysisResult
				? {
						analysisResultId: latestAnalysisResult.analysisResultId,
						result: latestAnalysisResult.result,
						confidence: latestAnalysisResult.confidence,
						score: latestAnalysisResult.score,
						reportPath: analysisReportPath,
						runtimeSeconds: latestAnalysisResult.runtimeSeconds,
						threadId: latestAnalysisResult.threadId,
						summary: latestAnalysisResult.summary,
						createdAt: latestAnalysisResult.createdAt,
						updatedAt: latestAnalysisResult.updatedAt,
					}
				: null,
			latestVerificationResult: latestVerificationResult
				? {
						verificationResultId: latestVerificationResult.verificationResultId,
						result: latestVerificationResult.result,
						isBug: latestVerificationResult.isBug,
						isSecurity: latestVerificationResult.isSecurity,
						confidence: latestVerificationResult.confidence,
						score: latestVerificationResult.score,
						reportPath: verificationArtifactPaths.reportPath,
						issueDraftPath: verificationArtifactPaths.issueDraftPath,
						pocPath: verificationArtifactPaths.pocPath,
						dockerfilePath: verificationArtifactPaths.dockerfilePath,
						runScriptPath: verificationArtifactPaths.runScriptPath,
						runtimeSeconds: latestVerificationResult.runtimeSeconds,
						threadId: latestVerificationResult.threadId,
						summary: latestVerificationResult.summary,
						createdAt: latestVerificationResult.createdAt,
						updatedAt: latestVerificationResult.updatedAt,
					}
				: null,
		};
	});
};

export const findVulnerabilityCandidateById = async (
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
		.then((rows) => rows[0]);

	if (!candidate) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Vulnerability candidate not found",
		});
	}

	return candidate;
};

const updateVulnerabilityCandidateCurrentStage = async (
	vulnerabilityCandidateId: string,
	currentStage: VulnerabilityCandidateStage,
) => {
	const updated = await db
		.update(vulnerabilityCandidates)
		.set({
			currentStage,
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

const updateVulnerabilityCandidateStatus = async (
	vulnerabilityCandidateId: string,
	status: (typeof vulnerabilityCandidateStatusEnum.enumValues)[number],
) => {
	const updated = await db
		.update(vulnerabilityCandidates)
		.set({
			status,
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

const updateVulnerabilityCandidateAnalysisThreadId = async (
	vulnerabilityCandidateId: string,
	threadId: string,
) => {
	const patch: Partial<VulnerabilityCandidate> = {};
	patch.analysisThreadId = threadId;
	patch.updatedAt = new Date().toISOString();

	const updated = await db
		.update(vulnerabilityCandidates)
		.set(patch)
		.where(
			eq(
				vulnerabilityCandidates.vulnerabilityCandidateId,
				vulnerabilityCandidateId,
			),
		)
		.returning();

	return updated[0] || null;
};

const updateVulnerabilityCandidateVerifierThreadId = async (
	vulnerabilityCandidateId: string,
	threadId: string,
) => {
	const patch: Partial<VulnerabilityCandidate> = {};
	patch.verifierThreadId = threadId;
	patch.updatedAt = new Date().toISOString();

	const updated = await db
		.update(vulnerabilityCandidates)
		.set(patch)
		.where(
			eq(
				vulnerabilityCandidates.vulnerabilityCandidateId,
				vulnerabilityCandidateId,
			),
		)
		.returning();

	return updated[0] || null;
};

const updateVulnerabilityCandidateRiskMetrics = async (
	vulnerabilityCandidateId: string,
	input: {
		confidence?: number;
		score?: number;
	},
) => {
	const patch: Partial<VulnerabilityCandidate> = {
		updatedAt: new Date().toISOString(),
	};

	if (input.confidence !== undefined) {
		patch.confidence = input.confidence;
	}
	if (input.score !== undefined) {
		patch.score = input.score;
	}

	const updated = await db
		.update(vulnerabilityCandidates)
		.set(patch)
		.where(
			eq(
				vulnerabilityCandidates.vulnerabilityCandidateId,
				vulnerabilityCandidateId,
			),
		)
		.returning();

	return updated[0] || null;
};

const syncVulnerabilityCandidateResolvedRiskMetrics = async (
	vulnerabilityCandidateId: string,
) => {
	const [candidate, latestAnalysisResult, latestVerificationResult] =
		await Promise.all([
			findVulnerabilityCandidateById(vulnerabilityCandidateId),
			findLatestAnalysisResultByCandidateId(vulnerabilityCandidateId),
			findLatestVerificationResultByCandidateId(vulnerabilityCandidateId),
		]);

	return await updateVulnerabilityCandidateRiskMetrics(vulnerabilityCandidateId, {
		confidence:
			typeof latestVerificationResult?.confidence === "number"
				? latestVerificationResult.confidence
				: typeof latestAnalysisResult?.confidence === "number"
					? latestAnalysisResult.confidence
					: candidate.confidence ?? undefined,
		score:
			typeof latestVerificationResult?.score === "number"
				? latestVerificationResult.score
				: typeof latestAnalysisResult?.score === "number"
					? latestAnalysisResult.score
					: candidate.score ?? undefined,
	});
};

export const createAnalysisResult = async (input: {
	scanJobId: string;
	vulnerabilityCandidateId: string;
	result: string;
	confidence?: number;
	score?: number;
	reportPath?: string;
	runtimeSeconds?: number;
	threadId?: string;
	summary?: string;
}) => {
	const created = await db
		.insert(analysisResults)
		.values({
			scanJobId: input.scanJobId,
			vulnerabilityCandidateId: input.vulnerabilityCandidateId,
			result: input.result,
			confidence: input.confidence,
			score: input.score,
			reportPath: input.reportPath,
			runtimeSeconds: input.runtimeSeconds,
			threadId: input.threadId,
			summary: input.summary || "",
			updatedAt: new Date().toISOString(),
		})
		.returning();

	if (!created[0]) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error creating analysis result",
		});
	}

	return created[0];
};

export const findAnalysisResultsByScanJobId = async (scanJobId: string) =>
	await db
		.select({
			analysisResultId: analysisResults.analysisResultId,
			scanJobId: analysisResults.scanJobId,
			vulnerabilityCandidateId: analysisResults.vulnerabilityCandidateId,
			result: analysisResults.result,
			confidence: analysisResults.confidence,
			score: analysisResults.score,
			reportPath: analysisResults.reportPath,
			runtimeSeconds: analysisResults.runtimeSeconds,
			threadId: analysisResults.threadId,
			summary: analysisResults.summary,
			createdAt: analysisResults.createdAt,
			updatedAt: analysisResults.updatedAt,
		})
		.from(analysisResults)
		.innerJoin(
			vulnerabilityCandidates,
			eq(
				analysisResults.vulnerabilityCandidateId,
				vulnerabilityCandidates.vulnerabilityCandidateId,
			),
		)
		.where(eq(vulnerabilityCandidates.scanJobId, scanJobId))
		.orderBy(desc(analysisResults.createdAt));

const findLatestAnalysisResultByCandidateId = async (
	vulnerabilityCandidateId: string,
) => {
	const result = await db
		.select()
		.from(analysisResults)
		.where(eq(analysisResults.vulnerabilityCandidateId, vulnerabilityCandidateId))
		.orderBy(desc(analysisResults.createdAt))
		.limit(1);

	return result[0] || null;
};

const deleteAnalysisResultsByCandidateId = async (
	vulnerabilityCandidateId: string,
) => {
	await db
		.delete(analysisResults)
		.where(
			eq(
				analysisResults.vulnerabilityCandidateId,
				vulnerabilityCandidateId,
			),
		);
};

export const createVerificationResult = async (input: {
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
	summary?: string;
}) => {
	const created = await db
		.insert(verificationResults)
		.values({
			scanJobId: input.scanJobId,
			vulnerabilityCandidateId: input.vulnerabilityCandidateId,
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
			summary: input.summary || "",
			updatedAt: new Date().toISOString(),
		})
		.returning();

	if (!created[0]) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error creating verification result",
		});
	}

	return created[0];
};

export const findVerificationResultsByScanJobId = async (scanJobId: string) =>
	await db
		.select({
			verificationResultId: verificationResults.verificationResultId,
			scanJobId: verificationResults.scanJobId,
			vulnerabilityCandidateId: verificationResults.vulnerabilityCandidateId,
			result: verificationResults.result,
			isBug: verificationResults.isBug,
			isSecurity: verificationResults.isSecurity,
			confidence: verificationResults.confidence,
			score: verificationResults.score,
			reportPath: verificationResults.reportPath,
			issueDraftPath: verificationResults.issueDraftPath,
			pocPath: verificationResults.pocPath,
			dockerfilePath: verificationResults.dockerfilePath,
			runScriptPath: verificationResults.runScriptPath,
			runtimeSeconds: verificationResults.runtimeSeconds,
			threadId: verificationResults.threadId,
			summary: verificationResults.summary,
			createdAt: verificationResults.createdAt,
			updatedAt: verificationResults.updatedAt,
		})
		.from(verificationResults)
		.innerJoin(
			vulnerabilityCandidates,
			eq(
				verificationResults.vulnerabilityCandidateId,
				vulnerabilityCandidates.vulnerabilityCandidateId,
			),
		)
		.where(eq(vulnerabilityCandidates.scanJobId, scanJobId))
		.orderBy(desc(verificationResults.createdAt));

const findLatestVerificationResultByCandidateId = async (
	vulnerabilityCandidateId: string,
) => {
	const result = await db
		.select()
		.from(verificationResults)
		.where(
			eq(
				verificationResults.vulnerabilityCandidateId,
				vulnerabilityCandidateId,
			),
		)
		.orderBy(desc(verificationResults.createdAt))
		.limit(1);

	return result[0] || null;
};

const deleteVerificationResultsByCandidateId = async (
	vulnerabilityCandidateId: string,
) => {
	await db
		.delete(verificationResults)
		.where(
			eq(
				verificationResults.vulnerabilityCandidateId,
				vulnerabilityCandidateId,
			),
		);
};

const toGitUrl = (
	provider: "github" | "gitlab" | "bitbucket" | "gitea",
	owner: string,
	repository: string,
	giteaHost?: string | null,
) => {
	const cleanedRepo = repository.replace(/\.git$/, "");
	if (cleanedRepo.includes("/")) {
		if (provider === "github") return `https://github.com/${cleanedRepo}.git`;
		if (provider === "gitlab") return `https://gitlab.com/${cleanedRepo}.git`;
		if (provider === "bitbucket")
			return `https://bitbucket.org/${cleanedRepo}.git`;
		return `https://${giteaHost || "gitea.local"}/${cleanedRepo}.git`;
	}
	if (provider === "github") return `https://github.com/${owner}/${cleanedRepo}.git`;
	if (provider === "gitlab") return `https://gitlab.com/${owner}/${cleanedRepo}.git`;
	if (provider === "bitbucket")
		return `https://bitbucket.org/${owner}/${cleanedRepo}.git`;
	return `https://${giteaHost || "gitea.local"}/${owner}/${cleanedRepo}.git`;
};

const isUrlLike = (value?: string | null) =>
	Boolean(value && /^(https?:\/\/|git@)/.test(value));

const buildScanDockerfileTemplate = () => `FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive
ARG GIT_URL="<GIT_URL>"
ARG GIT_BRANCH="<GIT_BRANCH>"
ARG ENABLE_SUBMODULES="false"
ARG CODEQL_VERSION="2.20.6"
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY
ARG http_proxy
ARG https_proxy
ARG no_proxy

ENV HTTP_PROXY=$HTTP_PROXY \\
    HTTPS_PROXY=$HTTPS_PROXY \\
    NO_PROXY=$NO_PROXY \\
    http_proxy=$http_proxy \\
    https_proxy=$https_proxy \\
    no_proxy=$no_proxy

RUN sed -i 's|http://archive.ubuntu.com/ubuntu/|http://mirrors.ustc.edu.cn/ubuntu/|g; s|http://security.ubuntu.com/ubuntu/|http://mirrors.ustc.edu.cn/ubuntu/|g' /etc/apt/sources.list.d/ubuntu.sources

RUN apt-get update && apt-get install -y --no-install-recommends \\
    ca-certificates curl wget git jq unzip zip tar xz-utils file gnupg \\
    openssh-client ripgrep vim nano less rsync tree \\
    build-essential cmake ninja-build make autoconf automake libtool pkg-config \\
    clang clangd lldb lld gdb \\
    python3 python3-pip python3-venv \\
    pipx \\
    software-properties-common \\
    && rm -rf /var/lib/apt/lists/*

RUN sed -i 's|http://mirrors.ustc.edu.cn/ubuntu/|https://mirrors.ustc.edu.cn/ubuntu/|g' /etc/apt/sources.list.d/ubuntu.sources

# Node.js (LTS)
RUN curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - \\
    && apt-get update && apt-get install -y --no-install-recommends nodejs \\
    && rm -rf /var/lib/apt/lists/*

# Semgrep CLI
RUN PIPX_BIN_DIR=/usr/local/bin pipx install semgrep \
    && semgrep --version

# Vulseek parsing helpers
RUN python3 -m venv /opt/vulseek-venv \
    && /opt/vulseek-venv/bin/pip install --upgrade pip \
    && /opt/vulseek-venv/bin/pip install \
      tree-sitter \
      tree-sitter-c \
      tree-sitter-cpp

ENV PATH="/opt/vulseek-venv/bin:$PATH"

# LLM Agent CLIs
# Keep Claude non-fatal to avoid blocking build if registry/network fails.
RUN npm install -g @anthropic-ai/claude-code || true
# sandbox-agent is required by the experimental unified agent runtime.
RUN npm install -g @sandbox-agent/cli@0.4.x \
    && sandbox-agent --help >/dev/null
# Codex CLI is required for scan agents.
RUN npm install -g @openai/codex \
    && codex --version

# Serena
ENV PATH="/root/.local/bin:$PATH" \
    UV_TOOL_BIN_DIR="/usr/local/bin"
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR="/usr/local/bin" sh \
    && uv --version \
    && uv tool install -p 3.13 serena-agent@latest --prerelease=allow \
    && mkdir -p /root/.serena \
    && serena init -b LSP \
    && sed -i 's#^ls_specific_settings: {}#ls_specific_settings:\\n  cpp:\\n    ls_path: "/usr/bin/clangd"#' /root/.serena/serena_config.yml \
    && sed -i 's#^ignored_paths: \\[\\]#ignored_paths:\\n- "/scan-context"\\n- "/scan-context/**"#' /root/.serena/serena_config.yml \
    && sed -i 's#^project_serena_folder_location:.*#project_serena_folder_location: "/scan-context/.serena"#' /root/.serena/serena_config.yml \
    && serena --help >/dev/null

# CodeQL CLI
RUN mkdir -p /opt/codeql \\
    && curl -L "https://github.com/github/codeql-cli-binaries/releases/download/v\${CODEQL_VERSION}/codeql-linux64.zip" -o /tmp/codeql.zip \\
    && unzip -q /tmp/codeql.zip -d /opt \\
    && rm -f /tmp/codeql.zip \\
    && ln -sf /opt/codeql/codeql /usr/local/bin/codeql
RUN codeql pack download codeql/cpp-all

WORKDIR /workspace

RUN if [ "\${ENABLE_SUBMODULES}" = "true" ]; then \\
      git clone --progress --recursive --branch "\${GIT_BRANCH}" "\${GIT_URL}" repo; \\
    else \\
      git clone --progress --branch "\${GIT_BRANCH}" "\${GIT_URL}" repo; \\
    fi

WORKDIR /workspace/repo
CMD ["/bin/bash"]
`;

type CheckoutStatus = "running" | "completed" | "failed";

type CheckoutTask = {
	checkoutId: string;
	status: CheckoutStatus;
	imageTag: string;
	gitUrl: string;
	gitBranch: string;
	enableSubmodules: boolean;
	dockerfileTemplate: string;
	stdout: string;
	stderr: string;
	errorMessage?: string;
	startedAt: string;
	finishedAt?: string;
	applicationId?: string;
	composeId?: string;
};

const checkoutTasks = new Map<string, CheckoutTask>();
const MAX_LOG_CHARS = 400_000;

const appendLog = (base: string, chunk: string) => {
	const combined = `${base}${chunk}`;
	if (combined.length <= MAX_LOG_CHARS) return combined;
	return combined.slice(combined.length - MAX_LOG_CHARS);
};

const sanitizeForImageTag = (value: string) =>
	value
		.toLowerCase()
		.replace(/[^a-z0-9_.-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40) || "scan";

export const resolveScanGitRepositoryContext = async (
	input: typeof apiCheckoutScanEnvironment._type,
) => {
	let gitUrl = "<GIT_URL>";
	let gitBranch = "<GIT_BRANCH>";
	let enableSubmodules = false;
	let imageNameSeed = "scan";

	if (input.applicationId) {
		const application = await findApplicationById(input.applicationId);
		imageNameSeed = application.appName || application.name || application.applicationId;
		enableSubmodules = application.enableSubmodules ?? false;
		switch (application.sourceType) {
			case "git":
				gitUrl = application.customGitUrl || "<GIT_URL>";
				gitBranch = application.customGitBranch || "main";
				break;
			case "github":
				gitUrl =
					(isUrlLike(application.repository) ? application.repository : undefined) ||
					(application.owner && application.repository
						? toGitUrl("github", application.owner, application.repository)
						: "<GIT_URL>");
				gitBranch = application.branch || "main";
				break;
			case "gitlab":
				gitUrl =
					(isUrlLike(application.gitlabRepository)
						? application.gitlabRepository
						: undefined) ||
					(application.gitlabOwner && application.gitlabRepository
						? toGitUrl(
								"gitlab",
								application.gitlabOwner,
								application.gitlabRepository,
							)
						: "<GIT_URL>");
				gitBranch = application.gitlabBranch || "main";
				break;
			case "bitbucket":
				gitUrl =
					(isUrlLike(application.bitbucketRepository)
						? application.bitbucketRepository
						: undefined) ||
					(application.bitbucketOwner && application.bitbucketRepository
						? toGitUrl(
								"bitbucket",
								application.bitbucketOwner,
								application.bitbucketRepository,
							)
						: "<GIT_URL>");
				gitBranch = application.bitbucketBranch || "main";
				break;
			case "gitea":
				gitUrl =
					(isUrlLike(application.giteaRepository)
						? application.giteaRepository
						: undefined) ||
					(application.giteaOwner && application.giteaRepository
						? toGitUrl(
								"gitea",
								application.giteaOwner,
								application.giteaRepository,
								application.gitea?.giteaUrl || null,
							)
						: "<GIT_URL>");
				gitBranch = application.giteaBranch || "main";
				break;
			default:
				gitUrl = "<GIT_URL>";
				gitBranch = "main";
		}
	}

	if (input.composeId) {
		const compose = await findComposeById(input.composeId);
		imageNameSeed = compose.appName || compose.name || compose.composeId;
		enableSubmodules = compose.enableSubmodules ?? false;
		switch (compose.sourceType) {
			case "git":
				gitUrl = compose.customGitUrl || "<GIT_URL>";
				gitBranch = compose.customGitBranch || "main";
				break;
			case "github":
				gitUrl =
					(isUrlLike(compose.repository) ? compose.repository : undefined) ||
					(compose.owner && compose.repository
						? toGitUrl("github", compose.owner, compose.repository)
						: "<GIT_URL>");
				gitBranch = compose.branch || "main";
				break;
			case "gitlab":
				gitUrl =
					(isUrlLike(compose.gitlabRepository) ? compose.gitlabRepository : undefined) ||
					(compose.gitlabOwner && compose.gitlabRepository
						? toGitUrl("gitlab", compose.gitlabOwner, compose.gitlabRepository)
						: "<GIT_URL>");
				gitBranch = compose.gitlabBranch || "main";
				break;
			case "bitbucket":
				gitUrl =
					(isUrlLike(compose.bitbucketRepository)
						? compose.bitbucketRepository
						: undefined) ||
					(compose.bitbucketOwner && compose.bitbucketRepository
						? toGitUrl(
								"bitbucket",
								compose.bitbucketOwner,
								compose.bitbucketRepository,
							)
						: "<GIT_URL>");
				gitBranch = compose.bitbucketBranch || "main";
				break;
			case "gitea":
				gitUrl =
					(isUrlLike(compose.giteaRepository) ? compose.giteaRepository : undefined) ||
					(compose.giteaOwner && compose.giteaRepository
						? toGitUrl(
								"gitea",
								compose.giteaOwner,
								compose.giteaRepository,
								compose.gitea?.giteaUrl || null,
							)
						: "<GIT_URL>");
				gitBranch = compose.giteaBranch || "main";
				break;
			default:
				gitUrl = "<GIT_URL>";
				gitBranch = "main";
		}
	}

	return {
		imageNameSeed,
		gitUrl,
		gitBranch,
		enableSubmodules,
	};
};

const resolveCheckoutContext = async (
	input: typeof apiCheckoutScanEnvironment._type,
) => {
	const dockerfileTemplate = buildScanDockerfileTemplate();
	const { imageNameSeed, gitUrl, gitBranch, enableSubmodules } =
		await resolveScanGitRepositoryContext(input);

	const imageTag = `vulseek-scan-${sanitizeForImageTag(imageNameSeed)}:latest`;
	return {
		imageTag,
		gitUrl,
		gitBranch,
		enableSubmodules,
		dockerfileTemplate,
	};
};

const runDockerBuildInBackground = async (task: CheckoutTask) => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dokploy-scan-checkout-"));
	const dockerfilePath = path.join(tempDir, "Dockerfile.scan");
	const args = [
		"build",
		"-f",
		dockerfilePath,
		"-t",
		task.imageTag,
		"--build-arg",
		`GIT_URL=${task.gitUrl}`,
		"--build-arg",
		`GIT_BRANCH=${task.gitBranch}`,
		"--build-arg",
		`ENABLE_SUBMODULES=${task.enableSubmodules ? "true" : "false"}`,
	];
	const containerBuildArgs = getGlobalContainerEnvironmentPairs();
	for (const pair of containerBuildArgs) {
		args.push("--build-arg", pair);
	}
	args.push(tempDir);

	try {
		await fs.writeFile(dockerfilePath, task.dockerfileTemplate, "utf-8");
		await new Promise<void>((resolve, reject) => {
			const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
			child.stdout.on("data", (chunk) => {
				const latest = checkoutTasks.get(task.checkoutId);
				if (!latest) return;
				latest.stdout = appendLog(latest.stdout, chunk.toString());
			});
			child.stderr.on("data", (chunk) => {
				const latest = checkoutTasks.get(task.checkoutId);
				if (!latest) return;
				latest.stderr = appendLog(latest.stderr, chunk.toString());
			});
			child.on("error", (error) => reject(error));
			child.on("close", (code) => {
				if (code === 0) {
					resolve();
					return;
				}
				reject(new Error(`docker build failed with code ${code}`));
			});
		});

		const latest = checkoutTasks.get(task.checkoutId);
		if (latest) {
			latest.status = "completed";
			latest.finishedAt = new Date().toISOString();
		}
	} catch (error) {
		const latest = checkoutTasks.get(task.checkoutId);
		if (latest) {
			latest.status = "failed";
			latest.errorMessage =
				error instanceof Error ? error.message : "Unknown checkout error";
			latest.finishedAt = new Date().toISOString();
		}
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
};

export const startCheckoutScanEnvironment = async (
	input: typeof apiCheckoutScanEnvironment._type,
) => {
	const context = await resolveCheckoutContext(input);
	const checkoutId = nanoid();
	const task: CheckoutTask = {
		checkoutId,
		status: "running",
		imageTag: context.imageTag,
		gitUrl: context.gitUrl,
		gitBranch: context.gitBranch,
		enableSubmodules: context.enableSubmodules,
		dockerfileTemplate: context.dockerfileTemplate,
		stdout: "",
		stderr: "",
		startedAt: new Date().toISOString(),
		applicationId: input.applicationId,
		composeId: input.composeId,
	};
	checkoutTasks.set(checkoutId, task);
	void runDockerBuildInBackground(task);
	return {
		checkoutId,
		status: task.status,
		imageTag: task.imageTag,
		gitUrl: task.gitUrl,
		gitBranch: task.gitBranch,
		enableSubmodules: task.enableSubmodules,
	};
};

export const findCheckoutStatus = async (checkoutId: string) => {
	const task = checkoutTasks.get(checkoutId);
	if (!task) {
		return null;
	}

	return {
		...task,
		dockerBuildProbe:
			task.status === "running"
				? "checkout-task-running"
				: task.status === "completed"
					? "checkout-task-completed"
					: "checkout-task-failed",
	};
};

export const findRunningCheckoutTask = async (input: {
	applicationId?: string;
	composeId?: string;
}) => {
	for (const task of checkoutTasks.values()) {
		if (task.status !== "running") continue;
		if (input.applicationId && task.applicationId === input.applicationId) {
			return task;
		}
		if (input.composeId && task.composeId === input.composeId) {
			return task;
		}
	}
	return null;
};

export const findCheckoutImageStatus = async (
	input: typeof apiCheckoutScanEnvironment._type,
) => {
	const context = await resolveCheckoutContext(input);
	try {
		await execAsync(`docker image inspect ${context.imageTag}`);
		return {
			exists: true,
			imageTag: context.imageTag,
		};
	} catch {
		return {
			exists: false,
			imageTag: context.imageTag,
		};
	}
};

const escapeSingleQuotes = (value: string) => value.replace(/'/g, `'\"'\"'`);

const buildNamespaceEnabledContainerArgs = () => {
	const configured = process.env.VULSEEK_SCAN_CONTAINER_EXTRA_ARGS?.trim();
	if (configured) {
		return configured;
	}

	return [
		"--security-opt seccomp=unconfined",
		"--security-opt apparmor=unconfined",
		"--cap-add SYS_ADMIN",
	].join(" ");
};

let cachedCurrentDockerNetworkName: string | null | undefined;

const resolveCurrentDockerNetworkName = async () => {
	if (cachedCurrentDockerNetworkName !== undefined) {
		return cachedCurrentDockerNetworkName;
	}

	try {
		const { stdout } = await execAsync(
			"docker inspect $(hostname) --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}'",
		);
		const networkName =
			stdout
				.split("\n")
				.map((value) => value.trim())
				.find((value) => value.length > 0) || null;
		cachedCurrentDockerNetworkName = networkName;
		return networkName;
	} catch {
		cachedCurrentDockerNetworkName = null;
		return null;
	}
};

const resolveCurrentDockerNetworkArg = async () => {
	const networkName = await resolveCurrentDockerNetworkName();
	return networkName ? `--network ${networkName}` : "";
};
const sanitizeContainerNamePart = (value: string) =>
	value
		.toLowerCase()
		.replace(/[^a-z0-9_.-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "") || "x";

const toImageTagFromAppName = (appName: string) =>
	`vulseek-scan-${sanitizeForImageTag(appName)}:latest`;

const sanitizeProviderName = (value: string) =>
	value.toLowerCase().replace(/[^a-z0-9_-]/g, "-") || "provider";

const buildCodexConfigToml = (agentProfile: AgentProfileLike) => {
	const providerName = sanitizeProviderName(agentProfile.agentProfileId);

	return [
		`model = "${agentProfile.model}"`,
		`model_reasoning_effort = "${agentProfile.thinkingLevel}"`,
		`model_provider = "${providerName}"`,
		`preferred_auth_method = "apikey"`,
		"",
		`[model_providers.${providerName}]`,
		`name = "${providerName}"`,
		`base_url = "${agentProfile.baseUrl}"`,
		`wire_api = "responses"`,
		"",
	].join("\n");
};

const loadCodexMcpConfigToml = async (agentsDir: string | null) => {
	if (!agentsDir) {
		return "";
	}

	const mcpDir = path.join(agentsDir, "mcp");
	try {
		const entries = await fs.readdir(mcpDir, { withFileTypes: true });
		const tomlFiles = entries
			.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".toml"))
			.map((entry) => entry.name)
			.sort((left, right) => left.localeCompare(right));

		if (tomlFiles.length === 0) {
			return "";
		}

		const contents = await Promise.all(
			tomlFiles.map((fileName) =>
				fs.readFile(path.join(mcpDir, fileName), "utf-8"),
			),
		);

		return contents
			.map((content) => content.trim())
			.filter(Boolean)
			.join("\n\n");
	} catch {
		return "";
	}
};

const joinTomlBlocks = (...blocks: Array<string | null | undefined>) =>
	blocks
		.map((block) => (block || "").trim())
		.filter(Boolean)
		.join("\n\n");

const buildCodexAuthJson = (agentProfile: AgentProfileLike) =>
	JSON.stringify(
		{
			OPENAI_API_KEY: agentProfile.apiKey,
		},
		null,
		2,
	);

const buildClaudeEnvPairs = (agentProfile: AgentProfileLike) => {
	const envPairs = [
		`ANTHROPIC_BASE_URL=${agentProfile.baseUrl}`,
		`ANTHROPIC_API_KEY=${agentProfile.apiKey}`,
		`ANTHROPIC_AUTH_TOKEN=${agentProfile.apiKey}`,
		`ANTHROPIC_MODEL=${agentProfile.model}`,
		`ANTHROPIC_DEFAULT_SONNET_MODEL=${agentProfile.model}`,
		`ANTHROPIC_DEFAULT_OPUS_MODEL=${agentProfile.model}`,
		`ANTHROPIC_DEFAULT_HAIKU_MODEL=${agentProfile.model}`,
		`CLAUDE_CODE_ENTRYPOINT=dokploy-vulseek`,
	];
	return envPairs;
};

const buildShellExports = (pairs: string[]) =>
	pairs
		.map((pair) => {
			const index = pair.indexOf("=");
			const key = index === -1 ? pair : pair.slice(0, index);
			const value = index === -1 ? "" : pair.slice(index + 1);
			return `export ${key}='${escapeSingleQuotes(value)}'`;
		})
		.join(" && ");

const resolveAgentsDirectory = async () => {
	const candidates = [
		path.resolve(process.cwd(), "agents"),
		path.resolve(process.cwd(), "../../agents"),
		"/app/agents",
		"/data/exp/dkzou/dokploy/agents",
	];

	for (const candidate of candidates) {
		try {
			const stat = await fs.stat(candidate);
			if (stat.isDirectory()) {
				return candidate;
			}
		} catch {}
	}
	return null;
};

const writeContainerFile = async (
	containerName: string,
	filePath: string,
	content: string,
) => {
	const encoded = Buffer.from(content, "utf-8").toString("base64");
	await execAsync(
		`docker exec ${containerName} bash -lc "mkdir -p '${path.posix.dirname(
			filePath,
		)}' && echo '${encoded}' | base64 -d > '${filePath}'"`,
	);
};

const getCandidateAnalysisThreadId = (candidate: VulnerabilityCandidate) =>
	candidate.analysisThreadId || "";

const getCandidateVerifierThreadId = (candidate: VulnerabilityCandidate) =>
	candidate.verifierThreadId || "";

const resolveScanExecutionContext = async (scanJob: ScanJob) => {
	const isApplicationJob = Boolean(scanJob.applicationId);
	const target = isApplicationJob
		? await findApplicationById(scanJob.applicationId as string)
		: await findComposeById(scanJob.composeId as string);
	const targetDefaultAgentProfile =
		("agentProfile" in target && target.agentProfile) ||
		null;

	const appName = target.appName;
	const imageTag = toImageTagFromAppName(appName);
	const projectName = target.environment.project.name;
	const serviceName = target.name || target.appName;
	const projectProfileContextRoot = buildProjectProfileContextRoot();
	const projectProfileCacheRoot = buildProjectProfileCacheRoot();

	const configuredHostRoot = resolveConfiguredScanContextHostPath();
	if (!configuredHostRoot) {
		throw new Error(
			"Scan context host path is not configured. Restart dokploy-dev from dev.sh so /scan-context is mounted.",
		);
	}

	try {
		await execAsync(`docker image inspect ${imageTag}`);
	} catch {
		throw new Error(
			`Checkout image not found: ${imageTag}. Run Checkout before ${scanJob.scanType} scan.`,
		);
	}

	return {
		isApplicationJob,
		target,
		appName,
		imageTag,
		contextVolumeName: target.environment.project.scanContextVolumeName,
		projectName,
		serviceName,
		projectProfileContextRoot,
		projectProfileCacheRoot,
		scanAgentProfile:
			("scanAgentProfile" in target && target.scanAgentProfile) ||
			targetDefaultAgentProfile ||
			null,
		analysisAgentProfile:
			("analysisAgentProfile" in target && target.analysisAgentProfile) ||
			targetDefaultAgentProfile ||
			null,
		verifierAgentProfile:
			("verifierAgentProfile" in target && target.verifierAgentProfile) ||
			targetDefaultAgentProfile ||
			null,
		analysisConcurrency:
			"analysisConcurrency" in target &&
			typeof target.analysisConcurrency === "number"
				? target.analysisConcurrency
				: DEFAULT_ANALYSIS_CONCURRENCY,
		verifyConcurrency:
			"verifyConcurrency" in target && typeof target.verifyConcurrency === "number"
				? target.verifyConcurrency
				: DEFAULT_VERIFY_CONCURRENCY,
		fullScanModuleConcurrency:
			("fullScanModuleConcurrency" in target &&
			typeof target.fullScanModuleConcurrency === "number"
				? target.fullScanModuleConcurrency
				: DEFAULT_FULL_SCAN_MODULE_CONCURRENCY),
		fullScanFunctionConcurrency:
			("fullScanFunctionConcurrency" in target &&
			typeof target.fullScanFunctionConcurrency === "number"
				? target.fullScanFunctionConcurrency
				: DEFAULT_FULL_SCAN_FUNCTION_CONCURRENCY),
	};
};

const copyCodexAssetsToContainerHome = async (
	containerName: string,
	codexHome: string,
	agentsDir: string | null,
	agentProfile?: AgentProfileLike | null,
) => {
	const mcpConfigToml = await loadCodexMcpConfigToml(agentsDir);

	await execAsync(
		`docker exec ${containerName} bash -lc "mkdir -p '${codexHome}/skills'"`,
	);

	if (agentsDir) {
		await execAsync(
			`docker cp "${agentsDir}/." ${containerName}:"${codexHome}/skills/"`,
		);
	}

	if (agentProfile) {
		if (agentProfile.provider === "codex") {
			await writeContainerFile(
				containerName,
				`${codexHome}/config.toml`,
				joinTomlBlocks(buildCodexConfigToml(agentProfile), mcpConfigToml),
			);
			await writeContainerFile(
				containerName,
				`${codexHome}/auth.json`,
				buildCodexAuthJson(agentProfile),
			);
		}
		return;
	}

	if (!agentsDir) {
		return;
	}

	const codexConfigPath = path.join(agentsDir, "codex-config.toml");
	try {
		const baseConfigToml = await fs.readFile(codexConfigPath, "utf-8");
		await writeContainerFile(
			containerName,
			`${codexHome}/config.toml`,
			joinTomlBlocks(baseConfigToml, mcpConfigToml),
		);
	} catch {
		if (mcpConfigToml) {
			await writeContainerFile(
				containerName,
				`${codexHome}/config.toml`,
				mcpConfigToml,
			);
		}
	}

	const codexAuthPath = path.join(agentsDir, "codex-auth.json");
	try {
		await fs.stat(codexAuthPath);
		await execAsync(
			`docker cp "${codexAuthPath}" ${containerName}:"${codexHome}/auth.json"`,
		);
	} catch {}
};

const sanitizeContextPathPart = (value: string) =>
	value
		.trim()
		.replace(/[\\/]/g, "-")
		.replace(/\s+/g, "-")
		.replace(/[^a-zA-Z0-9._-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "") || "default";

const CONTAINER_SCAN_CONTEXT_ROOT = "/scan-context";

const buildProjectProfileContextRoot = () => CONTAINER_SCAN_CONTEXT_ROOT;

const toAgentVisiblePath = (containerPath: string) => containerPath;

const buildProjectProfileCacheRoot = () =>
	path.posix.join(buildProjectProfileContextRoot(), "cache");

const buildScanJobContextRoot = (scanJobId: string) =>
	path.posix.join(buildProjectProfileContextRoot(), "jobs", scanJobId);

const buildScanCandidateResultPath = (scanJobId: string) =>
	path.posix.join(
		buildScanJobContextRoot(scanJobId),
		"scanning",
		"scan_candidates.json",
	);

const buildCandidateContextRoot = (scanJobId: string, candidateId: string) =>
	path.posix.join(buildScanJobContextRoot(scanJobId), "candidates", candidateId);

const buildCandidateAnalysisRoot = (scanJobId: string, candidateId: string) =>
	path.posix.join(buildCandidateContextRoot(scanJobId, candidateId), "analysis");

const buildCandidateVerifyRoot = (scanJobId: string, candidateId: string) =>
	path.posix.join(buildCandidateContextRoot(scanJobId, candidateId), "verify");

const buildCandidateAnalysisReportPath = (
	scanJobId: string,
	candidateId: string,
) => path.posix.join(buildCandidateAnalysisRoot(scanJobId, candidateId), "01_report.md");

const buildCandidateAnalysisResultPath = (
	scanJobId: string,
	candidateId: string,
) =>
	path.posix.join(
		buildCandidateAnalysisRoot(scanJobId, candidateId),
		"analysis_result.json",
	);

const buildCandidateVerificationArtifactPaths = (
	scanJobId: string,
	candidateId: string,
) => {
	const verifyRoot = buildCandidateVerifyRoot(scanJobId, candidateId);
	return {
		verifyRoot,
		reportPath: `${verifyRoot}/01_verify_report.md`,
		issueDraftPath: `${verifyRoot}/02_issue_draft.md`,
		pocPath: `${verifyRoot}/03_poc/poc.txt`,
		dockerfilePath: `${verifyRoot}/04_repro/Dockerfile`,
		runScriptPath: `${verifyRoot}/04_repro/run.sh`,
	};
};

const buildCandidateVerificationResultPath = (
	scanJobId: string,
	candidateId: string,
) =>
	path.posix.join(
		buildCandidateVerifyRoot(scanJobId, candidateId),
		"verification_result.json",
	);

const buildFullScanRoot = (scanJobId: string) =>
	path.posix.join(buildScanJobContextRoot(scanJobId), "scanning", "full_scan");

const buildFullScanRepositoryRoot = (scanJobId: string) =>
	path.posix.join(buildFullScanRoot(scanJobId), "repository");

const buildFullScanModulesRoot = (scanJobId: string) =>
	path.posix.join(buildFullScanRoot(scanJobId), "modules");

const buildFullScanModuleRoot = (scanJobId: string, moduleId: string) =>
	path.posix.join(
		buildFullScanModulesRoot(scanJobId),
		sanitizeContextPathPart(moduleId),
	);

const buildFullScanFunctionRoot = (
	scanJobId: string,
	moduleId: string,
	functionId: string,
) =>
	path.posix.join(
		buildFullScanModuleRoot(scanJobId, moduleId),
		"functions",
		sanitizeContextPathPart(functionId),
	);

const buildFunctionScanResultPath = (
	scanJobId: string,
	moduleId: string,
	functionId: string,
) =>
	path.posix.join(
		buildFullScanFunctionRoot(scanJobId, moduleId, functionId),
		"function_result.json",
	);

const buildMountedProjectProfileContextRoot = (
	projectName: string,
	profileName: string,
) =>
	path.join(
		buildProjectProfileContextRoot(),
		"projects",
		sanitizeContextPathPart(projectName),
		"profiles",
		sanitizeContextPathPart(profileName),
	);

const buildHostProjectProfileContextRoot = (
	hostRoot: string,
	projectName: string,
	profileName: string,
) =>
	path.join(
		hostRoot,
		"projects",
		sanitizeContextPathPart(projectName),
		"profiles",
		sanitizeContextPathPart(profileName),
	);

const resolveConfiguredScanContextHostPath = () =>
	process.env.DOKPLOY_SCAN_CONTEXT_HOST_PATH?.trim() || "";

const resolveScanContextMount = async (input: {
	contextVolumeName: string | null | undefined;
	projectName: string;
	profileName: string;
}) => {
	const configuredHostRoot = resolveConfiguredScanContextHostPath();
	if (!configuredHostRoot) {
		throw new Error(
			"Scan context host path is not configured in process env DOKPLOY_SCAN_CONTEXT_HOST_PATH",
		);
	}

	const hostProfileDir = buildHostProjectProfileContextRoot(
		configuredHostRoot,
		input.projectName,
		input.profileName,
	);
	await fs.mkdir(hostProfileDir, { recursive: true });
	return {
		mountSource: hostProfileDir,
		mountDescription: `host_path:${hostProfileDir}`,
		dockerMountArg: `-v '${escapeSingleQuotes(hostProfileDir)}':${CONTAINER_SCAN_CONTEXT_ROOT}`,
	};
};

const resolveScanRuntimeDir = (scanJobId: string) =>
	path.join(buildProjectProfileContextRoot(), "jobs", scanJobId);

const resolveScanJobScanningRuntimeDir = (scanJobId: string) =>
	path.join(resolveScanRuntimeDir(scanJobId), "scanning");

const resolveCandidateRuntimeDir = (scanJobId: string, candidateId: string) =>
	path.join(resolveScanRuntimeDir(scanJobId), "candidates", candidateId);

export const getScanJobAppServerJsonlPath = async (scanJobId: string) =>
	path.join(await resolveScanJobArtifactsDir(scanJobId), "app-server-messages.jsonl");

export const getScanJobAppServerTextPath = (scanJobId: string) =>
	path.join(resolveScanJobScanningRuntimeDir(scanJobId), "app-server-text.log");

export const getScanJobAppServerStderrPath = (scanJobId: string) =>
	path.join(resolveScanJobScanningRuntimeDir(scanJobId), "app-server-stderr.log");

export const getCandidateAnalysisAppServerJsonlPath = async (
	scanJobId: string,
	candidateId: string,
) =>
	path.join(
		await resolveCandidateArtifactsDir(scanJobId, candidateId),
		"app-server-messages.jsonl",
	);

export const getCandidateAnalysisAppServerTextPath = (
	scanJobId: string,
	candidateId: string,
) =>
	path.join(resolveCandidateRuntimeDir(scanJobId, candidateId), "app-server-text.log");

export const getCandidateAnalysisAppServerStderrPath = (
	scanJobId: string,
	candidateId: string,
) =>
	path.join(resolveCandidateRuntimeDir(scanJobId, candidateId), "app-server-stderr.log");

export const getCandidateVerifierAppServerJsonlPath = async (
	scanJobId: string,
	candidateId: string,
) =>
	path.join(
		await resolveCandidateArtifactsDir(scanJobId, candidateId),
		"verify-app-server-messages.jsonl",
	);

export const getCandidateVerifierAppServerTextPath = (
	scanJobId: string,
	candidateId: string,
) =>
	path.join(resolveCandidateRuntimeDir(scanJobId, candidateId), "verify-app-server-text.log");

export const getCandidateVerifierAppServerStderrPath = (
	scanJobId: string,
	candidateId: string,
) =>
	path.join(resolveCandidateRuntimeDir(scanJobId, candidateId), "verify-app-server-stderr.log");

export const getModuleScannerAppServerJsonlPath = async (
	scanJobId: string,
	moduleId: string,
) =>
	path.join(
		await resolveModuleArtifactsDir(scanJobId, moduleId),
		"app-server-messages.jsonl",
	);

export const getFunctionScannerAppServerJsonlPath = async (
	scanJobId: string,
	moduleId: string,
	functionId: string,
) =>
	path.join(
		await resolveFunctionArtifactsDir(scanJobId, moduleId, functionId),
		"app-server-messages.jsonl",
	);

const resolveScanJobTargetIdentity = async (scanJob: ScanJob) => {
	if (scanJob.applicationId) {
		const application = await findApplicationById(scanJob.applicationId);
		return {
			projectName: application.environment.project.name,
			profileName: application.name || application.appName,
		};
	}

	if (scanJob.composeId) {
		const compose = await findComposeById(scanJob.composeId);
		return {
			projectName: compose.environment.project.name,
			profileName: compose.name || compose.appName,
		};
	}

	throw new Error("Invalid scan job target");
};

const resolveProjectProfileHostContextRootByScanJob = async (scanJob: ScanJob) => {
	const { projectName, profileName } =
		await resolveScanJobTargetIdentity(scanJob);
	const mountedProfileDir = buildMountedProjectProfileContextRoot(
		projectName,
		profileName,
	);

	try {
		await fs.access(mountedProfileDir);
		return mountedProfileDir;
	} catch {}

	const configuredHostRoot = resolveConfiguredScanContextHostPath();
	if (!configuredHostRoot) {
		throw new Error(
			"Scan context host path is not configured in process env DOKPLOY_SCAN_CONTEXT_HOST_PATH",
		);
	}

	const hostProfileDir = buildHostProjectProfileContextRoot(
		configuredHostRoot,
		projectName,
		profileName,
	);
	await fs.mkdir(hostProfileDir, { recursive: true });
	return hostProfileDir;
};

const resolveRequiredProjectProfileHostContextRootByScanJob = async (
	scanJob: ScanJob,
) => {
	const projectProfileHostContextRoot =
		await resolveProjectProfileHostContextRootByScanJob(scanJob);
	return projectProfileHostContextRoot;
};

type ScanJobFileTreeItem = {
	id: string;
	name: string;
	type: "file" | "directory";
	children?: ScanJobFileTreeItem[];
};

const resolveScanJobArtifactsDir = async (scanJobId: string) => {
	const scanJob = await findScanJobById(scanJobId);
	const projectProfileHostContextRoot =
		await resolveRequiredProjectProfileHostContextRootByScanJob(scanJob);
	return path.join(projectProfileHostContextRoot, "jobs", scanJobId, "scanning");
};

const resolveCandidateArtifactsDir = async (
	scanJobId: string,
	candidateId: string,
) => {
	const scanJob = await findScanJobById(scanJobId);
	const projectProfileHostContextRoot =
		await resolveRequiredProjectProfileHostContextRootByScanJob(scanJob);
	return path.join(
		projectProfileHostContextRoot,
		"jobs",
		scanJobId,
		"candidates",
		candidateId,
	);
};

const resolveFullScanRootDir = async (scanJobId: string) =>
	path.join(await resolveScanJobArtifactsDir(scanJobId), "full_scan");

const resolveModuleArtifactsDir = async (
	scanJobId: string,
	moduleId: string,
) =>
	path.join(
		await resolveFullScanRootDir(scanJobId),
		"modules",
		sanitizeContextPathPart(moduleId),
	);

const resolveFunctionArtifactsDir = async (
	scanJobId: string,
	moduleId: string,
	functionId: string,
) =>
	path.join(
		await resolveModuleArtifactsDir(scanJobId, moduleId),
		"functions",
		sanitizeContextPathPart(functionId),
	);

const resolveLiveScanJobArtifactsDir = (input: {
	scanContextMount: Awaited<ReturnType<typeof resolveScanContextMount>>;
	scanJobId: string;
	projectName: string;
	profileName: string;
}) =>
	path.join(
		buildMountedProjectProfileContextRoot(input.projectName, input.profileName),
		"jobs",
		input.scanJobId,
		"scanning",
	);

const resolveLiveCandidateArtifactsDir = (input: {
	scanContextMount: Awaited<ReturnType<typeof resolveScanContextMount>>;
	scanJobId: string;
	candidateId: string;
	projectName: string;
	profileName: string;
}) =>
	path.join(
		buildMountedProjectProfileContextRoot(input.projectName, input.profileName),
		"jobs",
		input.scanJobId,
		"candidates",
		input.candidateId,
	);

const initializeRuntimeFiles = async (input: {
	runtimeDir: string;
	jsonlPath: string;
	textPath: string;
	stderrPath: string;
}) => {
	await fs.mkdir(input.runtimeDir, { recursive: true });
	await Promise.all([
		fs.writeFile(input.jsonlPath, "", "utf-8"),
		fs.writeFile(input.textPath, "", "utf-8"),
		fs.writeFile(input.stderrPath, "", "utf-8"),
	]);
};

const initializeCodexRuntimeMetadataFiles = async (input: {
	cursorPath: string;
	statePath: string;
}) => {
	await Promise.all([
		fs.writeFile(
			input.cursorPath,
			JSON.stringify(createEmptyCodexRuntimeCursorState()),
			"utf-8",
		),
		fs.writeFile(input.statePath, "{}", "utf-8"),
	]);
};

const initializeRuntimeFilesInContainer = async (input: {
	containerName: string;
	runtimeDirInContainer: string;
	jsonlFileName: string;
	textFileName: string;
	stderrFileName: string;
}) => {
	await execAsync(
		`docker exec ${input.containerName} bash -lc "mkdir -p '${input.runtimeDirInContainer}' && : > '${input.runtimeDirInContainer}/${input.jsonlFileName}' && : > '${input.runtimeDirInContainer}/${input.textFileName}' && : > '${input.runtimeDirInContainer}/${input.stderrFileName}'"`,
	);
};

const initializeCodexRuntimeMetadataFilesInContainer = async (input: {
	containerName: string;
	runtimeDirInContainer: string;
	cursorFileName: string;
	stateFileName: string;
}) => {
	await writeContainerFile(
		input.containerName,
		path.posix.join(input.runtimeDirInContainer, input.cursorFileName),
		JSON.stringify(createEmptyCodexRuntimeCursorState()),
	);
	await execAsync(
		`docker exec ${input.containerName} bash -lc "mkdir -p '${input.runtimeDirInContainer}' && : > '${input.runtimeDirInContainer}/${input.stateFileName}'"`,
	);
};

const resetScanRuntimeFiles = async (scanJobId: string) => {
	const runtimeDir = await resolveScanJobArtifactsDir(scanJobId);
	const jsonlPath = path.join(runtimeDir, "app-server-messages.jsonl");
	const textPath = path.join(runtimeDir, "app-server-text.log");
	const stderrPath = path.join(runtimeDir, "app-server-stderr.log");
	await initializeRuntimeFiles({ runtimeDir, jsonlPath, textPath, stderrPath });
};

export const resetCandidateAnalysisRuntimeFiles = async (
	scanJobId: string,
	candidateId: string,
) => {
	const runtimeDir = await resolveCandidateArtifactsDir(scanJobId, candidateId);
	await initializeRuntimeFiles({
		runtimeDir,
		jsonlPath: path.join(runtimeDir, "app-server-messages.jsonl"),
		textPath: path.join(runtimeDir, "app-server-text.log"),
		stderrPath: path.join(runtimeDir, "app-server-stderr.log"),
	});
};

export const resetCandidateVerifierRuntimeFiles = async (
	scanJobId: string,
	candidateId: string,
) => {
	const runtimeDir = await resolveCandidateArtifactsDir(scanJobId, candidateId);
	await initializeRuntimeFiles({
		runtimeDir,
		jsonlPath: path.join(runtimeDir, "verify-app-server-messages.jsonl"),
		textPath: path.join(runtimeDir, "verify-app-server-text.log"),
		stderrPath: path.join(runtimeDir, "verify-app-server-stderr.log"),
	});
};

const resolveScanJobBrowsableRoot = async (scanJobId: string) => {
	const scanJob = await findScanJobById(scanJobId);
	const projectProfileHostContextRoot =
		await resolveRequiredProjectProfileHostContextRootByScanJob(scanJob);
	return path.join(projectProfileHostContextRoot, "jobs", scanJobId);
};

const assertWithinDirectory = (rootPath: string, targetPath: string) => {
	const resolvedRoot = path.resolve(rootPath);
	const resolvedTarget = path.resolve(targetPath);
	const relativePath = path.relative(resolvedRoot, resolvedTarget);
	if (relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
		throw new TRPCError({ code: "UNAUTHORIZED", message: "File path is outside the scan job context" });
	}
};

const resolveBrowsableFilePath = (input: {
	rootPath: string;
	filePath: string;
	containerRootPath: string;
}) => {
	const normalizedInput = input.filePath.trim();
	if (!normalizedInput) {
		throw new TRPCError({ code: "BAD_REQUEST", message: "File path is required" });
	}

	if (path.isAbsolute(normalizedInput)) {
		if (
			normalizedInput === input.containerRootPath ||
			normalizedInput.startsWith(`${input.containerRootPath}/`)
		) {
			const relativePath = path.posix.relative(
				input.containerRootPath,
				normalizedInput,
			);
			return path.join(input.rootPath, relativePath);
		}
		return path.resolve(normalizedInput);
	}

	return path.join(input.rootPath, normalizedInput);
};

const buildFileTreeItems = async (dirPath: string): Promise<ScanJobFileTreeItem[]> => {
	const entries = await fs.readdir(dirPath, { withFileTypes: true });
	const sortedEntries = entries.sort((left, right) => {
		if (left.isDirectory() && !right.isDirectory()) return -1;
		if (!left.isDirectory() && right.isDirectory()) return 1;
		return left.name.localeCompare(right.name);
	});
	return await Promise.all(sortedEntries.map(async (entry) => {
		const fullPath = path.join(dirPath, entry.name);
		if (entry.isDirectory()) {
			return { id: fullPath, name: entry.name, type: "directory" as const, children: await buildFileTreeItems(fullPath) };
		}
		return { id: fullPath, name: entry.name, type: "file" as const };
	}));
};

const shouldHideScanJobBrowsableEntry = (entryName: string) => entryName === ".codex";

export const listScanJobDirectory = async (input: {
	scanJobId: string;
	directoryPath?: string;
}) => {
	const rootPath = await resolveScanJobBrowsableRoot(input.scanJobId);
	try {
		await fs.access(rootPath);
	} catch {
		return [];
	}

	const requestedDirectory = (input.directoryPath || "").trim();
	const targetDirectoryPath = requestedDirectory
		? resolveBrowsableFilePath({
				rootPath,
				filePath: requestedDirectory,
				containerRootPath: path.posix.join(buildScanJobContextRoot(input.scanJobId)),
			})
		: rootPath;

	assertWithinDirectory(rootPath, targetDirectoryPath);
	const stat = await fs.stat(targetDirectoryPath).catch(() => null);
	if (!stat || !stat.isDirectory()) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Directory not found" });
	}

	const entries = await fs.readdir(targetDirectoryPath, { withFileTypes: true });
	const visibleEntries = entries.filter(
		(entry) => !shouldHideScanJobBrowsableEntry(entry.name),
	);
	const sortedEntries = visibleEntries.sort((left, right) => {
		if (left.isDirectory() && !right.isDirectory()) return -1;
		if (!left.isDirectory() && right.isDirectory()) return 1;
		return left.name.localeCompare(right.name);
	});

	return await Promise.all(
		sortedEntries.map(async (entry) => {
			const fullPath = path.join(targetDirectoryPath, entry.name);
			if (entry.isDirectory()) {
				const children = await fs.readdir(fullPath, { withFileTypes: true }).catch(() => []);
				const hasChildren = children.some(
					(child) => !shouldHideScanJobBrowsableEntry(child.name),
				);
				return {
					id: fullPath,
					name: entry.name,
					type: "directory" as const,
					hasChildren,
				};
			}

			return {
				id: fullPath,
				name: entry.name,
				type: "file" as const,
				hasChildren: false,
			};
		}),
	);
};

export const readScanJobFileContent = async (input: { scanJobId: string; filePath: string; }) => {
	const rootPath = await resolveScanJobBrowsableRoot(input.scanJobId);
	const targetPath = resolveBrowsableFilePath({
		rootPath,
		filePath: input.filePath,
		containerRootPath: path.posix.join(buildScanJobContextRoot(input.scanJobId)),
	});
	assertWithinDirectory(rootPath, targetPath);
	const stat = await fs.stat(targetPath).catch(() => null);
	if (!stat || !stat.isFile()) {
		throw new TRPCError({ code: "NOT_FOUND", message: "File not found" });
	}
	const content = await fs.readFile(targetPath, "utf-8");
	return { path: targetPath, relativePath: path.relative(rootPath, targetPath), content };
};

export const readCandidateFilesTree = async (input: { scanJobId: string; candidateId: string; }) => {
	const rootPath = await resolveCandidateArtifactsDir(input.scanJobId, input.candidateId);
	try {
		await fs.access(rootPath);
	} catch {
		return [];
	}
	return await buildFileTreeItems(rootPath);
};

export const readCandidateFileContent = async (input: { scanJobId: string; candidateId: string; filePath: string; }) => {
	const rootPath = await resolveCandidateArtifactsDir(input.scanJobId, input.candidateId);
	const targetPath = resolveBrowsableFilePath({
		rootPath,
		filePath: input.filePath,
		containerRootPath: buildCandidateContextRoot(input.scanJobId, input.candidateId),
	});
	assertWithinDirectory(rootPath, targetPath);
	const stat = await fs.stat(targetPath).catch(() => null);
	if (!stat || !stat.isFile()) {
		throw new TRPCError({ code: "NOT_FOUND", message: "File not found" });
	}
	const content = await fs.readFile(targetPath, "utf-8");
	return { path: targetPath, relativePath: path.relative(rootPath, targetPath), content };
};

const appendScanRuntimeFile = async (filePath: string, chunk: string) => {
	if (!chunk) return;
	await fs.appendFile(filePath, chunk, "utf-8");
};

const formatJsonRpcRuntimeLine = (line: string) => {
	const trimmed = line.trim();
	if (!trimmed) {
		return "";
	}

	try {
		const parsed = JSON.parse(trimmed) as unknown;
		if (
			parsed &&
			typeof parsed === "object" &&
			"message" in parsed &&
			typeof (parsed as Record<string, unknown>).message === "object"
		) {
			return `${trimmed}\n`;
		}
		return `${JSON.stringify({
			timestamp: new Date().toISOString(),
			message: parsed,
		})}\n`;
	} catch {
		return `${trimmed}\n`;
	}
};

const formatJsonRpcRuntimeMessage = (
	message: JsonRpcMessage,
	timestamp?: string,
) =>
	`${JSON.stringify({
		timestamp: timestamp || new Date().toISOString(),
		message,
	})}\n`;

const isJsonRpcLikeMessage = (value: unknown): value is JsonRpcMessage => {
	if (!value || typeof value !== "object") {
		return false;
	}

	const record = value as Record<string, unknown>;
	return (
		typeof record.method === "string" ||
		"result" in record ||
		"error" in record
	);
};

const buildSandboxAgentTextDeltaMessage = (
	itemId: string,
	text: string,
	method:
		| "item/agentMessage/delta"
		| "item/reasoning/textDelta"
		| "item/plan/delta"
		| "item/commandExecution/outputDelta" = "item/agentMessage/delta",
): JsonRpcMessage => {
	if (method === "item/plan/delta") {
		return {
			method,
			params: {
				delta: text,
			},
		};
	}

	if (method === "item/reasoning/textDelta") {
		return {
			method,
			params: {
				itemId,
				textDelta: text,
			},
		};
	}

	if (method === "item/commandExecution/outputDelta") {
		return {
			method,
			params: {
				itemId,
				outputDelta: text,
			},
		};
	}

	return {
		method,
		params: {
			itemId,
			delta: text,
		},
	};
};

const normalizeSandboxAgentPayloadToJsonRpc = (input: {
	payload: unknown;
	fallbackItemId: string;
}): {
	messages: JsonRpcMessage[];
} => {
	if (isJsonRpcLikeMessage(input.payload)) {
		const message = input.payload;
		return {
			messages: [message],
		};
	}

	const payloadRecord = asRecord(input.payload) || {};
	const universalType = asString(payloadRecord.type) || "";
	const universalData = asRecord(payloadRecord.data);
	if (universalType) {
		switch (universalType) {
			case "turn.started":
				return {
					messages: [{ method: "turn/started", params: universalData || {} }],
				};
			case "turn.ended":
				return {
					messages: [
						{
							method: "turn/completed",
							params:
								universalData || {
								turn: "completed",
								},
						},
					],
				};
			case "item.delta": {
				const delta = asRecord(universalData?.delta) || universalData || {};
				const text = extractTextValue(delta) || "";
				if (!text) {
					return { messages: [] };
				}
				const deltaType = asString(delta.type) || "";
				const itemId =
					asString(universalData?.item_id) ||
					asString(universalData?.itemId) ||
					input.fallbackItemId;
				if (/reason/i.test(deltaType)) {
					return {
						messages: [
							buildSandboxAgentTextDeltaMessage(
								itemId,
								text,
								"item/reasoning/textDelta",
							),
						],
					};
				}
				if (/plan/i.test(deltaType)) {
					return {
						messages: [
							buildSandboxAgentTextDeltaMessage(
								itemId,
								text,
								"item/plan/delta",
							),
						],
					};
				}
				if (/tool|command/i.test(deltaType)) {
					return {
						messages: [
							buildSandboxAgentTextDeltaMessage(
								itemId,
								text,
								"item/commandExecution/outputDelta",
							),
						],
					};
				}
				return {
					messages: [buildSandboxAgentTextDeltaMessage(itemId, text)],
				};
			}
			case "item.completed": {
				const item =
					asRecord(universalData?.item) || universalData || {};
				const text = extractTextValue(item) || "";
				return {
					messages: text
						? [
								{
									method: "item/completed",
									params: {
										item: {
											id:
												asString(item.item_id) ||
												asString(item.id) ||
												input.fallbackItemId,
											type: "agentMessage",
											text,
										},
									},
								},
							]
						: [],
				};
			}
			case "error":
				return {
					messages: [
						{
							method: "error",
							params: {
								error: universalData || payloadRecord,
							},
						},
					],
				};
			default: {
				const text = extractTextValue(universalData) || "";
				if (!text) {
					return { messages: [] };
				}
				return {
					messages: [
						buildSandboxAgentTextDeltaMessage(
							input.fallbackItemId,
							text,
						),
					],
				};
			}
		}
	}

	const update =
		asRecord(payloadRecord.sessionUpdate) ||
		asRecord(payloadRecord.update) ||
		payloadRecord;
	const updateType =
		asString(update.type) || asString(update.kind) || "";

	switch (updateType) {
		case "turn_started":
		case "turn.started":
			return {
				messages: [{ method: "turn/started", params: update }],
			};
		case "turn_ended":
		case "turn_completed":
		case "turn.ended":
			return {
				messages: [{ method: "turn/completed", params: update }],
			};
		case "agent_thought_chunk":
			return {
				messages: [
					buildSandboxAgentTextDeltaMessage(
						input.fallbackItemId,
						extractTextValue(update) || "",
						"item/reasoning/textDelta",
					),
				].filter((message) => Boolean(extractTextValue(message.params))),
			};
		case "tool_call":
		case "tool_call_update": {
			const updateStatus = (asString(update.status) || "").toLowerCase();
			const toolCallErrorMessage =
				extractTurnErrorMessage(update) ||
				extractTurnErrorMessage(asRecord(update.rawOutput)) ||
				extractTurnErrorMessage(asRecord(update.content));
			if (
				updateStatus === "failed" ||
				updateStatus === "error" ||
				asBoolean(update.isError)
			) {
				return {
					messages: [
						{
							method: "error",
							params: {
								error: {
									message:
										toolCallErrorMessage ||
										`${asString(update.title) || asString(update.name) || "Tool call"} failed`,
								},
							},
						},
					],
				};
			}
			const text =
				extractTextValue(update) ||
				asString(update.title) ||
				asString(update.name) ||
				"";
			return text
				? {
						messages: [
							buildSandboxAgentTextDeltaMessage(
								input.fallbackItemId,
								text,
								"item/commandExecution/outputDelta",
							),
						],
					}
				: { messages: [] };
		}
		case "plan_chunk":
			return {
				messages: [
					buildSandboxAgentTextDeltaMessage(
						input.fallbackItemId,
						extractTextValue(update) || "",
						"item/plan/delta",
					),
				].filter((message) => Boolean(extractTextValue(message.params))),
			};
		case "error":
			return {
				messages: [
					{
						method: "error",
						params: {
							error: update,
						},
					},
				],
			};
		default: {
			const text = extractTextValue(update) || "";
			if (!text) {
				return { messages: [] };
			}
			return {
				messages: [
					buildSandboxAgentTextDeltaMessage(
						input.fallbackItemId,
						text,
					),
				],
			};
		}
	}
};

const parseJsonRpcMessageLine = (
	raw: string,
): { timestamp?: string; message: JsonRpcMessage } => {
	const parsed = JSON.parse(raw) as unknown;
	if (
		parsed &&
		typeof parsed === "object" &&
		"message" in parsed &&
		(parsed as Record<string, unknown>).message &&
		typeof (parsed as Record<string, unknown>).message === "object"
	) {
		return {
			timestamp: asString((parsed as Record<string, unknown>).timestamp),
			message: (parsed as Record<string, unknown>).message as JsonRpcMessage,
		};
	}

	return {
		message: parsed as JsonRpcMessage,
	};
};

const parseJsonRpcMessagesWithLineNumbers = (
	file: string,
): JsonRpcMessageWithLine[] =>
	file
		.split("\n")
		.map((line, index) => ({ raw: line.trim(), line: index + 1 }))
		.filter((entry) => Boolean(entry.raw))
		.map((entry) => {
			const parsed = parseJsonRpcMessageLine(entry.raw);
			return {
				line: entry.line,
				timestamp: parsed.timestamp,
				message: parsed.message,
			};
		});

const STATUS_VIEW_STREAM_MAX_MESSAGES = 160;
const STATUS_VIEW_STREAM_TAIL_MAX_BYTES = 512 * 1024;

const readJsonRpcMessagesWithLineNumbersTail = async (
	filePath: string,
	options?: {
		maxMessages?: number;
		maxBytes?: number;
	},
): Promise<JsonRpcMessageWithLine[]> => {
	const maxMessages = Math.max(1, options?.maxMessages ?? STATUS_VIEW_STREAM_MAX_MESSAGES);
	const maxBytes = Math.max(4096, options?.maxBytes ?? STATUS_VIEW_STREAM_TAIL_MAX_BYTES);

	try {
		const stat = await fs.stat(filePath);
		const readFrom = Math.max(0, stat.size - maxBytes);
		const handle = await fs.open(filePath, "r");
		try {
			const length = stat.size - readFrom;
			if (length <= 0) {
				return [];
			}

			const buffer = Buffer.alloc(length);
			await handle.read(buffer, 0, length, readFrom);
			let content = buffer.toString("utf-8");
			if (readFrom > 0) {
				const firstNewlineIndex = content.indexOf("\n");
				content =
					firstNewlineIndex >= 0 ? content.slice(firstNewlineIndex + 1) : "";
			}

			return parseJsonRpcMessagesWithLineNumbers(content).slice(-maxMessages);
		} finally {
			await handle.close();
		}
	} catch {
		return [];
	}
};

type CodexRuntimeArtifacts = {
	jsonlPath: string;
	textPath: string;
	stderrPath: string;
	cursorPath: string;
	statePath: string;
	jsonlFileName: string;
	textFileName: string;
	stderrFileName: string;
	cursorFileName: string;
	stateFileName: string;
};

type CodexRuntimeCursorState = {
	offset: number;
	line: number;
	agentMessageBuffers: Record<string, string>;
};

const createCodexRuntimeArtifacts = (input: {
	runtimeDir: string;
	jsonlFileName: string;
	textFileName: string;
	stderrFileName: string;
}) => {
	const runtimeBase = input.jsonlFileName.replace(/\.jsonl$/i, "");
	return {
		jsonlPath: path.join(input.runtimeDir, input.jsonlFileName),
		textPath: path.join(input.runtimeDir, input.textFileName),
		stderrPath: path.join(input.runtimeDir, input.stderrFileName),
		cursorPath: path.join(input.runtimeDir, `.${runtimeBase}-cursor.json`),
		statePath: path.join(input.runtimeDir, `.${runtimeBase}-state.json`),
		jsonlFileName: input.jsonlFileName,
		textFileName: input.textFileName,
		stderrFileName: input.stderrFileName,
		cursorFileName: `.${runtimeBase}-cursor.json`,
		stateFileName: `.${runtimeBase}-state.json`,
	} satisfies CodexRuntimeArtifacts;
};

const createEmptyCodexRuntimeCursorState = (): CodexRuntimeCursorState => ({
	offset: 0,
	line: 0,
	agentMessageBuffers: {},
});

const readCandidateAnalysisAppServerMessagesWithLineNumbers = async (
	scanJobId: string,
	candidateId: string,
): Promise<JsonRpcMessageWithLine[]> => {
	try {
		const file = await fs.readFile(
			path.join(
				await resolveCandidateArtifactsDir(scanJobId, candidateId),
				"app-server-messages.jsonl",
			),
			"utf-8",
		);
		return parseJsonRpcMessagesWithLineNumbers(file);
	} catch {
		return [];
	}
};

const readCandidateAnalysisAppServerMessages = async (
	scanJobId: string,
	candidateId: string,
): Promise<JsonRpcMessage[]> =>
	(
		await readCandidateAnalysisAppServerMessagesWithLineNumbers(
			scanJobId,
			candidateId,
		)
	).map((entry) => entry.message);

const readCandidateVerifierAppServerMessagesWithLineNumbers = async (
	scanJobId: string,
	candidateId: string,
): Promise<JsonRpcMessageWithLine[]> => {
	try {
		const file = await fs.readFile(
			path.join(
				await resolveCandidateArtifactsDir(scanJobId, candidateId),
				"verify-app-server-messages.jsonl",
			),
			"utf-8",
		);
		return parseJsonRpcMessagesWithLineNumbers(file);
	} catch {
		return [];
	}
};

const readCandidateVerifierAppServerMessages = async (
	scanJobId: string,
	candidateId: string,
): Promise<JsonRpcMessage[]> =>
	(
		await readCandidateVerifierAppServerMessagesWithLineNumbers(
			scanJobId,
			candidateId,
		)
	).map((entry) => entry.message);

const readModuleScannerAppServerMessagesWithLineNumbers = async (
	scanJobId: string,
	moduleId: string,
): Promise<JsonRpcMessageWithLine[]> => {
	try {
		const file = await fs.readFile(
			path.join(
				await resolveModuleArtifactsDir(scanJobId, moduleId),
				"app-server-messages.jsonl",
			),
			"utf-8",
		);
		return parseJsonRpcMessagesWithLineNumbers(file);
	} catch {
		return [];
	}
};

const readFunctionScannerAppServerMessagesWithLineNumbers = async (
	scanJobId: string,
	moduleId: string,
	functionId: string,
): Promise<JsonRpcMessageWithLine[]> => {
	try {
		const file = await fs.readFile(
			path.join(
				await resolveFunctionArtifactsDir(scanJobId, moduleId, functionId),
				"app-server-messages.jsonl",
			),
			"utf-8",
		);
		return parseJsonRpcMessagesWithLineNumbers(file);
	} catch {
		return [];
	}
};

const readScanJobAppServerMessagesTailWithLineNumbers = async (
	scanJobId: string,
): Promise<JsonRpcMessageWithLine[]> =>
	readJsonRpcMessagesWithLineNumbersTail(
		path.join(
			await resolveScanJobArtifactsDir(scanJobId),
			"app-server-messages.jsonl",
		),
	);

const readCandidateAnalysisAppServerMessagesTailWithLineNumbers = async (
	scanJobId: string,
	candidateId: string,
): Promise<JsonRpcMessageWithLine[]> =>
	readJsonRpcMessagesWithLineNumbersTail(
		path.join(
			await resolveCandidateArtifactsDir(scanJobId, candidateId),
			"app-server-messages.jsonl",
		),
	);

const readCandidateVerifierAppServerMessagesTailWithLineNumbers = async (
	scanJobId: string,
	candidateId: string,
): Promise<JsonRpcMessageWithLine[]> =>
	readJsonRpcMessagesWithLineNumbersTail(
		path.join(
			await resolveCandidateArtifactsDir(scanJobId, candidateId),
			"verify-app-server-messages.jsonl",
		),
	);

const readModuleScannerAppServerMessagesTailWithLineNumbers = async (
	scanJobId: string,
	moduleId: string,
): Promise<JsonRpcMessageWithLine[]> =>
	readJsonRpcMessagesWithLineNumbersTail(
		path.join(
			await resolveModuleArtifactsDir(scanJobId, moduleId),
			"app-server-messages.jsonl",
		),
	);

const readFunctionScannerAppServerMessagesTailWithLineNumbers = async (
	scanJobId: string,
	moduleId: string,
	functionId: string,
): Promise<JsonRpcMessageWithLine[]> =>
	readJsonRpcMessagesWithLineNumbersTail(
		path.join(
			await resolveFunctionArtifactsDir(scanJobId, moduleId, functionId),
			"app-server-messages.jsonl",
		),
	);

export const readScanJobAppServerText = async (scanJobId: string) => {
	try {
		return await fs.readFile(path.join(await resolveScanJobArtifactsDir(scanJobId), "app-server-text.log"), "utf-8");
	} catch {
		return "";
	}
};

export const readCandidateAnalysisAppServerText = async (
	scanJobId: string,
	candidateId: string,
) => {
	try {
		return await fs.readFile(
			path.join(await resolveCandidateArtifactsDir(scanJobId, candidateId), "app-server-text.log"),
			"utf-8",
		);
	} catch {
		return "";
	}
};

export const readCandidateVerifierAppServerText = async (
	scanJobId: string,
	candidateId: string,
) => {
	try {
		return await fs.readFile(
			path.join(await resolveCandidateArtifactsDir(scanJobId, candidateId), "verify-app-server-text.log"),
			"utf-8",
		);
	} catch {
		return "";
	}
};

export const readModuleScannerAppServerText = async (
	scanJobId: string,
	moduleId: string,
) => {
	try {
		return await fs.readFile(
			path.join(
				await resolveModuleArtifactsDir(scanJobId, moduleId),
				"app-server-text.log",
			),
			"utf-8",
		);
	} catch {
		return "";
	}
};

export const readFunctionScannerAppServerText = async (
	scanJobId: string,
	moduleId: string,
	functionId: string,
) => {
	try {
		return await fs.readFile(
			path.join(
				await resolveFunctionArtifactsDir(scanJobId, moduleId, functionId),
				"app-server-text.log",
			),
			"utf-8",
		);
	} catch {
		return "";
	}
};

const asRecord = (value: unknown) =>
	value && typeof value === "object"
		? (value as Record<string, unknown>)
		: undefined;

const asString = (value: unknown) =>
	typeof value === "string" && value ? value : undefined;

const asArray = (value: unknown) => (Array.isArray(value) ? value : []);

const asBoolean = (value: unknown) => {
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value === "string") {
		if (value === "true") {
			return true;
		}
		if (value === "false") {
			return false;
		}
	}
	return undefined;
};

const asNumber = (value: unknown) =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

const formatActionText = (value: string | undefined, fallback = "-") => {
	if (!value) {
		return fallback;
	}

	const trimmed = value.trim();
	return trimmed || fallback;
};

const deriveActionFromItem = (
	item: Record<string, unknown>,
	itemTextById: Map<string, string>,
): ScanRuntimeLiveAction | null => {
	const itemId = asString(item.id);
	const itemType = asString(item.type);
	if (!itemId || !itemType) {
		return null;
	}

	if (itemType === "commandExecution") {
		const command = asString(item.command);
		const cwd = asString(item.cwd);
		return {
			itemId,
			itemType,
			actionType: "command executing",
			actionText: formatActionText(
				command ? `${command}${cwd ? ` [cwd: ${cwd}]` : ""}` : cwd,
			),
		};
	}

	if (itemType === "reasoning") {
		const content = itemTextById.get(itemId);
		return {
			itemId,
			itemType,
			actionType: "reasoning",
			actionText: formatActionText(content, "Reasoning"),
		};
	}

	if (itemType === "fileChange") {
		const content = itemTextById.get(itemId);
		return {
			itemId,
			itemType,
			actionType: "other",
			actionText: formatActionText(content, "Applying file changes"),
		};
	}

	if (itemType === "mcpToolCall") {
		const server = asString(item.server) || "mcp";
		const tool = asString(item.tool) || "tool";
		return {
			itemId,
			itemType,
			actionType: "other",
			actionText: `${server}:${tool}`,
		};
	}

	if (itemType === "dynamicToolCall") {
		const tool = asString(item.tool) || "tool";
		return {
			itemId,
			itemType,
			actionType: "other",
			actionText: tool,
		};
	}

	if (itemType === "collabAgentToolCall") {
		const tool = asString(item.tool) || "collab";
		const prompt = asString(item.prompt);
		return {
			itemId,
			itemType,
			actionType: "other",
			actionText: formatActionText(
				prompt ? `${tool}: ${prompt}` : tool,
				tool,
			),
		};
	}

	return null;
};

const deriveScanRuntimeLiveAction = async (
	scanJobId: string,
): Promise<ScanRuntimeLiveAction | null> => {
	const messages = await readScanJobAppServerMessages(scanJobId);
	if (messages.length === 0) {
		return null;
	}

	const activeItems = new Map<string, Record<string, unknown>>();
	const itemTextById = new Map<string, string>();

	for (const message of messages) {
		const params = asRecord(message.params) || {};

		if (message.method === "item/started" || message.method === "item/completed") {
			const item = asRecord(params.item);
			const itemId = asString(item?.id);
			if (!item || !itemId) {
				continue;
			}

			if (message.method === "item/started") {
				activeItems.set(itemId, item);
			} else {
				activeItems.delete(itemId);
			}
			continue;
		}

		if (message.method === "item/reasoning/textDelta") {
			const itemId = asString(params.itemId);
			const delta = asString(params.delta);
			if (itemId && delta) {
				itemTextById.set(itemId, `${itemTextById.get(itemId) || ""}${delta}`);
			}
			continue;
		}

		if (message.method === "item/commandExecution/outputDelta") {
			const itemId = asString(params.itemId);
			const delta = asString(params.delta);
			if (itemId && delta) {
				itemTextById.set(itemId, `${itemTextById.get(itemId) || ""}${delta}`);
			}
			continue;
		}

		if (message.method === "item/fileChange/outputDelta") {
			const itemId = asString(params.itemId);
			const delta = asString(params.delta);
			if (itemId && delta) {
				itemTextById.set(itemId, `${itemTextById.get(itemId) || ""}${delta}`);
			}
			continue;
		}

		if (message.method === "item/commandExecution/terminalInteraction") {
			const itemId = asString(params.itemId);
			const stdin = asString(params.stdin);
			if (itemId && stdin) {
				itemTextById.set(
					itemId,
					formatActionText(`terminal input: ${stdin}`, "terminal input"),
				);
			}
		}
	}

	const activeActions = Array.from(activeItems.values())
		.map((item) => deriveActionFromItem(item, itemTextById))
		.filter(Boolean) as ScanRuntimeLiveAction[];

	return activeActions.at(-1) || null;
};

const deriveRuntimeLiveActionFromMessages = async (
	messages: JsonRpcMessage[],
): Promise<ScanRuntimeLiveAction | null> => {
	if (messages.length === 0) {
		return null;
	}

	const activeItems = new Map<string, Record<string, unknown>>();
	const itemTextById = new Map<string, string>();

	for (const message of messages) {
		const params = asRecord(message.params) || {};

		if (message.method === "item/started" || message.method === "item/completed") {
			const item = asRecord(params.item);
			const itemId = asString(item?.id);
			if (!item || !itemId) {
				continue;
			}

			if (message.method === "item/started") {
				activeItems.set(itemId, item);
			} else {
				activeItems.delete(itemId);
			}
			continue;
		}

		if (
			message.method === "item/reasoning/textDelta" ||
			message.method === "item/commandExecution/outputDelta" ||
			message.method === "item/fileChange/outputDelta"
		) {
			const itemId = asString(params.itemId);
			const delta = asString(params.delta);
			if (itemId && delta) {
				itemTextById.set(itemId, `${itemTextById.get(itemId) || ""}${delta}`);
			}
			continue;
		}

		if (message.method === "item/commandExecution/terminalInteraction") {
			const itemId = asString(params.itemId);
			const stdin = asString(params.stdin);
			if (itemId && stdin) {
				itemTextById.set(
					itemId,
					formatActionText(`terminal input: ${stdin}`, "terminal input"),
				);
			}
		}
	}

	const activeActions = Array.from(activeItems.values())
		.map((item) => deriveActionFromItem(item, itemTextById))
		.filter(Boolean) as ScanRuntimeLiveAction[];

	return activeActions.at(-1) || null;
};

const deriveCandidateAnalysisRuntimeLiveAction = async (
	scanJobId: string,
	candidateId: string,
): Promise<ScanRuntimeLiveAction | null> => {
	const messages = await readCandidateAnalysisAppServerMessages(scanJobId, candidateId);
	return deriveRuntimeLiveActionFromMessages(messages);
};

const deriveCandidateVerifierRuntimeLiveAction = async (
	scanJobId: string,
	candidateId: string,
): Promise<ScanRuntimeLiveAction | null> => {
	const messages = await readCandidateVerifierAppServerMessages(scanJobId, candidateId);
	return deriveRuntimeLiveActionFromMessages(messages);
};

export const findScanJobStatusView = async (scanJobId: string) => {
	const [scanJob, candidates, analysisResultsList, verificationResultsList, moduleTasks, functionTasks] =
		await Promise.all([
			findScanJobById(scanJobId),
			findVulnerabilityCandidatesByScanJobId(scanJobId),
			findAnalysisResultsByScanJobId(scanJobId),
			findVerificationResultsByScanJobId(scanJobId),
			findScanModuleTasksByScanJobId(scanJobId),
			findScanFunctionTasksByScanJobId(scanJobId),
		]);

	const latestAnalysisResultByCandidateId = new Map<string, AnalysisResult>();
	for (const analysisResult of analysisResultsList) {
		if (
			!latestAnalysisResultByCandidateId.has(
				analysisResult.vulnerabilityCandidateId,
			)
		) {
			latestAnalysisResultByCandidateId.set(
				analysisResult.vulnerabilityCandidateId,
				analysisResult as AnalysisResult,
			);
		}
	}

	const latestVerificationResultByCandidateId = new Map<string, VerificationResult>();
	for (const verificationResult of verificationResultsList) {
		if (
			!latestVerificationResultByCandidateId.has(
				verificationResult.vulnerabilityCandidateId,
			)
		) {
			latestVerificationResultByCandidateId.set(
				verificationResult.vulnerabilityCandidateId,
				verificationResult as VerificationResult,
			);
		}
	}

	const analysisLikelyOrConfirmedCount = candidates.filter((candidate) => {
		const latestAnalysisResult = latestAnalysisResultByCandidateId.get(
			candidate.vulnerabilityCandidateId,
		);
		return (
			latestAnalysisResult?.result === "real_vulnerability" ||
			latestAnalysisResult?.result === "likely_vulnerability"
		);
	}).length;

	const verifiedZeroDayCount = candidates.filter((candidate) => {
		const latestVerificationResult = latestVerificationResultByCandidateId.get(
			candidate.vulnerabilityCandidateId,
		);
		return latestVerificationResult?.result === "real_vulnerability";
	}).length;
	const completedCount = candidates.filter(
		(candidate) => candidate.status === "completed",
	).length;

	const inProgressCandidates = await Promise.all(
		candidates
			.filter((candidate) => candidate.status === "running")
			.map(async (candidate) => {
			const candidateStage = (candidate.currentStage ||
				"analyzing") as VulnerabilityCandidateStage;
			const candidateRuntimeLiveAction =
				candidateStage === "verifying"
					? await deriveCandidateVerifierRuntimeLiveAction(
							scanJobId,
							candidate.vulnerabilityCandidateId,
						)
					: await deriveCandidateAnalysisRuntimeLiveAction(
							scanJobId,
							candidate.vulnerabilityCandidateId,
						);
			const resolvedStage = candidate.currentStage || "analyzing";
			const resolvedActionType =
				candidateRuntimeLiveAction?.actionType || "other";
			const resolvedActionText =
				candidateRuntimeLiveAction?.actionText &&
					candidateRuntimeLiveAction.actionText !== "-"
					? candidateRuntimeLiveAction.actionText
					: "-";

			return {
				vulnerabilityCandidateId: candidate.vulnerabilityCandidateId,
				title: candidate.title,
				filePath: candidate.filePath,
				line: candidate.line,
				stage: candidate.currentStage || resolvedStage,
				actionType: resolvedActionType,
				actionText: resolvedActionText,
				streamMessages:
					candidateStage === "verifying"
						? await readCandidateVerifierAppServerMessagesTailWithLineNumbers(
								scanJobId,
								candidate.vulnerabilityCandidateId,
							)
						: await readCandidateAnalysisAppServerMessagesTailWithLineNumbers(
								scanJobId,
								candidate.vulnerabilityCandidateId,
							),
				updatedAt: candidate.updatedAt,
			};
		}),
	);

	const queuedCandidates = candidates
		.filter((candidate) => candidate.status === "queued")
		.slice(0, 10)
		.map((candidate) => ({
			vulnerabilityCandidateId: candidate.vulnerabilityCandidateId,
			title: candidate.title,
			filePath: candidate.filePath,
			line: candidate.line,
			stage: candidate.currentStage || "analyzing",
			score: candidate.score,
			createdAt: candidate.createdAt,
		}));

	const inProgressScannerAgents: Array<{
		id: string;
		title: string;
		subtitle?: string;
		stage: "repository_scanning" | "module_scanning" | "function_scanning";
		scanModuleTaskId?: string;
		scanFunctionTaskId?: string;
		moduleId?: string;
		functionId?: string;
		streamMessages: JsonRpcMessageWithLine[];
	}> = [];

	if (scanJob.repositoryTaskStatus === "running") {
		inProgressScannerAgents.push({
			id: `repository-${scanJob.scanJobId}`,
			title: "Repository Scanner",
			subtitle: "Repository-wide planner and module partitioning",
			stage: "repository_scanning",
			streamMessages:
				await readScanJobAppServerMessagesTailWithLineNumbers(scanJob.scanJobId),
		});
	}

	inProgressScannerAgents.push(
		...(
			await Promise.all(
				moduleTasks
					.filter((task) => task.status === "running")
					.map(async (task) => ({
						id: `module-${task.scanModuleTaskId}`,
						title: task.moduleName || task.moduleId,
						subtitle: task.moduleId,
						stage: "module_scanning" as const,
						scanModuleTaskId: task.scanModuleTaskId,
						moduleId: task.moduleId,
						streamMessages:
							await readModuleScannerAppServerMessagesTailWithLineNumbers(
								scanJobId,
								task.moduleId,
							),
					})),
			)
		),
	);

	inProgressScannerAgents.push(
		...(
			await Promise.all(
				functionTasks
					.filter((task) => task.status === "running")
					.map(async (task) => ({
						id: `function-${task.scanFunctionTaskId}`,
						title: task.functionName || task.functionId,
						subtitle: [
							task.moduleName || task.moduleId,
							task.filePath
								? `${task.filePath}${task.line ? `:${task.line}` : ""}`
								: null,
						]
							.filter(Boolean)
							.join(" · "),
						stage: "function_scanning" as const,
						scanModuleTaskId: task.scanModuleTaskId,
						scanFunctionTaskId: task.scanFunctionTaskId,
						moduleId: task.moduleId,
						functionId: task.functionId,
						streamMessages:
							await readFunctionScannerAppServerMessagesTailWithLineNumbers(
								scanJobId,
								task.moduleId,
								task.functionId,
							),
					})),
			)
		),
	);

	return {
		scan: {
			scanJobId: scanJob.scanJobId,
			status: scanJob.status,
			scanPhase: scanJob.scanPhase,
			repositoryTaskStatus: scanJob.repositoryTaskStatus,
		},
		summary: {
			totalCandidates: candidates.length,
			completedCandidates: completedCount,
			analysisLikelyOrConfirmedCandidates: analysisLikelyOrConfirmedCount,
			verifiedZeroDayCandidates: verifiedZeroDayCount,
			moduleTasksTotal: scanJob.moduleTasksTotal,
			moduleTasksCompleted: scanJob.moduleTasksCompleted,
			moduleTasksFailed: scanJob.moduleTasksFailed,
			functionTasksTotal: scanJob.functionTasksTotal,
			functionTasksCompleted: scanJob.functionTasksCompleted,
			functionTasksFailed: scanJob.functionTasksFailed,
		},
		inProgressScannerAgents,
		moduleTasks: moduleTasks.map((task) => ({
			scanModuleTaskId: task.scanModuleTaskId,
			moduleId: task.moduleId,
			moduleName: task.moduleName,
			status: task.status,
			priority: task.priority,
			attempt: task.attempt,
			moduleScanMdPath: task.moduleScanMdPath,
			moduleScanJsonPath: task.moduleScanJsonPath,
			functionPlanJsonPath: task.functionPlanJsonPath,
			errorMessage: task.errorMessage,
			startedAt: task.startedAt,
			completedAt: task.completedAt,
			updatedAt: task.updatedAt,
		})),
		functionTasks: functionTasks.map((task) => ({
			scanFunctionTaskId: task.scanFunctionTaskId,
			scanModuleTaskId: task.scanModuleTaskId,
			moduleId: task.moduleId,
			moduleName: task.moduleName,
			functionId: task.functionId,
			functionName: task.functionName,
			filePath: task.filePath,
			line: task.line,
			status: task.status,
			priority: task.priority,
			attempt: task.attempt,
			score: task.score,
			riskType: task.riskType,
			summary: task.summary,
			functionScanMdPath: task.functionScanMdPath,
			functionScanJsonPath: task.functionScanJsonPath,
			errorMessage: task.errorMessage,
			startedAt: task.startedAt,
			completedAt: task.completedAt,
			updatedAt: task.updatedAt,
		})),
		inProgressCandidates,
		queuedCandidates,
		recentBridgeEvents: [],
	};
};

const extractTextValue = (value: unknown): string | null => {
	if (typeof value === "string") {
		return value;
	}

	if (!value || typeof value !== "object") {
		return null;
	}

	const record = value as Record<string, unknown>;
	const preferredKeys = [
		"delta",
		"text",
		"textDelta",
		"outputDelta",
		"stdout",
		"stderr",
		"content",
	];

	for (const key of preferredKeys) {
		const nested = extractTextValue(record[key]);
		if (nested) {
			return nested;
		}
	}

	for (const nested of Object.values(record)) {
		const extracted = extractTextValue(nested);
		if (extracted) {
			return extracted;
		}
	}

	return null;
};

const renderJsonRpcMessage = (message: JsonRpcMessage) => {
	if (message.error?.message) {
		return `\n[jsonrpc error] ${message.error.message}\n`;
	}

	if (!message.method) {
		return "";
	}

	const text = extractTextValue(message.params);
	switch (message.method) {
		case "turn/started":
			return "\n[turn started]\n";
		case "turn/completed": {
			const status =
				extractTextValue((message.params as Record<string, unknown> | undefined)?.turn) ||
				extractTextValue(message.params) ||
				"completed";
			return `\n[turn ${status}]\n`;
		}
		case "item/agentMessage/delta":
		case "item/reasoning/textDelta":
		case "item/reasoning/summaryTextDelta":
		case "item/commandExecution/outputDelta":
			return text || "";
		case "item/plan/delta":
			return text ? `\n[plan] ${text}` : "";
		case "error": {
			const errorRecord = (message.params as Record<string, unknown> | undefined)
				?.error;
			const errorMessage = extractTurnErrorMessage(errorRecord) || text;
			return errorMessage ? `\n[error] ${errorMessage}\n` : "";
		}
		default:
			return "";
	}
};

const extractClaudeSessionId = (message: Record<string, unknown>) =>
	asString(message.session_id) ||
	asString(message.sessionId) ||
	asString(asRecord(message.result)?.session_id) ||
	asString(asRecord(message.result)?.sessionId) ||
	asString(asRecord(message.message)?.session_id) ||
	asString(asRecord(message.message)?.sessionId) ||
	asString(asRecord(message.data)?.session_id) ||
	asString(asRecord(message.data)?.sessionId) ||
	"";

const renderClaudeStreamJsonMessage = (message: Record<string, unknown>) => {
	const type = asString(message.type) || "";
	const subtype = asString(message.subtype) || "";
	const text =
		extractTextValue(message.delta) ||
		extractTextValue(message.message) ||
		extractTextValue(message.content) ||
		extractTextValue(message.result) ||
		extractTextValue(message);

	if (type === "system") {
		return text ? `\n[system] ${text}\n` : "";
	}

	if (type === "assistant" || type === "message") {
		return text || "";
	}

	if (type === "result") {
		const status = asString(message.stop_reason) || subtype || "completed";
		return `\n[turn ${status}]\n`;
	}

	if (type === "error") {
		const errorMessage =
			asString(asRecord(message.error)?.message) || text || "Claude turn failed";
		return `\n[error] ${errorMessage}\n`;
	}

	if (text) {
		return text;
	}

	return "";
};

type FunctionResultCandidatePayload = {
	title: string;
	description?: string;
	filePath?: string;
	line?: number;
	confidence?: number;
	score?: number;
};

type AnalysisResultPayload = {
	result: string;
	summary?: string;
	confidence?: number;
	score?: number;
};

type VerificationResultPayload = {
	result: string;
	summary?: string;
	isBug?: boolean;
	isSecurity?: boolean;
	confidence?: number;
	score?: number;
};

const normalizeAnalysisResult = (value: string | undefined) => {
	const normalized = (value || "")
		.trim()
		.toLowerCase()
		.replace(/\s+/g, "_")
		.replace(/-/g, "_");

	switch (normalized) {
		case "real_vulnerability":
			return "real_vulnerability";
		case "likely_vulnerability":
			return "likely_vulnerability";
		case "plausible_but_unproven":
		case "weak_hypothesis":
			return "plausible_but_unproven";
		case "false_positive":
			return "false_positive";
		default:
			return normalized || "plausible_but_unproven";
	}
};

const normalizeVerificationResult = (value: string | undefined) => {
	const normalized = (value || "")
		.trim()
		.toLowerCase()
		.replace(/\s+/g, "_")
		.replace(/-/g, "_");

	switch (normalized) {
		case "real_vulnerability":
			return "real_vulnerability";
		case "likely_vulnerability":
			return "likely_vulnerability";
		case "plausible_but_unproven":
		case "weak_hypothesis":
			return "plausible_but_unproven";
		case "false_positive":
			return "false_positive";
		case "api_misuse":
			return "api_misuse";
		default:
			return normalized || "plausible_but_unproven";
	}
};

const normalizeCandidatePayload = (payload: Record<string, unknown>) => ({
	title: typeof payload.title === "string" ? payload.title : "",
	description:
		typeof payload.description === "string" ? payload.description : undefined,
	filePath: typeof payload.filePath === "string" ? payload.filePath : undefined,
	line: typeof payload.line === "number" ? payload.line : undefined,
	confidence:
		typeof payload.confidence === "number" ? payload.confidence : undefined,
	score: typeof payload.score === "number" ? payload.score : undefined,
});

const parseJsonObjectFile = async (filePath: string, label: string) => {
	let raw = "";
	try {
		raw = await fs.readFile(filePath, "utf-8");
	} catch (error) {
		throw new Error(
			`${label} file not found at ${filePath}: ${error instanceof Error ? error.message : "unknown error"}`,
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(
			`${label} file contains invalid JSON at ${filePath}: ${error instanceof Error ? error.message : "unknown error"}`,
		);
	}

	const record = asRecord(parsed);
	if (!record) {
		throw new Error(`${label} file must contain a top-level JSON object`);
	}

	return record;
};

const readCandidateResultFile = async (
	filePath: string,
	label: string,
): Promise<{ candidates: FunctionResultCandidatePayload[] }> => {
	const record = await parseJsonObjectFile(filePath, label);
	const candidatesValue = record.candidates;
	if (!Array.isArray(candidatesValue)) {
		throw new Error(`${label} file must contain a candidates array`);
	}

	return {
		candidates: candidatesValue
			.filter((candidate): candidate is Record<string, unknown> =>
				Boolean(candidate && typeof candidate === "object"),
			)
			.map((candidate) => normalizeCandidatePayload(candidate))
			.filter((candidate) => Boolean(candidate.title)),
	};
};

const readAnalysisResultFile = async (
	filePath: string,
): Promise<AnalysisResultPayload> => {
	const record = await parseJsonObjectFile(filePath, "analysis result");
	const result = normalizeAnalysisResult(asString(record.result));
	if (!result) {
		throw new Error("analysis result file must contain a non-empty result field");
	}

	return {
		result,
		summary: asString(record.summary) || undefined,
		confidence: asNumber(record.confidence),
		score: asNumber(record.score),
	};
};

const readVerificationResultFile = async (
	filePath: string,
): Promise<VerificationResultPayload> => {
	const record = await parseJsonObjectFile(filePath, "verification result");
	const result = normalizeVerificationResult(asString(record.result));
	if (!result) {
		throw new Error(
			"verification result file must contain a non-empty result field",
		);
	}

	return {
		result,
		summary: asString(record.summary) || undefined,
		isBug: asBoolean(record.isBug),
		isSecurity: asBoolean(record.isSecurity),
		confidence: asNumber(record.confidence),
		score: asNumber(record.score),
	};
};

const persistFunctionResultCandidates = async (input: {
	scanJobId: string;
	candidates: FunctionResultCandidatePayload[];
}) => {
	let createdCandidates = 0;
	for (const candidate of input.candidates) {
		if (!candidate.title) continue;
		const createdCandidate = await createVulnerabilityCandidate({
			scanJobId: input.scanJobId,
			...candidate,
		});
		await enqueueCandidateAnalysisWork(
			input.scanJobId,
			createdCandidate.vulnerabilityCandidateId,
		);
		createdCandidates += 1;
	}

	return {
		receivedCandidates: input.candidates.length,
		createdCandidates,
		droppedCandidates: Math.max(0, input.candidates.length - createdCandidates),
	};
};

const persistAnalysisResultPayload = async (input: {
	scanJobId: string;
	candidateId: string;
	payload: AnalysisResultPayload;
	runtimeSeconds?: number;
	threadId?: string;
}) => {
	const candidate = await findVulnerabilityCandidateById(input.candidateId);
	const result = normalizeAnalysisResult(input.payload.result);
	const summary = input.payload.summary;
	const confidence = input.payload.confidence;
	const score = input.payload.score;

	if (input.threadId) {
		await updateVulnerabilityCandidateAnalysisThreadId(
			input.candidateId,
			input.threadId,
		);
	}

	await updateVulnerabilityCandidateCurrentStage(input.candidateId, "analyzing");
	await deleteAnalysisResultsByCandidateId(input.candidateId);
	await createAnalysisResult({
		scanJobId: input.scanJobId,
		vulnerabilityCandidateId: input.candidateId,
		result,
		confidence,
		score,
		reportPath: buildCandidateAnalysisReportPath(
			input.scanJobId,
			input.candidateId,
		),
		runtimeSeconds: input.runtimeSeconds,
		threadId: input.threadId,
		summary:
			summary ||
			(result === "real_vulnerability"
				? `Real vulnerability: ${candidate.title}`
				: result === "likely_vulnerability"
					? `Likely vulnerability: ${candidate.title}`
					: result === "false_positive"
						? `False positive: ${candidate.title}`
						: `Plausible but unproven: ${candidate.title}`),
	});
	await syncVulnerabilityCandidateResolvedRiskMetrics(input.candidateId);
	return { result };
};

const persistVerificationResultPayload = async (input: {
	scanJobId: string;
	candidateId: string;
	payload: VerificationResultPayload;
	runtimeSeconds?: number;
	threadId?: string;
}) => {
	const candidate = await findVulnerabilityCandidateById(input.candidateId);
	const result = normalizeVerificationResult(input.payload.result);

	if (input.threadId) {
		await updateVulnerabilityCandidateVerifierThreadId(
			input.candidateId,
			input.threadId,
		);
	}

	const verificationArtifactPaths = buildCandidateVerificationArtifactPaths(
		input.scanJobId,
		input.candidateId,
	);

	await updateVulnerabilityCandidateCurrentStage(input.candidateId, "verifying");
	await deleteVerificationResultsByCandidateId(input.candidateId);
	await createVerificationResult({
		scanJobId: input.scanJobId,
		vulnerabilityCandidateId: input.candidateId,
		result,
		isBug: input.payload.isBug,
		isSecurity: input.payload.isSecurity,
		confidence: input.payload.confidence,
		score: input.payload.score,
		reportPath: verificationArtifactPaths.reportPath,
		issueDraftPath: verificationArtifactPaths.issueDraftPath,
		pocPath: verificationArtifactPaths.pocPath,
		dockerfilePath: verificationArtifactPaths.dockerfilePath,
		runScriptPath: verificationArtifactPaths.runScriptPath,
		runtimeSeconds: input.runtimeSeconds,
		threadId: input.threadId,
		summary:
			input.payload.summary ||
			(result === "real_vulnerability"
				? `Verified vulnerability: ${candidate.title}`
				: result === "likely_vulnerability"
					? `Likely vulnerability after verification: ${candidate.title}`
					: result === "api_misuse"
						? `API misuse: ${candidate.title}`
						: result === "false_positive"
							? `False positive: ${candidate.title}`
							: `Plausible but unproven after verification: ${candidate.title}`),
	});
	await syncVulnerabilityCandidateResolvedRiskMetrics(input.candidateId);
	return { result };
};

const captureContainerCodexState = async (
	containerName: string,
	scanRootDir: string,
	fileName: string,
) => {
	const shellScript = [
		`set -eu`,
		`mkdir -p '${scanRootDir}'`,
		`output='${scanRootDir}/${fileName}'`,
		`{`,
		`echo '# Codex Runtime State'`,
		`echo`,
		`echo '## config.toml'`,
		"echo '```toml'",
		`if [ -f /root/.codex/config.toml ]; then cat /root/.codex/config.toml; else echo '(missing)'; fi`,
		"echo '```'",
		`echo`,
		`echo '## auth.json'`,
		"echo '```json'",
		`if [ -f /root/.codex/auth.json ]; then cat /root/.codex/auth.json; else echo '(missing)'; fi`,
		"echo '```'",
		`echo`,
		`echo '## environment'`,
		"echo '```text'",
		`env | grep -iE 'OPENAI|proxy|BASE_URL|CODEX' | sort || true`,
		"echo '```'",
		`} > "$output"`,
	].join("\n");
	const encoded = Buffer.from(shellScript, "utf-8").toString("base64");

	await execAsync(
		`docker exec ${containerName} bash -lc "echo '${encoded}' | base64 -d | bash"`,
	);
};

type PreparedRepositoryState = {
	effectiveTargetMode: string;
	targetRef: string | null;
	targetTag: string | null;
	requestedCommitSha: string | null;
	requestedBaseSha: string | null;
	commitWindow: number;
	resolvedTargetSha: string;
	resolvedBaseSha: string | null;
	currentBranch: string | null;
	currentExactTag: string | null;
	markdown: string;
};

type LegacyFullScanModulePlan = {
	scanJobId?: string;
	target?: {
		tag?: string;
		commit?: string;
	};
	modules?: Array<{
		name?: string;
		artifactDir?: string;
		summary?: string;
		pathListFile?: string;
	}>;
};

type LegacyFunctionPlanTask = {
	functionId?: string;
	id?: string;
	functionName?: string;
	name?: string;
	filePath?: string;
	path?: string;
	line?: number;
	startLine?: number;
	priority?: number;
	summary?: string;
	riskType?: string;
	score?: number;
};

type LegacyFunctionPlan = {
	module?: {
		name?: string;
		moduleId?: string;
	};
	functions?: LegacyFunctionPlanTask[];
	tasks?: LegacyFunctionPlanTask[];
};

type FullScanModulePlanModule = {
	moduleId?: string;
	name?: string;
	summary?: string;
	artifactDir?: string;
	pathListFile?: string;
	priority?: number;
	files?: string[];
	paths?: string[];
};

type FullScanModulePlan = {
	modules?: FullScanModulePlanModule[];
};

const resolveExistingPath = async (candidates: string[]) => {
	for (const candidate of candidates) {
		try {
			await fs.stat(candidate);
			return candidate;
		} catch {}
	}
	return null;
};

const findLegacyFullScanModulePlanPath = async (scanRuntimeDir: string) =>
	await resolveExistingPath([
		path.join(scanRuntimeDir, "full-scan", "repository", "module_plan.json"),
		path.join(scanRuntimeDir, "full-scan", "02_module_plan.json"),
		path.join(scanRuntimeDir, "full_scan", "02_module_plan.json"),
	]);

const findLegacyModuleSummaryPath = async (artifactDir: string) =>
	await resolveExistingPath([
		path.join(artifactDir, "module_scan.md"),
		path.join(artifactDir, "01_module_summary.md"),
		path.join(artifactDir, "02_candidate_drafts.md"),
	]);

const findLegacyModuleJsonPath = async (artifactDir: string) =>
	await resolveExistingPath([
		path.join(artifactDir, "module_scan.json"),
		path.join(artifactDir, "02_candidate_drafts.json"),
	]);

const findLegacyFunctionPlanPath = async (artifactDir: string) =>
	await resolveExistingPath([
		path.join(artifactDir, "function_plan.json"),
		path.join(artifactDir, "02_function_plan.json"),
	]);

const deriveFunctionTaskId = (input: {
	moduleId: string;
	functionId?: string;
	functionName?: string;
	filePath?: string;
	line?: number;
}) => {
	const explicit = (input.functionId || "").trim();
	if (explicit) {
		return explicit;
	}
	const base = [
		input.moduleId,
		(input.functionName || "").trim(),
		(input.filePath || "").trim(),
		typeof input.line === "number" ? String(input.line) : "",
	]
		.filter(Boolean)
		.join(":");
	return sanitizeContainerNamePart(base) || nanoid();
};

const syncFunctionTasksFromPlanFile = async (input: {
	scanJob: ScanJob;
	scanModuleTask: ScanModuleTask;
	functionPlanPath: string;
}) => {
	let parsed: LegacyFunctionPlan | LegacyFunctionPlanTask[] | null = null;
	try {
		parsed = JSON.parse(await fs.readFile(input.functionPlanPath, "utf-8"));
	} catch {
		return;
	}

	const tasks = Array.isArray(parsed)
		? parsed
		: Array.isArray(parsed?.functions)
			? parsed.functions
			: Array.isArray(parsed?.tasks)
				? parsed.tasks
				: [];

	for (const task of tasks) {
		const functionName = (task.functionName || task.name || "").trim();
		const filePath = (task.filePath || task.path || "").trim() || null;
		const line =
			typeof task.line === "number"
				? task.line
				: typeof task.startLine === "number"
					? task.startLine
					: null;
		const functionId = deriveFunctionTaskId({
			moduleId: input.scanModuleTask.moduleId,
			functionId: task.functionId || task.id,
			functionName,
			filePath: filePath || undefined,
			line: line ?? undefined,
		});

		const existing = await db
			.select()
			.from(scanFunctionTasks)
			.where(
				and(
					eq(scanFunctionTasks.scanJobId, input.scanJob.scanJobId),
					eq(scanFunctionTasks.functionId, functionId),
				),
			)
			.limit(1)
			.then((rows) => rows[0] || null);

		const patch = {
			scanModuleTaskId: input.scanModuleTask.scanModuleTaskId,
			moduleId: input.scanModuleTask.moduleId,
			moduleName: input.scanModuleTask.moduleName,
			functionName: functionName || functionId,
			filePath: filePath || undefined,
			line: line ?? undefined,
			priority: typeof task.priority === "number" ? task.priority : 0,
			score: typeof task.score === "number" ? task.score : undefined,
			riskType: task.riskType || undefined,
			summary: task.summary || undefined,
			updatedAt: new Date().toISOString(),
		};

		if (existing) {
			await db
				.update(scanFunctionTasks)
				.set(patch)
				.where(eq(scanFunctionTasks.scanFunctionTaskId, existing.scanFunctionTaskId));
			continue;
		}

		await db.insert(scanFunctionTasks).values({
			scanJobId: input.scanJob.scanJobId,
			scanModuleTaskId: input.scanModuleTask.scanModuleTaskId,
			moduleId: input.scanModuleTask.moduleId,
			moduleName: input.scanModuleTask.moduleName,
			functionId,
			functionName: functionName || functionId,
			filePath: filePath || undefined,
			line: line ?? undefined,
			status: "queued",
			priority: typeof task.priority === "number" ? task.priority : 0,
			attempt: 0,
			score: typeof task.score === "number" ? task.score : undefined,
			riskType: task.riskType || undefined,
			summary: task.summary || undefined,
			functionScanJsonPath: undefined,
			functionScanMdPath: undefined,
			updatedAt: new Date().toISOString(),
		});
	}
};

const readFullScanModulePlan = async (modulePlanPath: string) => {
	const parsed = JSON.parse(
		await fs.readFile(modulePlanPath, "utf-8"),
	) as FullScanModulePlan | FullScanModulePlanModule[];
	if (Array.isArray(parsed)) {
		return parsed;
	}
	return Array.isArray(parsed.modules) ? parsed.modules : [];
};

const writeModulePathListIfNeeded = async (input: {
	scanJob: ScanJob;
	moduleId: string;
	hostArtifactDir: string;
	module: FullScanModulePlanModule;
}) => {
	const listedPath =
		typeof input.module.pathListFile === "string"
			? input.module.pathListFile.trim()
			: "";
	if (listedPath) {
		return await resolveLegacyArtifactHostPath(input.scanJob, listedPath);
	}

	const fileValues = Array.isArray(input.module.files)
		? input.module.files
		: Array.isArray(input.module.paths)
			? input.module.paths
			: [];
	const normalized = fileValues
		.map((value) => (typeof value === "string" ? value.trim() : ""))
		.filter(Boolean);
	if (normalized.length === 0) {
		return "";
	}

	const hostPath = path.join(input.hostArtifactDir, "file_list.txt");
	await fs.mkdir(input.hostArtifactDir, { recursive: true });
	await fs.writeFile(hostPath, `${normalized.join("\n")}\n`, "utf-8");
	return hostPath;
};

const syncScanModuleTasksFromPlanFile = async (input: {
	scanJob: ScanJob;
	modulePlanPath: string;
}) => {
	const modules = await readFullScanModulePlan(input.modulePlanPath);

	for (const moduleEntry of modules) {
		const moduleName = (moduleEntry.name || "").trim();
		if (!moduleName) {
			continue;
		}

		const moduleId =
			sanitizeContainerNamePart(
				(moduleEntry.moduleId || "").trim() || moduleName,
			) || nanoid();
		const containerArtifactDir =
			(moduleEntry.artifactDir || "").trim() ||
			buildFullScanModuleRoot(input.scanJob.scanJobId, moduleId);
		const hostArtifactDir = await resolveLegacyArtifactHostPath(
			input.scanJob,
			containerArtifactDir,
		);
		await fs.mkdir(hostArtifactDir, { recursive: true });
		const pathListHostPath = await writeModulePathListIfNeeded({
			scanJob: input.scanJob,
			moduleId,
			hostArtifactDir,
			module: moduleEntry,
		});
		const functionPlanPath = path.join(hostArtifactDir, "function_plan.json");
		const existing = await db
			.select()
			.from(scanModuleTasks)
			.where(
				and(
					eq(scanModuleTasks.scanJobId, input.scanJob.scanJobId),
					eq(scanModuleTasks.moduleId, moduleId),
				),
			)
			.limit(1)
			.then((rows) => rows[0] || null);

		const patch = {
			moduleName,
			priority: typeof moduleEntry.priority === "number" ? moduleEntry.priority : 0,
			moduleScanMdPath: path.join(hostArtifactDir, "module_scan.md"),
			moduleScanJsonPath: path.join(hostArtifactDir, "module_scan.json"),
			functionPlanJsonPath: functionPlanPath,
			errorMessage: undefined,
			updatedAt: new Date().toISOString(),
		};

		if (existing) {
			await db
				.update(scanModuleTasks)
				.set({
					...patch,
				})
				.where(eq(scanModuleTasks.scanModuleTaskId, existing.scanModuleTaskId));
			continue;
		}

		const created = await createScanModuleTask({
			scanJobId: input.scanJob.scanJobId,
			moduleId,
			moduleName,
			priority:
				typeof moduleEntry.priority === "number" ? moduleEntry.priority : 0,
			moduleScanMdPath: patch.moduleScanMdPath,
			moduleScanJsonPath: patch.moduleScanJsonPath,
			functionPlanJsonPath: patch.functionPlanJsonPath,
		});

		if (pathListHostPath) {
			await fs.writeFile(
				path.join(hostArtifactDir, "00_module_seed.txt"),
				[
					`module_id=${moduleId}`,
					`module_name=${moduleName}`,
					`path_list=${pathListHostPath}`,
				].join("\n"),
				"utf-8",
			).catch(() => {});
		}
	}

	await recalculateScanTaskCounts(input.scanJob.scanJobId);
	return await findScanModuleTasksByScanJobId(input.scanJob.scanJobId);
};

const syncLegacyFullScanTasksFromArtifacts = async (input: {
	scanJob: ScanJob;
	scanRuntimeDir: string;
}) => {
	if (input.scanJob.scanType !== "full") {
		return;
	}

	const modulePlanPath = await findLegacyFullScanModulePlanPath(input.scanRuntimeDir);
	if (!modulePlanPath) {
		return;
	}

	let parsed: LegacyFullScanModulePlan | null = null;
	try {
		parsed = JSON.parse(await fs.readFile(modulePlanPath, "utf-8"));
	} catch {
		return;
	}

	const modules = Array.isArray(parsed?.modules) ? parsed.modules : [];
	if (modules.length === 0) {
		await updateScanJobRepositoryTaskStatus(input.scanJob.scanJobId, "completed").catch(
			() => {},
		);
		await recalculateScanTaskCounts(input.scanJob.scanJobId).catch(() => {});
		return;
	}

	await updateScanJobRepositoryTaskStatus(input.scanJob.scanJobId, "completed").catch(
		() => {},
	);

	for (const moduleEntry of modules) {
		const moduleName = (moduleEntry.name || "").trim();
		if (!moduleName) {
			continue;
		}

		const artifactDir = moduleEntry.artifactDir?.trim() || "";
		const moduleId = sanitizeContainerNamePart(moduleName) || moduleName;
		const hostArtifactDir = artifactDir
			? await resolveLegacyArtifactHostPath(input.scanJob, artifactDir)
			: "";
		let functionPlanJsonPath = hostArtifactDir
			? await findLegacyFunctionPlanPath(hostArtifactDir)
			: null;
		const moduleScanMdPath = hostArtifactDir
			? await findLegacyModuleSummaryPath(hostArtifactDir)
			: null;
		const moduleScanJsonPath = hostArtifactDir
			? await findLegacyModuleJsonPath(hostArtifactDir)
			: null;

		const existing = await db
			.select()
			.from(scanModuleTasks)
			.where(
				and(
					eq(scanModuleTasks.scanJobId, input.scanJob.scanJobId),
					eq(scanModuleTasks.moduleId, moduleId),
				),
			)
			.limit(1)
			.then((rows) => rows[0] || null);

		const patch = {
			moduleName,
			status: "completed" as const,
			moduleScanMdPath: moduleScanMdPath || undefined,
			moduleScanJsonPath: moduleScanJsonPath || undefined,
			functionPlanJsonPath: functionPlanJsonPath || undefined,
			startedAt: input.scanJob.startedAt || input.scanJob.createdAt,
			completedAt: input.scanJob.finishedAt || new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};

		if (existing) {
			await db
				.update(scanModuleTasks)
				.set(patch)
				.where(eq(scanModuleTasks.scanModuleTaskId, existing.scanModuleTaskId));
		} else {
			await db.insert(scanModuleTasks).values({
				scanJobId: input.scanJob.scanJobId,
				moduleId,
				moduleName,
				status: "completed",
				priority: 0,
				attempt: 1,
				moduleScanMdPath: moduleScanMdPath || undefined,
				moduleScanJsonPath: moduleScanJsonPath || undefined,
				functionPlanJsonPath: functionPlanJsonPath || undefined,
				startedAt: input.scanJob.startedAt || input.scanJob.createdAt,
				completedAt: input.scanJob.finishedAt || new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			});
		}

		const moduleTask = await db
			.select()
			.from(scanModuleTasks)
			.where(
				and(
					eq(scanModuleTasks.scanJobId, input.scanJob.scanJobId),
					eq(scanModuleTasks.moduleId, moduleId),
				),
			)
			.limit(1)
			.then((rows) => rows[0] || null);

		if (moduleTask && hostArtifactDir && !functionPlanJsonPath) {
			const fileListPath = path.join(hostArtifactDir, "file_list.txt");
			try {
				await fs.stat(fileListPath);
				functionPlanJsonPath =
					await generateFunctionPlanForModuleTaskInContainer({
						scanJob: input.scanJob,
						scanModuleTask: moduleTask,
						hostArtifactDir,
					});
				await db
					.update(scanModuleTasks)
					.set({
						functionPlanJsonPath,
						updatedAt: new Date().toISOString(),
					})
					.where(
						eq(scanModuleTasks.scanModuleTaskId, moduleTask.scanModuleTaskId),
					);
			} catch (error) {
				console.error(
					"Failed to generate function plan for module task",
					moduleTask.scanModuleTaskId,
					error,
				);
			}
		}

		if (moduleTask && functionPlanJsonPath) {
			await syncFunctionTasksFromPlanFile({
				scanJob: input.scanJob,
				scanModuleTask: moduleTask,
				functionPlanPath: functionPlanJsonPath,
			});
		}
	}

	await recalculateScanTaskCounts(input.scanJob.scanJobId).catch(() => {});
};

export const syncFullScanTasksFromArtifacts = async (scanJobId: string) => {
	const scanJob = await findScanJobById(scanJobId);
	const scanRuntimeDir = await resolveScanJobArtifactsDir(scanJobId);
	await syncLegacyFullScanTasksFromArtifacts({
		scanJob,
		scanRuntimeDir,
	});
	return await findScanJobById(scanJobId);
};

const prepareRepositoryForScanInContainer = async (input: {
	containerName: string;
	scanJob: ScanJob;
	scanRootDir: string;
}): Promise<PreparedRepositoryState> => {
	const forceLatestRef = input.scanJob.scanType === "delta";
	const preferLatestTag = input.scanJob.scanType === "full";
	const targetRef = input.scanJob.targetRef?.trim() || "";
	const targetTag = input.scanJob.targetTag?.trim() || "";
	const requestedCommit = input.scanJob.commitSha?.trim() || "";
	const requestedBase = input.scanJob.baseSha?.trim() || "";
	const commitWindow = input.scanJob.commitWindow || DEFAULT_DELTA_COMMIT_WINDOW;
	const isDeltaScan = input.scanJob.scanType === "delta";

	const shellScript = [
		`SCAN_ROOT='${escapeSingleQuotes(input.scanRootDir)}'`,
		"mkdir -p \"$SCAN_ROOT\"",
		"PREPARE_STDOUT=\"$SCAN_ROOT/00_repository_prepare.stdout.log\"",
		"PREPARE_STDERR=\"$SCAN_ROOT/00_repository_prepare.stderr.log\"",
		": > \"$PREPARE_STDOUT\"",
		": > \"$PREPARE_STDERR\"",
		"exec > >(tee -a \"$PREPARE_STDOUT\") 2> >(tee -a \"$PREPARE_STDERR\" >&2)",
		"set -Eeuo pipefail",
		"CURRENT_CMD=\"(initializing)\"",
		"trap 'rc=$?; echo \"[error] command failed (exit ${rc}): ${CURRENT_CMD}\" >&2' ERR",
		"run() {",
		"  CURRENT_CMD=\"$*\"",
		"  echo \"[cmd] $CURRENT_CMD\"",
		"  \"$@\"",
		"}",
		"cd /workspace/repo",
		"CURRENT_BRANCH=\"$(git symbolic-ref --quiet --short HEAD || true)\"",
		"run git fetch --all --tags --prune",
		"if [ -n \"$CURRENT_BRANCH\" ]; then",
		"  CURRENT_CMD=\"git pull --ff-only origin $CURRENT_BRANCH\"",
		"  if ! git pull --ff-only origin \"$CURRENT_BRANCH\"; then",
		"    echo \"[warn] command failed but ignored: $CURRENT_CMD\" >&2",
		"  fi",
		"fi",
		`TARGET_REF='${escapeSingleQuotes(targetRef)}'`,
		`TARGET_TAG='${escapeSingleQuotes(targetTag)}'`,
		`REQUESTED_COMMIT='${escapeSingleQuotes(requestedCommit)}'`,
		`REQUESTED_BASE='${escapeSingleQuotes(requestedBase)}'`,
		`COMMIT_WINDOW='${commitWindow}'`,
		`FORCE_LATEST_REF='${forceLatestRef ? "true" : "false"}'`,
		`PREFER_LATEST_TAG='${preferLatestTag ? "true" : "false"}'`,
		"RESOLVED_TARGET=\"\"",
		"EFFECTIVE_TARGET_MODE=\"explicit\"",
		"if [ \"$FORCE_LATEST_REF\" = \"true\" ]; then",
		"  EFFECTIVE_TARGET_MODE=\"latest-ref\"",
		"  if [ -n \"$CURRENT_BRANCH\" ]; then",
		"    RESOLVED_TARGET=\"$(git rev-parse HEAD)\"",
		"    TARGET_REF=\"$CURRENT_BRANCH\"",
		"    TARGET_TAG=\"\"",
		"    REQUESTED_COMMIT=\"\"",
		"  else",
		"    RESOLVED_TARGET=\"$(git rev-parse HEAD)\"",
		"    TARGET_REF=\"HEAD\"",
		"    TARGET_TAG=\"\"",
		"    REQUESTED_COMMIT=\"\"",
		"  fi",
		"elif [ \"$PREFER_LATEST_TAG\" = \"true\" ] && [ -z \"$TARGET_TAG\" ]; then",
		"  CURRENT_CMD=\"git for-each-ref --sort=-creatordate --count=1 --format=%(refname:short) refs/tags\"",
		"  LATEST_TAG=\"$(git for-each-ref --sort=-creatordate --count=1 --format='%(refname:short)' refs/tags)\"",
		"  if [ -n \"$LATEST_TAG\" ]; then",
		"    EFFECTIVE_TARGET_MODE=\"latest-tag\"",
		"    TARGET_TAG=\"$LATEST_TAG\"",
		"    TARGET_REF=\"\"",
		"    REQUESTED_COMMIT=\"\"",
		"    CURRENT_CMD=\"git rev-parse --verify refs/tags/$TARGET_TAG^{commit}\"",
		"    git rev-parse --verify \"refs/tags/$TARGET_TAG^{commit}\" >/dev/null",
		"    run git checkout -f \"refs/tags/$TARGET_TAG\"",
		"    RESOLVED_TARGET=\"$(git rev-parse HEAD)\"",
		"  else",
		"    EFFECTIVE_TARGET_MODE=\"latest-head-no-tag\"",
		"    RESOLVED_TARGET=\"$(git rev-parse HEAD)\"",
		"  fi",
		"elif [ -n \"$TARGET_TAG\" ]; then",
		"  CURRENT_CMD=\"git rev-parse --verify refs/tags/$TARGET_TAG^{commit}\"",
		"  git rev-parse --verify \"refs/tags/$TARGET_TAG^{commit}\" >/dev/null",
		"  run git checkout -f \"refs/tags/$TARGET_TAG\"",
		"  RESOLVED_TARGET=\"$(git rev-parse HEAD)\"",
		"elif [ -n \"$TARGET_REF\" ]; then",
		"  CURRENT_CMD=\"git rev-parse --verify $TARGET_REF^{commit}\"",
		"  if git rev-parse --verify \"$TARGET_REF^{commit}\" >/dev/null 2>&1; then",
		"    run git checkout -f \"$TARGET_REF\"",
		"  else",
		"    CURRENT_CMD=\"git rev-parse --verify origin/$TARGET_REF^{commit}\"",
		"    if git rev-parse --verify \"origin/$TARGET_REF^{commit}\" >/dev/null 2>&1; then",
		"      run git checkout -f \"origin/$TARGET_REF\"",
		"    else",
		"      echo \"Unable to resolve targetRef: $TARGET_REF\" >&2",
		"      exit 1",
		"    fi",
		"  fi",
		"  RESOLVED_TARGET=\"$(git rev-parse HEAD)\"",
		"elif [ -n \"$REQUESTED_COMMIT\" ]; then",
		"  CURRENT_CMD=\"git rev-parse --verify $REQUESTED_COMMIT^{commit}\"",
		"  if git rev-parse --verify \"$REQUESTED_COMMIT^{commit}\" >/dev/null 2>&1; then",
		"    run git checkout -f \"$REQUESTED_COMMIT\"",
		"    RESOLVED_TARGET=\"$(git rev-parse HEAD)\"",
		"  else",
		"    echo \"Unable to resolve commitSha: $REQUESTED_COMMIT\" >&2",
		"    exit 1",
		"  fi",
		"else",
		"  RESOLVED_TARGET=\"$(git rev-parse HEAD)\"",
		"fi",
		"TARGET_SUBJECT=\"$(git log -1 --format=%s \"$RESOLVED_TARGET\")\"",
		"TARGET_SHORT=\"$(git rev-parse --short \"$RESOLVED_TARGET\")\"",
		"CURRENT_EXACT_TAG=\"$(git describe --tags --exact-match HEAD 2>/dev/null || true)\"",
		...(isDeltaScan
			? [
					"if [ -n \"$REQUESTED_BASE\" ] && git rev-parse --verify \"$REQUESTED_BASE^{commit}\" >/dev/null 2>&1; then",
					"  RESOLVED_BASE=\"$REQUESTED_BASE\"",
					"else",
					"  RESOLVED_BASE=\"$(git rev-parse \"$RESOLVED_TARGET~$COMMIT_WINDOW\" 2>/dev/null || true)\"",
					"fi",
				]
			: [
					"RESOLVED_BASE=\"\"",
				]),
		"{",
		"  echo '# Repository State'",
		"  echo",
		"  echo \"- effective_target_mode: ${EFFECTIVE_TARGET_MODE}\"",
		"  echo \"- target_tag: ${TARGET_TAG:-<none>}\"",
		"  echo \"- target_ref: ${TARGET_REF:-<none>}\"",
		"  echo \"- requested_commit_sha: ${REQUESTED_COMMIT:-<none>}\"",
		"  echo \"- requested_base_sha: ${REQUESTED_BASE:-<none>}\"",
		"  echo \"- resolved_target_sha: ${RESOLVED_TARGET}\"",
		"  echo \"- resolved_target_short: ${TARGET_SHORT}\"",
		"  echo \"- resolved_base_sha: ${RESOLVED_BASE:-<none>}\"",
		"  echo \"- target_subject: ${TARGET_SUBJECT}\"",
		...(isDeltaScan
			? [
					"  echo \"- commit_window: ${COMMIT_WINDOW}\"",
					"  echo",
					"  echo '## Recent Commits'",
					"  CURRENT_CMD=\"git log --oneline -n $((COMMIT_WINDOW + 1)) $RESOLVED_TARGET\"",
					"  git log --oneline -n \"$((COMMIT_WINDOW + 1))\" \"$RESOLVED_TARGET\" || true",
				]
			: []),
		"} > \"$SCAN_ROOT/00_repository_state.md\"",
		"jq -n \\",
		"  --arg effectiveTargetMode \"$EFFECTIVE_TARGET_MODE\" \\",
		"  --arg targetRef \"$TARGET_REF\" \\",
		"  --arg targetTag \"$TARGET_TAG\" \\",
		"  --arg requestedCommitSha \"$REQUESTED_COMMIT\" \\",
		"  --arg requestedBaseSha \"$REQUESTED_BASE\" \\",
		"  --arg resolvedTargetSha \"$RESOLVED_TARGET\" \\",
		"  --arg resolvedBaseSha \"$RESOLVED_BASE\" \\",
		"  --arg currentBranch \"$CURRENT_BRANCH\" \\",
		"  --arg currentExactTag \"$CURRENT_EXACT_TAG\" \\",
		"  --argjson commitWindow \"$COMMIT_WINDOW\" \\",
		"  '{",
		"    effectiveTargetMode: $effectiveTargetMode,",
		"    targetRef: (if $targetRef == \"\" then null else $targetRef end),",
		"    targetTag: (if $targetTag == \"\" then null else $targetTag end),",
		"    requestedCommitSha: (if $requestedCommitSha == \"\" then null else $requestedCommitSha end),",
		"    requestedBaseSha: (if $requestedBaseSha == \"\" then null else $requestedBaseSha end),",
		"    commitWindow: $commitWindow,",
		"    resolvedTargetSha: $resolvedTargetSha,",
		"    resolvedBaseSha: (if $resolvedBaseSha == \"\" then null else $resolvedBaseSha end),",
		"    currentBranch: (if $currentBranch == \"\" then null else $currentBranch end),",
		"    currentExactTag: (if $currentExactTag == \"\" then null else $currentExactTag end)",
		"  }' > \"$SCAN_ROOT/00_repository_state.json\"",
	].join("\n");
	const encoded = Buffer.from(shellScript, "utf-8").toString("base64");

	await execAsync(
		`docker exec ${input.containerName} bash -lc "echo '${encoded}' | base64 -d | bash"`,
	).catch(async (error) => {
		let prepareStdout = "";
		let prepareStderr = "";
		try {
			const stdoutRead = await execAsync(
				`docker exec ${input.containerName} bash -lc "cat '${input.scanRootDir}/00_repository_prepare.stdout.log' 2>/dev/null || true"`,
			);
			prepareStdout = stdoutRead.stdout.trim();
		} catch {}
		try {
			const stderrRead = await execAsync(
				`docker exec ${input.containerName} bash -lc "cat '${input.scanRootDir}/00_repository_prepare.stderr.log' 2>/dev/null || true"`,
			);
			prepareStderr = stderrRead.stdout.trim();
		} catch {}

		const message = error instanceof Error ? error.message : "Repository prepare failed";
		const tail = (value: string) =>
			value
				.split("\n")
				.slice(-40)
				.join("\n")
				.trim();
		throw new Error(
			[
				message,
				prepareStdout ? `prepare_stdout_tail:\n${tail(prepareStdout)}` : "",
				prepareStderr ? `prepare_stderr_tail:\n${tail(prepareStderr)}` : "",
			]
				.filter(Boolean)
				.join("\n\n"),
		);
	});

	const repositoryState = await execAsync(
		`docker exec ${input.containerName} bash -lc "cat '${input.scanRootDir}/00_repository_state.md'"`,
	);
	const repositoryStateJson = await execAsync(
		`docker exec ${input.containerName} bash -lc "cat '${input.scanRootDir}/00_repository_state.json'"`,
	);

	const parsed = JSON.parse(
		repositoryStateJson.stdout,
	) as Omit<PreparedRepositoryState, "markdown">;

	return {
		...parsed,
		markdown: repositoryState.stdout.trim(),
	};
};

const runParallel = async <T>(
	items: T[],
	concurrency: number,
	worker: (item: T) => Promise<void>,
) => {
	let cursor = 0;
	let failed = 0;
	const runNext = async () => {
		while (cursor < items.length) {
			const item = items[cursor++];
			if (item === undefined) {
				break;
			}
			try {
				await worker(item);
			} catch {
				failed += 1;
			}
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(concurrency, items.length) }).map(() =>
			runNext(),
		),
	);
	return { total: items.length, failed };
};

const buildRepositoryScannerPrompt = (input: {
	scanJob: ScanJob;
	repositoryRoot: string;
	modulesRoot: string;
	repositoryState: PreparedRepositoryState;
	agentProvider: string;
	thinkingLevel: string;
}) =>
	[
		"You are the repository-scanner for a full scan job.",
		"Use the installed skill named repository-scanner as your working method.",
		"Do not emit candidate or candidate_batch events.",
		"Analyze the full checked-out repository, not a recent commit window.",
		`Target ref: ${input.repositoryState.currentBranch || input.repositoryState.targetRef || "<none>"}.`,
		`Target tag: ${input.repositoryState.currentExactTag || input.repositoryState.targetTag || "<none>"}.`,
		`Target commit: ${input.repositoryState.resolvedTargetSha}.`,
		`Use ${input.agentProvider} with reasoning effort around ${input.thinkingLevel}.`,
		`Write repository markdown report to ${toAgentVisiblePath(input.repositoryRoot)}/repository_scan.md.`,
		`Write repository JSON report to ${toAgentVisiblePath(input.repositoryRoot)}/repository_scan.json.`,
		`Write module plan JSON to ${toAgentVisiblePath(input.repositoryRoot)}/module_plan.json.`,
		`Write an optional markdown module plan summary to ${toAgentVisiblePath(input.repositoryRoot)}/module_plan.md.`,
		`Create one module artifact directory under ${toAgentVisiblePath(input.modulesRoot)}/<moduleId>.`,
		"Each module entry in module_plan.json must contain: moduleId, name, summary, artifactDir, pathListFile, priority.",
		"Each module's pathListFile must point to a file_list.txt that you create inside that module artifact directory.",
		"file_list.txt should contain repository-relative source file paths, one path per line.",
		"",
		`Repository state:\n${input.repositoryState.markdown}`,
	].join("\n");

const buildModuleScannerPrompt = (input: {
	scanJob: ScanJob;
	scanModuleTask: ScanModuleTask;
	moduleRoot: string;
	repositoryRoot: string;
	pathListFileInContainer: string;
	thinkingLevel: string;
}) =>
	[
		"You are the module-scanner for one full-scan module task.",
		"Use the installed skill named module-scanner as your working method.",
		"Use the installed skill named tree-sitter for function extraction.",
		"Do not emit candidate or candidate_batch events.",
		`scan_job_id: ${input.scanJob.scanJobId}`,
		`module_id: ${input.scanModuleTask.moduleId}`,
		`module_name: ${input.scanModuleTask.moduleName}`,
		`use_reasoning_effort: ${input.thinkingLevel}`,
		`repository_scan_md: ${toAgentVisiblePath(input.repositoryRoot)}/repository_scan.md`,
		`repository_scan_json: ${toAgentVisiblePath(input.repositoryRoot)}/repository_scan.json`,
		`module_path_list: ${toAgentVisiblePath(input.pathListFileInContainer)}`,
		`write_module_scan_md_to: ${toAgentVisiblePath(input.moduleRoot)}/module_scan.md`,
		`write_module_scan_json_to: ${toAgentVisiblePath(input.moduleRoot)}/module_scan.json`,
		`write_function_plan_json_to: ${toAgentVisiblePath(input.moduleRoot)}/function_plan.json`,
		"function_plan.json must contain tasks/functions with: functionId, functionName, filePath, line, priority, summary, riskType.",
	].join("\n");

const buildFunctionScannerPrompt = (input: {
	scanJob: ScanJob;
	scanModuleTask: ScanModuleTask;
	scanFunctionTask: ScanFunctionTask;
	functionRoot: string;
	repositoryRoot: string;
	moduleRoot: string;
	thinkingLevel: string;
}) =>
	[
		"You are the function-scanner for one full-scan function task.",
		"Use the installed skill named function-scanner as your working method.",
		"Persist structured candidate output only to the required JSON result file.",
		`scan_job_id: ${input.scanJob.scanJobId}`,
		`module_id: ${input.scanModuleTask.moduleId}`,
		`module_name: ${input.scanModuleTask.moduleName}`,
		`function_id: ${input.scanFunctionTask.functionId}`,
		`function_name: ${input.scanFunctionTask.functionName}`,
		`function_file: ${input.scanFunctionTask.filePath || "-"}`,
		`function_line: ${input.scanFunctionTask.line ?? "-"}`,
		`function_summary: ${input.scanFunctionTask.summary || "-"}`,
		`function_risk_type: ${input.scanFunctionTask.riskType || "-"}`,
		`use_reasoning_effort: ${input.thinkingLevel}`,
		`repository_scan_md: ${toAgentVisiblePath(input.repositoryRoot)}/repository_scan.md`,
		`repository_scan_json: ${toAgentVisiblePath(input.repositoryRoot)}/repository_scan.json`,
		`module_scan_md: ${toAgentVisiblePath(input.moduleRoot)}/module_scan.md`,
		`module_scan_json: ${toAgentVisiblePath(input.moduleRoot)}/module_scan.json`,
		`function_plan_json: ${toAgentVisiblePath(input.moduleRoot)}/function_plan.json`,
		`write_optional_function_scan_md_to: ${toAgentVisiblePath(input.functionRoot)}/function_scan.md`,
		`write_function_result_json_to: ${toAgentVisiblePath(buildFunctionScanResultPath(input.scanJob.scanJobId, input.scanFunctionTask.moduleId, input.scanFunctionTask.functionId))}`,
		"function_result.json must contain a top-level object with a candidates array.",
		"Each candidate object may include only: title, description, filePath, line, confidence, score.",
		"Always write function_result.json, even when there are no candidates; use an empty array in that case.",
	].join("\n");

const runSingleTurnAgentInContainer = async (input: {
	scanJob: ScanJob;
	agentProfile: AgentProfileLike | null;
	containerName: string;
	codexHome: string;
	runtimeDirHost: string;
	runtimeRootInContainer: string;
	cwd: string;
	prompt: string | ((containerName: string) => Promise<string>);
	runtimeFileNames?: {
		jsonl: string;
		text: string;
		stderr: string;
	};
	setupMarkdownPathInContainer?: string;
	setupMarkdown?: string;
	onThreadId?: (threadId: string) => Promise<void>;
}) => {
	const {
		imageTag,
		contextVolumeName,
		projectName,
		serviceName,
		projectProfileContextRoot,
		projectProfileCacheRoot,
	} = await resolveScanExecutionContext(input.scanJob);
	const agentsDir = await resolveAgentsDirectory();
	const agentProvider = input.agentProfile?.provider || "codex";
	const scanContextMount = await resolveScanContextMount({
		contextVolumeName,
		projectName,
		profileName: serviceName,
	});
	const containerEnvPairs = [
		...getGlobalContainerEnvironmentPairs(),
		`VULSEEK_PROJECT_PROFILE_DIR=${projectProfileContextRoot}`,
		`VULSEEK_PROJECT_CACHE_DIR=${projectProfileCacheRoot}`,
	];
	const runtimeFileNames = input.runtimeFileNames || {
		jsonl: "app-server-messages.jsonl",
		text: "app-server-text.log",
		stderr: "app-server-stderr.log",
	};
	const containerEnvArgs = containerEnvPairs
		.map((pair) => `-e '${escapeSingleQuotes(pair)}'`)
		.join(" ");
	const namespaceEnabledContainerArgs = buildNamespaceEnabledContainerArgs();
	const jsonlPath = path.join(input.runtimeDirHost, runtimeFileNames.jsonl);
	const textPath = path.join(input.runtimeDirHost, runtimeFileNames.text);
	const stderrPath = path.join(input.runtimeDirHost, runtimeFileNames.stderr);
	const runtimeArtifacts = createCodexRuntimeArtifacts({
		runtimeDir: input.runtimeDirHost,
		jsonlFileName: runtimeFileNames.jsonl,
		textFileName: runtimeFileNames.text,
		stderrFileName: runtimeFileNames.stderr,
	});

	await initializeRuntimeFiles({
		runtimeDir: input.runtimeDirHost,
		jsonlPath,
		textPath,
		stderrPath,
	});
	await initializeCodexRuntimeMetadataFiles({
		cursorPath: runtimeArtifacts.cursorPath,
		statePath: runtimeArtifacts.statePath,
	});

	const containerNetworkArg = await resolveCurrentDockerNetworkArg();
	await execAsync(
		`docker run -d --rm --name ${input.containerName} ${containerNetworkArg} ${namespaceEnabledContainerArgs} ${scanContextMount.dockerMountArg} ${containerEnvArgs} ${imageTag} bash -lc "mkdir -p '${input.runtimeRootInContainer}' '${input.codexHome}/skills' && sleep infinity"`,
	);

	try {
		await initializeRuntimeFilesInContainer({
			containerName: input.containerName,
			runtimeDirInContainer: input.runtimeRootInContainer,
			jsonlFileName: runtimeFileNames.jsonl,
			textFileName: runtimeFileNames.text,
			stderrFileName: runtimeFileNames.stderr,
		});
		await initializeCodexRuntimeMetadataFilesInContainer({
			containerName: input.containerName,
			runtimeDirInContainer: input.runtimeRootInContainer,
			cursorFileName: runtimeArtifacts.cursorFileName,
			stateFileName: runtimeArtifacts.stateFileName,
		});
		await copyCodexAssetsToContainerHome(
			input.containerName,
			input.codexHome,
			agentsDir,
			input.agentProfile,
		);
		if (input.setupMarkdownPathInContainer && input.setupMarkdown) {
			await writeContainerFile(
				input.containerName,
				input.setupMarkdownPathInContainer,
				input.setupMarkdown,
			);
		}
		const resolvedPrompt =
			typeof input.prompt === "string"
				? input.prompt
				: await input.prompt(input.containerName);
		const sandboxRuntime = await prepareSandboxAgentRuntime({
			containerName: input.containerName,
			runtimeDirHost: input.runtimeDirHost,
			runtimeDirInContainer: input.runtimeRootInContainer,
			provider: agentProvider,
			homeDir: "/root",
			envPairs:
				agentProvider === "claude_code" && input.agentProfile
					? buildClaudeEnvPairs(input.agentProfile)
					: [`CODEX_HOME=${input.codexHome}`],
		});
		let sessionId = "";
		const result = await runSandboxAgentHeadlessTurnInContainer({
			baseUrl: sandboxRuntime.server.baseUrl,
			provider: agentProvider === "claude_code" ? "claude" : "codex",
			cwd: input.cwd,
			prompt: resolvedPrompt,
			model: input.agentProfile?.model,
			thinkingLevel: input.agentProfile?.thinkingLevel,
			jsonlPath,
			textPath,
			stderrPath,
			onSessionId: async (nextSessionId) => {
				sessionId = nextSessionId;
				await input.onThreadId?.(nextSessionId);
			},
		});
		return {
			threadId: result.sessionId || sessionId,
			jsonlPath,
			textPath,
			stderrPath,
		};
	} finally {
		await execAsync(`docker rm -f ${input.containerName}`).catch(() => {});
	}
};

const runSandboxAgentHeadlessTurnInContainer = async (input: {
	baseUrl: string;
	provider: "codex" | "claude";
	cwd: string;
	prompt: string;
	model?: string;
	thinkingLevel?: string;
	jsonlPath: string;
	textPath: string;
	stderrPath: string;
	onSessionId?: (sessionId: string) => Promise<void>;
}) => {
	const client: any = await SandboxAgent.connect({
		baseUrl: input.baseUrl,
		fetch: sandboxAgentFetch,
	} as never);

	const session: any = await client.createSession({
		agent: input.provider,
		cwd: input.cwd,
		model: input.model || undefined,
		thoughtLevel: input.thinkingLevel || undefined,
		mode: input.provider === "codex" ? "full-access" : undefined,
	} as never);

	const sessionId =
		asString(session?.agentSessionId) ||
		asString(session?.id) ||
		"";
	if (sessionId) {
		await input.onSessionId?.(sessionId);
	}

	let eventWriteChain = Promise.resolve();
	const appendRuntimeError = async (message: string) => {
		const errorMessage = {
			method: "error",
			params: {
				error: {
					message,
				},
			},
		} satisfies JsonRpcMessage;
		await appendScanRuntimeFile(
			input.jsonlPath,
			formatJsonRpcRuntimeMessage(errorMessage),
		);
		const rendered = renderJsonRpcMessage(errorMessage);
		if (rendered) {
			await appendScanRuntimeFile(input.textPath, rendered);
		}
	};

	const appendNormalizedMessages = async (
		event: SandboxAgentSessionEvent,
	) => {
		const normalized = normalizeSandboxAgentPayloadToJsonRpc({
			payload: event.payload,
			fallbackItemId:
				asString(event.sessionId) || sessionId || "sandbox-agent",
		});
		if (normalized.messages.length > 0) {
			await appendScanRuntimeFile(
				input.jsonlPath,
				normalized.messages
					.map((message) =>
						formatJsonRpcRuntimeMessage(message, event.createdAt),
					)
					.join(""),
			);
			const rendered = normalized.messages
				.map((message) => renderJsonRpcMessage(message))
				.join("");
			if (rendered) {
				await appendScanRuntimeFile(input.textPath, rendered);
			}
		}
	};

	session.onEvent((event: SandboxAgentSessionEvent) => {
		eventWriteChain = eventWriteChain
			.then(() => appendNormalizedMessages(event))
			.catch(async (error) => {
				await appendScanRuntimeFile(
					input.stderrPath,
					`[sandbox-agent-event] ${
						error instanceof Error ? error.message : "unknown error"
					}\n`,
				);
			});
	});

	session.onPermissionRequest((request: Record<string, unknown>) => {
		const permissionId =
			asString(request.id) ||
			asString(request.permissionId) ||
			asString(asRecord(request.permission)?.id);
		if (!permissionId) {
			return;
		}

		void (async () => {
			try {
				await session.respondPermission(permissionId, "always");
			} catch {
				try {
					await session.respondPermission(permissionId, "once");
				} catch (error) {
					await appendScanRuntimeFile(
						input.stderrPath,
						`[sandbox-agent-permission] ${
							error instanceof Error ? error.message : "failed to auto-approve permission"
						}\n`,
					);
				}
			}
		})();
	});

	await appendScanRuntimeFile(
		input.jsonlPath,
		formatJsonRpcRuntimeMessage({ method: "turn/started", params: {} }),
	);

	try {
		try {
			await withTimeout(
				session.prompt([
					{
						type: "text",
						text: input.prompt,
					},
				]),
				SANDBOX_AGENT_PROMPT_TIMEOUT_MS,
				() =>
					new Error(
						`sandbox-agent session.prompt timed out after ${Math.round(
							SANDBOX_AGENT_PROMPT_TIMEOUT_MS / 1000,
						)}s`,
					),
			);
		} catch (error) {
			if (isPromptPayloadSchemaError(error)) {
				await withTimeout(
					session.prompt(input.prompt),
					SANDBOX_AGENT_PROMPT_TIMEOUT_MS,
					() =>
						new Error(
							`sandbox-agent session.prompt timed out after ${Math.round(
								SANDBOX_AGENT_PROMPT_TIMEOUT_MS / 1000,
							)}s`,
						),
				);
			} else {
				throw error;
			}
		}
		await appendScanRuntimeFile(
			input.jsonlPath,
			formatJsonRpcRuntimeMessage({
				method: "turn/completed",
				params: { turn: "completed" },
			}),
		);
		await eventWriteChain;
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "sandbox-agent prompt failed";
		await eventWriteChain.catch(() => {});
		await appendRuntimeError(message);
		await appendScanRuntimeFile(input.stderrPath, `[sandbox-agent] ${message}\n`);
		throw error;
	} finally {
		try {
			await session.close?.();
		} catch {}
		try {
			await client.disconnect?.();
		} catch {}
	}

	return {
		sessionId,
	};
};

const runRepositoryScannerInContainer = async (scanJob: ScanJob) => {
	const executionContext = await resolveScanExecutionContext(scanJob);
	const scanContextMount = await resolveScanContextMount({
		contextVolumeName: executionContext.contextVolumeName,
		projectName: executionContext.projectName,
		profileName: executionContext.serviceName,
	});
	const scanRuntimeDir = resolveLiveScanJobArtifactsDir({
		scanContextMount,
		scanJobId: scanJob.scanJobId,
		projectName: executionContext.projectName,
		profileName: executionContext.serviceName,
	});
	const scanRootDir = path.posix.join(
		buildScanJobContextRoot(scanJob.scanJobId),
		"scanning",
	);
	const repositoryRoot = buildFullScanRepositoryRoot(scanJob.scanJobId);
	const repositoryRuntimeDir = scanRuntimeDir;

	await updateScanJobPhase(scanJob.scanJobId, "repository_scanning").catch(() => {});
	await updateScanJobRepositoryTaskStatus(scanJob.scanJobId, "running").catch(
		() => {},
	);

	await runSingleTurnAgentInContainer({
		scanJob,
		agentProfile: executionContext.scanAgentProfile,
		containerName: [
			sanitizeContainerNamePart(executionContext.projectName),
			sanitizeContainerNamePart(executionContext.serviceName),
			"repository-scan",
			sanitizeContainerNamePart(scanJob.scanJobId),
		].join("-"),
		codexHome: `${scanRootDir}/.codex`,
		runtimeDirHost: repositoryRuntimeDir,
		runtimeRootInContainer: scanRootDir,
		cwd: "/workspace/repo",
		prompt: async (containerName) => {
			const repositoryState = await prepareRepositoryForScanInContainer({
				containerName,
				scanJob,
				scanRootDir,
			});
			await updateScanJobTargetContext(scanJob.scanJobId, {
				targetRef: repositoryState.currentBranch || repositoryState.targetRef,
				targetTag: repositoryState.currentExactTag || repositoryState.targetTag,
				commitSha: repositoryState.resolvedTargetSha,
				baseSha: repositoryState.resolvedBaseSha,
				commitWindow: repositoryState.commitWindow,
			});
			return buildRepositoryScannerPrompt({
				scanJob,
				repositoryRoot,
				modulesRoot: buildFullScanModulesRoot(scanJob.scanJobId),
				repositoryState,
				agentProvider: executionContext.scanAgentProfile?.provider || "codex",
				thinkingLevel:
					executionContext.scanAgentProfile?.thinkingLevel || "medium",
			});
		},
		setupMarkdownPathInContainer: `${repositoryRoot}/00_setup.md`,
		setupMarkdown: [
			"# Repository Scanner Setup",
			"",
			`- scan_job_id: ${scanJob.scanJobId}`,
			`- scan_type: ${scanJob.scanType}`,
			`- agent_profile: ${executionContext.scanAgentProfile?.name || executionContext.scanAgentProfile?.agentProfileId || "default"}`,
		].join("\n"),
		onThreadId: async (threadId) => {
			await updateScanJobScanningThreadId(scanJob.scanJobId, threadId);
		},
	});

	const modulePlanHostPath = path.join(
		await resolveScanJobArtifactsDir(scanJob.scanJobId),
		"full_scan",
		"repository",
		"module_plan.json",
	);
	const moduleTasks = await syncScanModuleTasksFromPlanFile({
		scanJob,
		modulePlanPath: modulePlanHostPath,
	});
	await updateScanJobRepositoryTaskStatus(scanJob.scanJobId, "completed").catch(
		() => {},
	);
	return { moduleTasks };
};

const runModuleScannerTaskInContainer = async (scanModuleTaskId: string) => {
	const scanModuleTask = await findScanModuleTaskById(scanModuleTaskId);
	const scanJob = await findScanJobById(scanModuleTask.scanJobId);
	const executionContext = await resolveScanExecutionContext(scanJob);
	const moduleRoot = buildFullScanModuleRoot(scanJob.scanJobId, scanModuleTask.moduleId);
	const moduleRuntimeDir = path.join(
		await resolveScanJobArtifactsDir(scanJob.scanJobId),
		"full_scan",
		"modules",
		sanitizeContextPathPart(scanModuleTask.moduleId),
	);
	const pathListHostPath = path.join(moduleRuntimeDir, "file_list.txt");
	const pathListFileInContainer = await resolveHostPathToScanContextContainerPath(
		scanJob,
		pathListHostPath,
	);

	await updateScanModuleTaskStatus(scanModuleTaskId, "running");
	await updateScanJobPhase(scanJob.scanJobId, "module_scanning").catch(() => {});

	try {
		await runSingleTurnAgentInContainer({
			scanJob,
			agentProfile: executionContext.scanAgentProfile,
			containerName: [
				sanitizeContainerNamePart(executionContext.projectName),
				sanitizeContainerNamePart(executionContext.serviceName),
				"module-scan",
				sanitizeContainerNamePart(scanModuleTask.moduleId).slice(0, 24),
				nanoid(6),
			].join("-"),
			codexHome: `${moduleRoot}/.codex`,
			runtimeDirHost: moduleRuntimeDir,
			runtimeRootInContainer: moduleRoot,
			cwd: "/workspace/repo",
			prompt: buildModuleScannerPrompt({
				scanJob,
				scanModuleTask,
				moduleRoot,
				repositoryRoot: buildFullScanRepositoryRoot(scanJob.scanJobId),
				pathListFileInContainer,
				thinkingLevel: executionContext.scanAgentProfile?.thinkingLevel || "medium",
			}),
			setupMarkdownPathInContainer: `${moduleRoot}/00_setup.md`,
			setupMarkdown: [
				"# Module Scanner Setup",
				"",
				`- scan_job_id: ${scanJob.scanJobId}`,
				`- module_id: ${scanModuleTask.moduleId}`,
				`- module_name: ${scanModuleTask.moduleName}`,
			].join("\n"),
			onThreadId: async (threadId) => {
				await updateScanModuleTask(scanModuleTaskId, { threadId });
			},
		});

		const functionPlanHostPath = path.join(moduleRuntimeDir, "function_plan.json");
		const refreshedModuleTask = await updateScanModuleTask(scanModuleTaskId, {
			moduleScanMdPath: path.join(moduleRuntimeDir, "module_scan.md"),
			moduleScanJsonPath: path.join(moduleRuntimeDir, "module_scan.json"),
			functionPlanJsonPath: functionPlanHostPath,
			errorMessage: undefined,
		});
		try {
			await fs.stat(functionPlanHostPath);
		} catch {
			await generateFunctionPlanForModuleTaskInContainer({
				scanJob,
				scanModuleTask: refreshedModuleTask,
				hostArtifactDir: moduleRuntimeDir,
			});
		}
		await syncFunctionTasksFromPlanFile({
			scanJob,
			scanModuleTask: refreshedModuleTask,
			functionPlanPath: functionPlanHostPath,
		});
		await updateScanModuleTaskStatus(scanModuleTaskId, "completed");
	} catch (error) {
		await updateScanModuleTaskStatus(
			scanModuleTaskId,
			"failed",
			error instanceof Error ? error.message : "Unknown error",
		).catch(() => {});
		throw error;
	}
};

const runFunctionScannerTaskInContainer = async (scanFunctionTaskId: string) => {
	const scanFunctionTask = await findScanFunctionTaskById(scanFunctionTaskId);
	const scanModuleTask = await findScanModuleTaskById(scanFunctionTask.scanModuleTaskId);
	const scanJob = await findScanJobById(scanFunctionTask.scanJobId);
	const executionContext = await resolveScanExecutionContext(scanJob);
	const functionRoot = buildFullScanFunctionRoot(
		scanJob.scanJobId,
		scanFunctionTask.moduleId,
		scanFunctionTask.functionId,
	);
	const functionRuntimeDir = path.join(
		await resolveScanJobArtifactsDir(scanJob.scanJobId),
		"full_scan",
		"modules",
		sanitizeContextPathPart(scanFunctionTask.moduleId),
		"functions",
		sanitizeContextPathPart(scanFunctionTask.functionId),
	);

	await updateScanFunctionTaskStatus(scanFunctionTaskId, "running");
	await updateScanJobPhase(scanJob.scanJobId, "function_scanning").catch(() => {});

	try {
		await runSingleTurnAgentInContainer({
			scanJob,
			agentProfile: executionContext.scanAgentProfile,
			containerName: [
				sanitizeContainerNamePart(executionContext.projectName),
				sanitizeContainerNamePart(executionContext.serviceName),
				"function-scan",
				sanitizeContainerNamePart(scanFunctionTask.functionId).slice(0, 24),
				nanoid(6),
			].join("-"),
			codexHome: `${functionRoot}/.codex`,
			runtimeDirHost: functionRuntimeDir,
			runtimeRootInContainer: functionRoot,
			cwd: "/workspace/repo",
			prompt: buildFunctionScannerPrompt({
				scanJob,
				scanModuleTask,
				scanFunctionTask,
				functionRoot,
				repositoryRoot: buildFullScanRepositoryRoot(scanJob.scanJobId),
				moduleRoot: buildFullScanModuleRoot(
					scanJob.scanJobId,
					scanFunctionTask.moduleId,
				),
				thinkingLevel: executionContext.scanAgentProfile?.thinkingLevel || "medium",
			}),
			setupMarkdownPathInContainer: `${functionRoot}/00_setup.md`,
			setupMarkdown: [
				"# Function Scanner Setup",
				"",
				`- scan_job_id: ${scanJob.scanJobId}`,
				`- module_id: ${scanFunctionTask.moduleId}`,
				`- function_id: ${scanFunctionTask.functionId}`,
				`- function_name: ${scanFunctionTask.functionName}`,
			].join("\n"),
			onThreadId: async (threadId) => {
				await updateScanFunctionTask(scanFunctionTaskId, { threadId });
			},
		});
		const functionResultHostPath = path.join(
			functionRuntimeDir,
			"function_result.json",
		);
		const functionResult = await readCandidateResultFile(
			functionResultHostPath,
			"function result",
		);
		await persistFunctionResultCandidates({
			scanJobId: scanJob.scanJobId,
			candidates: functionResult.candidates,
		});
		await updateScanFunctionTask(scanFunctionTaskId, {
			functionScanMdPath: path.join(functionRuntimeDir, "function_scan.md"),
			functionScanJsonPath: functionResultHostPath,
			errorMessage: undefined,
		});
		await updateScanFunctionTaskStatus(scanFunctionTaskId, "completed");
	} catch (error) {
		await updateScanFunctionTaskStatus(
			scanFunctionTaskId,
			"failed",
			error instanceof Error ? error.message : "Unknown error",
		).catch(() => {});
		throw error;
	}
};

export const processScanModuleQueueJob = async (
	scanJobId: string,
	scanModuleTaskId: string,
) => {
	const [scanJob, moduleTask] = await Promise.all([
		findScanJobById(scanJobId),
		findScanModuleTaskById(scanModuleTaskId),
	]);
	if (moduleTask.scanJobId !== scanJobId || moduleTask.status === "completed") {
		await reconcileScanJobCandidatePipelineStatus(scanJobId).catch(() => {});
		return;
	}

	const executionContext = await resolveScanExecutionContext(scanJob);
	const releaseModuleSlot = await acquireScanTaskExecutionSlot(
		moduleExecutionStateByKey,
		resolveModuleScanConcurrencyKey(scanJob),
		executionContext.fullScanModuleConcurrency,
	);

	try {
		await runModuleScannerTaskInContainer(scanModuleTaskId);
		await enqueuePendingFunctionScanWorkForModule(scanJobId, scanModuleTaskId);
	} finally {
		releaseModuleSlot();
		await recalculateScanTaskCounts(scanJobId).catch(() => {});
		await reconcileScanJobCandidatePipelineStatus(scanJobId).catch(() => {});
	}
};

export const processScanFunctionQueueJob = async (
	scanJobId: string,
	scanFunctionTaskId: string,
) => {
	const [scanJob, functionTask] = await Promise.all([
		findScanJobById(scanJobId),
		findScanFunctionTaskById(scanFunctionTaskId),
	]);
	if (
		functionTask.scanJobId !== scanJobId ||
		functionTask.status === "completed"
	) {
		await reconcileScanJobCandidatePipelineStatus(scanJobId).catch(() => {});
		return;
	}

	const executionContext = await resolveScanExecutionContext(scanJob);
	const releaseFunctionSlot = await acquireScanTaskExecutionSlot(
		functionExecutionStateByKey,
		resolveFunctionScanConcurrencyKey(scanJob),
		executionContext.fullScanFunctionConcurrency,
	);

	try {
		await runFunctionScannerTaskInContainer(scanFunctionTaskId);
	} finally {
		releaseFunctionSlot();
		await recalculateScanTaskCounts(scanJobId).catch(() => {});
		await reconcileScanJobCandidatePipelineStatus(scanJobId).catch(() => {});
	}
};

const runProgrammaticFullScan = async (scanJobId: string) => {
	const scanJob = await findScanJobById(scanJobId);
	let moduleTasks = await findScanModuleTasksByScanJobId(scanJobId);
	if (
		scanJob.repositoryTaskStatus !== "completed" &&
		moduleTasks.length === 0
	) {
		const repositoryRun = await runRepositoryScannerInContainer(scanJob);
		moduleTasks = repositoryRun.moduleTasks;
	} else if (moduleTasks.length > 0) {
		await updateScanJobRepositoryTaskStatus(scanJob.scanJobId, "completed").catch(
			() => {},
		);
	}

	await enqueuePendingModuleScanWork(scanJobId);

	const refreshedModuleTasks = moduleTasks.length
		? moduleTasks
		: await findScanModuleTasksByScanJobId(scanJobId);
	for (const moduleTask of refreshedModuleTasks) {
		if (
			moduleTask.status !== "completed" ||
			!moduleTask.functionPlanJsonPath
		) {
			continue;
		}
		await syncFunctionTasksFromPlanFile({
			scanJob,
			scanModuleTask: moduleTask,
			functionPlanPath: moduleTask.functionPlanJsonPath,
		}).catch(() => {});
		await enqueuePendingFunctionScanWorkForModule(
			scanJobId,
			moduleTask.scanModuleTaskId,
		);
	}

	await recalculateScanTaskCounts(scanJobId).catch(() => {});
	await reconcileScanJobCandidatePipelineStatus(scanJobId).catch(() => {});
};

export const runScanJobInContainer = async (scanJobId: string) => {
	const scanJob = await findScanJobById(scanJobId);
	if (scanJob.scanType === "full") {
		await runProgrammaticFullScan(scanJobId);
		return;
	}
	const {
		isApplicationJob,
		appName,
		imageTag,
		contextVolumeName,
		projectName,
		serviceName,
		projectProfileContextRoot,
		projectProfileCacheRoot,
		scanAgentProfile,
	} = await resolveScanExecutionContext(scanJob);

	const containerName = [
		sanitizeContainerNamePart(projectName),
		sanitizeContainerNamePart(serviceName),
		scanJob.scanType,
		"scan",
		sanitizeContainerNamePart(scanJob.scanJobId),
	].join("-");
	const scanRootDir = path.posix.join(buildScanJobContextRoot(scanJob.scanJobId), "scanning");
	const startedAt = new Date().toISOString();
	const agentsDir = await resolveAgentsDirectory();
	const agentProvider = scanAgentProfile?.provider || "codex";
	const containerEnvPairs = [
		...getGlobalContainerEnvironmentPairs(),
		`VULSEEK_PROJECT_PROFILE_DIR=${projectProfileContextRoot}`,
		`VULSEEK_PROJECT_CACHE_DIR=${projectProfileCacheRoot}`,
	];
	const containerEnvArgs = containerEnvPairs
		.map((pair) => `-e '${escapeSingleQuotes(pair)}'`)
		.join(" ");

	const scanContextMount = await resolveScanContextMount({
		contextVolumeName,
		projectName,
		profileName: serviceName,
	});
	const scanRuntimeDir = resolveLiveScanJobArtifactsDir({
		scanContextMount,
		scanJobId: scanJob.scanJobId,
		projectName,
		profileName: serviceName,
	});
	const appServerJsonlPath = path.join(scanRuntimeDir, "app-server-messages.jsonl");
	const appServerTextPath = path.join(scanRuntimeDir, "app-server-text.log");
	const appServerStderrPath = path.join(scanRuntimeDir, "app-server-stderr.log");
	const runtimeArtifacts = createCodexRuntimeArtifacts({
		runtimeDir: scanRuntimeDir,
		jsonlFileName: "app-server-messages.jsonl",
		textFileName: "app-server-text.log",
		stderrFileName: "app-server-stderr.log",
	});
	const stageSummary: string[] = [];
	let repositoryState: PreparedRepositoryState | null = null;
	let result:
		| {
				appName: string;
				imageTag: string;
				contextVolumeName: string | null | undefined;
				scanRootDir: string;
				codexStdoutSnippet: string;
				codexStderrSnippet: string;
		  }
		| undefined;
	try {
		const namespaceEnabledContainerArgs = buildNamespaceEnabledContainerArgs();
		await execAsync(
			`docker run -d --rm --name ${containerName} ${namespaceEnabledContainerArgs} ${scanContextMount.dockerMountArg} ${containerEnvArgs} ${imageTag} bash -lc "sleep infinity"`,
		);

		stageSummary.push(`- container: ${containerName}`);
		stageSummary.push(`- image: ${imageTag}`);
		stageSummary.push(`- context_storage: ${scanContextMount.mountDescription}`);
		stageSummary.push(`- scan_type: ${scanJob.scanType}`);
		stageSummary.push(`- container_env_count: ${containerEnvPairs.length}`);
		stageSummary.push(
			`- agent_transport: ${agentProvider === "claude_code" ? "claude-stream-json-stdio" : "codex-app-server-jsonrpc-stdio"}`,
		);
		stageSummary.push(
			`- agent_profile: ${scanAgentProfile?.name || scanAgentProfile?.agentProfileId || "default"}`,
		);
		stageSummary.push(`- agent_provider: ${agentProvider}`);
		stageSummary.push(`- agent_model: ${scanAgentProfile?.model || "gpt-5.4"}`);
		stageSummary.push(`- started_at: ${startedAt}`);

		await execAsync(
			`docker exec ${containerName} bash -lc "mkdir -p '${scanRootDir}' '/root/.codex/skills'"`,
		);

		await writeContainerFile(
			containerName,
			`${scanRootDir}/01_setup.md`,
			[
				"# Setup",
				"",
				`- scan_job_id: ${scanJob.scanJobId}`,
				`- scan_type: ${scanJob.scanType}`,
				`- target: ${isApplicationJob ? "application" : "compose"}`,
				`- app_name: ${appName}`,
				`- image_tag: ${imageTag}`,
				`- context_storage: ${scanContextMount.mountDescription}`,
				`- target_ref: ${scanJob.targetRef || "<none>"}`,
				`- target_tag: ${scanJob.targetTag || "<none>"}`,
				`- commit_sha: ${scanJob.commitSha || "<none>"}`,
				`- base_sha: ${scanJob.baseSha || "<none>"}`,
				...(scanJob.scanType === "delta"
					? [`- commit_window: ${scanJob.commitWindow}`]
					: []),
				`- started_at: ${startedAt}`,
			].join("\n"),
		);

		if (agentsDir) {
			await execAsync(`docker cp "${agentsDir}/." ${containerName}:/root/.codex/skills/`);
			stageSummary.push(`- copied_skills_from: ${agentsDir}`);

			if (scanAgentProfile) {
				await copyCodexAssetsToContainerHome(
					containerName,
					"/root/.codex",
					agentsDir,
					scanAgentProfile,
				);
				stageSummary.push(
					agentProvider === "codex"
						? "- generated_codex_config_from_agent_profile: true"
						: "- using_agent_profile_runtime_env: true",
				);
			} else {
				await copyCodexAssetsToContainerHome(
					containerName,
					"/root/.codex",
					agentsDir,
					null,
				);
				try {
					await execAsync(
						`docker exec ${containerName} bash -lc "test -f /root/.codex/config.toml"`,
					);
					stageSummary.push("- copied_codex_config: true");
				} catch {
					stageSummary.push("- copied_codex_config: false");
				}
				try {
					await execAsync(
						`docker exec ${containerName} bash -lc "test -f /root/.codex/auth.json"`,
					);
					stageSummary.push("- copied_codex_auth: true");
				} catch {
					stageSummary.push("- copied_codex_auth: false");
				}
			}
		} else {
			stageSummary.push("- copied_skills_from: none");
		}

		await writeContainerFile(
			containerName,
			`${scanRootDir}/02_skills.md`,
			["# Skills Copy", "", ...stageSummary].join("\n"),
		);
		await captureContainerCodexState(
			containerName,
			scanRootDir,
			"02_codex_runtime_before.md",
		);
		repositoryState = await prepareRepositoryForScanInContainer({
			containerName,
			scanJob,
			scanRootDir,
		});
		await updateScanJobTargetContext(scanJob.scanJobId, {
			targetRef: repositoryState.currentBranch || repositoryState.targetRef,
			targetTag: repositoryState.currentExactTag || repositoryState.targetTag,
			commitSha: repositoryState.resolvedTargetSha,
			baseSha: repositoryState.resolvedBaseSha,
			commitWindow: repositoryState.commitWindow,
		});

		try {
			const candidateResultPath = buildScanCandidateResultPath(scanJob.scanJobId);
			const codexPrompt = [
				"先概括当前仓库的目录结构，再开始正式扫描。",
				`Run a ${scanJob.scanType} vulnerability scan for this repository.`,
				scanJob.scanType === "delta"
					? "For delta scan, always use the latest fetched ref/HEAD in the repository as the scan target."
					: "For full scan, use the explicitly prepared repository target revision and analyze the full repository codebase, not a recent commit window.",
				`Target ref: ${repositoryState?.currentBranch || repositoryState?.targetRef || "<none>"}.`,
				`Target tag: ${repositoryState?.currentExactTag || repositoryState?.targetTag || "<none>"}.`,
				`Target commit: ${repositoryState?.resolvedTargetSha || "<none>"}.`,
				...(scanJob.scanType === "delta"
					? [
							`Base commit: ${repositoryState?.resolvedBaseSha || "<none>"}.`,
							`Commit window k: ${repositoryState?.commitWindow || scanJob.commitWindow}.`,
						]
					: [
							"Do not bias the scan toward recent commits or recent diffs.",
							"Do not use recent commit windows as the main search strategy for full scan.",
				]),
				`Use ${agentProvider} as the runtime agent and keep reasoning effort around ${scanAgentProfile?.thinkingLevel || "medium"}.`,
				`Before analyzing, use the repository state already prepared in ${toAgentVisiblePath(`${scanRootDir}/00_repository_state.md`)} and work from the checked out target revision in /workspace/repo.`,
				`Use the installed skill named ${scanJob.scanType === "delta" ? "delta-scan" : "full-scan"} as your working method.`,
				"Persist final candidate output only to the required JSON result file.",
				`Write final candidate JSON to ${toAgentVisiblePath(candidateResultPath)}.`,
				"scan_candidates.json must contain a top-level object with a candidates array.",
				"Each candidate object may include only: title, description, filePath, line, confidence, score.",
				"Always write scan_candidates.json, even when there are no candidates; use an empty array in that case.",
				"Focus on security-relevant code paths and produce concise actionable findings.",
				`Write a markdown report to ${toAgentVisiblePath(`${scanRootDir}/03_codex_report.md`)}.`,
				repositoryState?.markdown
					? `Repository state:\n${repositoryState.markdown}`
					: "",
			].join("\n");

			await initializeRuntimeFiles({ runtimeDir: scanRuntimeDir, jsonlPath: appServerJsonlPath, textPath: appServerTextPath, stderrPath: appServerStderrPath });
			await initializeCodexRuntimeMetadataFiles({
				cursorPath: runtimeArtifacts.cursorPath,
				statePath: runtimeArtifacts.statePath,
			});
			await initializeRuntimeFilesInContainer({
				containerName,
				runtimeDirInContainer: scanRootDir,
				jsonlFileName: "app-server-messages.jsonl",
				textFileName: "app-server-text.log",
				stderrFileName: "app-server-stderr.log",
			});
			await initializeCodexRuntimeMetadataFilesInContainer({
				containerName,
				runtimeDirInContainer: scanRootDir,
				cursorFileName: runtimeArtifacts.cursorFileName,
				stateFileName: runtimeArtifacts.stateFileName,
			});
			const sandboxRuntime = await prepareSandboxAgentRuntime({
				containerName,
				runtimeDirHost: scanRuntimeDir,
				runtimeDirInContainer: scanRootDir,
				provider: agentProvider,
				homeDir: "/root",
				envPairs:
					agentProvider === "claude_code" && scanAgentProfile
						? buildClaudeEnvPairs(scanAgentProfile)
						: ["CODEX_HOME=/root/.codex"],
			});
			await runSandboxAgentHeadlessTurnInContainer({
				baseUrl: sandboxRuntime.server.baseUrl,
				provider: agentProvider === "claude_code" ? "claude" : "codex",
				cwd: "/workspace/repo",
				prompt: codexPrompt,
				model: scanAgentProfile?.model,
				thinkingLevel: scanAgentProfile?.thinkingLevel,
				jsonlPath: appServerJsonlPath,
				textPath: appServerTextPath,
				stderrPath: appServerStderrPath,
				onSessionId: async (nextSessionId) => {
					await updateScanJobScanningThreadId(scanJob.scanJobId, nextSessionId);
				},
			});
			const candidateResult = await readCandidateResultFile(
				path.join(scanRuntimeDir, "scan_candidates.json"),
				"scan candidate result",
			);
			const persistResult = await persistFunctionResultCandidates({
				scanJobId: scanJob.scanJobId,
				candidates: candidateResult.candidates,
			});
			await appendScanRuntimeFile(
				appServerStderrPath,
				[
					`[candidate-result] records_received=${persistResult.receivedCandidates}`,
					`records_created=${persistResult.createdCandidates}`,
					`records_dropped=${persistResult.droppedCandidates}`,
				].join(" ") + "\n",
			);
			if (persistResult.receivedCandidates === 0) {
				await appendScanRuntimeFile(
					appServerStderrPath,
					"[candidate-result] scan agent wrote an empty candidates array\n",
				);
			} else if (persistResult.createdCandidates === 0) {
				await appendScanRuntimeFile(
					appServerStderrPath,
					"[candidate-result] candidate records were parsed but no candidate row was created; check payload title/shape\n",
				);
			}
		} catch (error) {
			await captureContainerCodexState(
				containerName,
				scanRootDir,
				"05_codex_runtime_after_failure.md",
			).catch(() => {});
			const failedStdoutSnippet = (
				await readScanJobAppServerText(scanJob.scanJobId)
			).slice(-8_000);
			const failedStderrSnippet = await fs
				.readFile(appServerStderrPath, "utf-8")
				.catch(() => "");
			await writeContainerFile(
				containerName,
				`${scanRootDir}/04_summary.md`,
				[
					"# Scan Summary",
					"",
					`- completed_at: ${new Date().toISOString()}`,
					`- status: failed`,
					`- error: ${error instanceof Error ? error.message : "Unknown error"}`,
					`- app_name: ${appName}`,
					`- image_tag: ${imageTag}`,
					`- app_server_jsonl: ${scanRootDir}/app-server-messages.jsonl`,
					`- app_server_text: ${scanRootDir}/app-server-text.log`,
					`- app_server_stderr: ${scanRootDir}/app-server-stderr.log`,
					"",
					"## App Server Text (tail)",
					"```text",
					failedStdoutSnippet || "(empty)",
					"```",
					"",
					"## App Server Stderr (tail)",
					"```text",
					failedStderrSnippet || "(empty)",
					"```",
				].join("\n"),
			);
			throw error;
		}

		await captureContainerCodexState(
			containerName,
			scanRootDir,
			"05_codex_runtime_after_success.md",
		).catch(() => {});

		const codexStdoutSnippet = (await readScanJobAppServerText(scanJob.scanJobId)).slice(
			-8_000,
		);
		const codexStderrSnippet = await fs
			.readFile(appServerStderrPath, "utf-8")
			.catch(() => "");

		await writeContainerFile(
			containerName,
			`${scanRootDir}/04_summary.md`,
			[
				"# Scan Summary",
				"",
				`- completed_at: ${new Date().toISOString()}`,
				`- status: completed`,
				`- app_name: ${appName}`,
				`- image_tag: ${imageTag}`,
					`- app_server_jsonl: ${scanRootDir}/app-server-messages.jsonl`,
					`- app_server_text: ${scanRootDir}/app-server-text.log`,
					`- app_server_stderr: ${scanRootDir}/app-server-stderr.log`,
				"",
				"## App Server Text (tail)",
				"```text",
				codexStdoutSnippet || "(empty)",
				"```",
				"",
				"## App Server Stderr (tail)",
				"```text",
				codexStderrSnippet || "(empty)",
				"```",
			].join("\n"),
		);

		await syncLegacyFullScanTasksFromArtifacts({
			scanJob,
			scanRuntimeDir,
		}).catch(async (error) => {
			await appendScanRuntimeFile(
				appServerStderrPath,
				`[task-sync] failed to sync legacy full-scan artifacts: ${
					error instanceof Error ? error.message : "unknown error"
				}\n`,
			);
		});

		result = {
			appName,
			imageTag,
			contextVolumeName,
			scanRootDir,
			codexStdoutSnippet,
			codexStderrSnippet,
		};
		} finally {
			// await execAsync(`docker rm -f ${containerName}`).catch(() => {});
		}

	return result as NonNullable<typeof result>;
};

export const runCandidateAnalysisAgentInContainer = async (input: {
	vulnerabilityCandidateId: string;
	stage: VulnerabilityCandidateStage;
	prompt: string;
}) => {
	const candidate = await findVulnerabilityCandidateById(
		input.vulnerabilityCandidateId,
	);
	const scanJob = await findScanJobById(candidate.scanJobId);
	const {
		appName,
		contextVolumeName,
		projectName,
		serviceName,
		analysisAgentProfile,
	} = await resolveScanExecutionContext(scanJob);

	const stage = input.stage;
	const candidateRuntimeRootInContainer = buildCandidateContextRoot(
		scanJob.scanJobId,
		candidate.vulnerabilityCandidateId,
	);
	const codexHome = `${candidateRuntimeRootInContainer}/.codex`;
	const containerName = [
		sanitizeContainerNamePart(projectName),
		sanitizeContainerNamePart(serviceName),
		sanitizeContainerNamePart(candidate.vulnerabilityCandidateId.slice(0, 8)),
		stage,
		String(Date.now()),
	].join("-");
	const scanContextMount = await resolveScanContextMount({
		contextVolumeName,
		projectName,
		profileName: serviceName,
	});
	const candidateRuntimeDir = resolveLiveCandidateArtifactsDir({
		scanContextMount,
		scanJobId: scanJob.scanJobId,
		candidateId: candidate.vulnerabilityCandidateId,
		projectName,
		profileName: serviceName,
	});
	const appServerJsonlPath = path.join(candidateRuntimeDir, "app-server-messages.jsonl");
	const appServerTextPath = path.join(candidateRuntimeDir, "app-server-text.log");
	const appServerStderrPath = path.join(candidateRuntimeDir, "app-server-stderr.log");
	await updateVulnerabilityCandidateCurrentStage(
		candidate.vulnerabilityCandidateId,
		stage,
	);

	const startedAt = Date.now();
	let currentThreadId = getCandidateAnalysisThreadId(candidate);
	const result = await runSingleTurnAgentInContainer({
		scanJob,
		agentProfile: analysisAgentProfile,
		containerName,
		codexHome,
		runtimeDirHost: candidateRuntimeDir,
		runtimeRootInContainer: candidateRuntimeRootInContainer,
		cwd: "/workspace/repo",
		prompt: input.prompt,
		setupMarkdownPathInContainer: `${candidateRuntimeRootInContainer}/01_setup.md`,
		setupMarkdown: [
			"# Candidate Stage Setup",
			"",
			`- scan_job_id: ${scanJob.scanJobId}`,
			`- candidate_id: ${candidate.vulnerabilityCandidateId}`,
			`- stage: ${stage}`,
			`- agent: analysis`,
			`- agent_profile: ${analysisAgentProfile?.name || analysisAgentProfile?.agentProfileId || "default"}`,
			`- agent_provider: ${analysisAgentProfile?.provider || "codex"}`,
			`- agent_model: ${analysisAgentProfile?.model || "gpt-5.4"}`,
			`- app_name: ${appName}`,
			`- context_storage: ${scanContextMount.mountDescription}`,
		].join("\n"),
		onThreadId: async (threadId) => {
			currentThreadId = threadId;
			await updateVulnerabilityCandidateAnalysisThreadId(
				candidate.vulnerabilityCandidateId,
				threadId,
			);
		},
	});
	await persistAnalysisResultPayload({
		scanJobId: scanJob.scanJobId,
		candidateId: candidate.vulnerabilityCandidateId,
		payload: await readAnalysisResultFile(
			path.join(candidateRuntimeDir, "analysis", "analysis_result.json"),
		),
		runtimeSeconds: (Date.now() - startedAt) / 1000,
		threadId: result.threadId || currentThreadId || undefined,
	});

	return {
		scanJobId: scanJob.scanJobId,
		vulnerabilityCandidateId: candidate.vulnerabilityCandidateId,
		stage,
		threadId: result.threadId,
		runtimeDir: candidateRuntimeDir,
		codexStdoutSnippet: (
			await readCandidateAnalysisAppServerText(
				scanJob.scanJobId,
				candidate.vulnerabilityCandidateId,
			)
		).slice(-8_000),
		codexStderrSnippet: await fs
			.readFile(appServerStderrPath, "utf-8")
			.catch(() => ""),
	};
};

const resolveLegacyArtifactHostPath = async (
	scanJob: ScanJob,
	maybeContainerPath: string,
) => {
	if (!maybeContainerPath) {
		return maybeContainerPath;
	}

	const projectProfileHostContextRoot =
		await resolveRequiredProjectProfileHostContextRootByScanJob(scanJob);
	const containerJobRoot = buildScanJobContextRoot(scanJob.scanJobId);

	if (
		maybeContainerPath === containerJobRoot ||
		maybeContainerPath.startsWith(`${containerJobRoot}/`)
	) {
		const relativePath = path.posix.relative(containerJobRoot, maybeContainerPath);
		return path.join(
			projectProfileHostContextRoot,
			"jobs",
			scanJob.scanJobId,
			relativePath,
		);
	}

	return maybeContainerPath;
};

const resolveHostPathToScanContextContainerPath = async (
	scanJob: ScanJob,
	hostPath: string,
) => {
	const projectProfileHostContextRoot =
		await resolveRequiredProjectProfileHostContextRootByScanJob(scanJob);
	const resolvedRoot = path.resolve(projectProfileHostContextRoot);
	const resolvedTarget = path.resolve(hostPath);
	const relativePath = path.relative(resolvedRoot, resolvedTarget);
	if (
		relativePath === ".." ||
		relativePath.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relativePath)
	) {
		throw new Error(`Path is outside project profile context root: ${hostPath}`);
	}

	return path.posix.join("/scan-context", relativePath.split(path.sep).join("/"));
};

const generateFunctionPlanForModuleTaskInContainer = async (input: {
	scanJob: ScanJob;
	scanModuleTask: ScanModuleTask;
	hostArtifactDir: string;
}) => {
	const {
		imageTag,
		contextVolumeName,
		projectName,
		serviceName,
		projectProfileContextRoot,
		projectProfileCacheRoot,
	} = await resolveScanExecutionContext(input.scanJob);
	const agentsDir = await resolveAgentsDirectory();
	if (!agentsDir) {
		throw new Error("Agents directory not found");
	}

	const fileListHostPath = path.join(input.hostArtifactDir, "file_list.txt");
	const outputHostPath = path.join(input.hostArtifactDir, "function_plan.json");
	const runtimeHostPath = path.join(input.hostArtifactDir, "module-scanner-runtime.log");

	try {
		await fs.stat(fileListHostPath);
	} catch {
		throw new Error(`Module file list not found: ${fileListHostPath}`);
	}

	const containerName = [
		sanitizeContainerNamePart(projectName),
		sanitizeContainerNamePart(serviceName),
		"module",
		sanitizeContainerNamePart(input.scanModuleTask.moduleId.slice(0, 24)),
		nanoid(6),
	].join("-");
	const scanContextMount = await resolveScanContextMount({
		contextVolumeName,
		projectName,
		profileName: serviceName,
	});
	const containerEnvPairs = [
		...getGlobalContainerEnvironmentPairs(),
		`VULSEEK_PROJECT_PROFILE_DIR=${projectProfileContextRoot}`,
		`VULSEEK_PROJECT_CACHE_DIR=${projectProfileCacheRoot}`,
	];
	const containerEnvArgs = containerEnvPairs
		.map((pair) => `-e '${escapeSingleQuotes(pair)}'`)
		.join(" ");
	const fileListContainerPath = await resolveHostPathToScanContextContainerPath(
		input.scanJob,
		fileListHostPath,
	);
	const outputContainerPath = await resolveHostPathToScanContextContainerPath(
		input.scanJob,
		outputHostPath,
	);
	const runtimeContainerPath = await resolveHostPathToScanContextContainerPath(
		input.scanJob,
		runtimeHostPath,
	);

	await execAsync(
		`docker run -d --rm --name ${containerName} ${namespaceEnabledContainerArgs} ${scanContextMount.dockerMountArg} ${containerEnvArgs} ${imageTag} bash -lc "mkdir -p /root/.codex/skills && sleep infinity"`,
	);

	try {
		await execAsync(`docker cp "${agentsDir}/." ${containerName}:/root/.codex/skills/`);
		const script = [
			"set -euo pipefail",
			`mkdir -p '${escapeSingleQuotes(path.posix.dirname(outputContainerPath))}'`,
			`python3 - <<'PY' > '${escapeSingleQuotes(
				runtimeContainerPath,
			)}' 2>&1
import importlib
for name in ("tree_sitter", "tree_sitter_c", "tree_sitter_cpp"):
    importlib.import_module(name)
print("tree-sitter runtime dependencies ready")
PY`,
			`cd /workspace/repo && python3 /root/.codex/skills/tools/extract_functions.py --file-list '${escapeSingleQuotes(
				fileListContainerPath,
			)}' --out '${escapeSingleQuotes(outputContainerPath)}' >> '${escapeSingleQuotes(
				runtimeContainerPath,
			)}' 2>&1`,
		].join("\n");
		const encoded = Buffer.from(script, "utf-8").toString("base64");
		await execAsync(
			`docker exec ${containerName} bash -lc "echo '${encoded}' | base64 -d | bash"`,
		);
	} finally {
		await execAsync(`docker rm -f ${containerName}`).catch(() => {});
	}

	return outputHostPath;
};

export const runCandidateVerifierInContainer = async (input: {
	vulnerabilityCandidateId: string;
	prompt: string;
}) => {
	const candidate = await findVulnerabilityCandidateById(
		input.vulnerabilityCandidateId,
	);
	const scanJob = await findScanJobById(candidate.scanJobId);
	const {
		appName,
		contextVolumeName,
		projectName,
		serviceName,
		verifierAgentProfile,
	} = await resolveScanExecutionContext(scanJob);

	const stage: VulnerabilityCandidateStage = "verifying";
	const candidateRuntimeRootInContainer = buildCandidateContextRoot(
		scanJob.scanJobId,
		candidate.vulnerabilityCandidateId,
	);
	const codexHome = `${candidateRuntimeRootInContainer}/.codex-verify`;
	const containerName = [
		sanitizeContainerNamePart(projectName),
		sanitizeContainerNamePart(serviceName),
		sanitizeContainerNamePart(candidate.vulnerabilityCandidateId.slice(0, 8)),
		"verify",
		String(Date.now()),
	].join("-");
	const scanContextMount = await resolveScanContextMount({
		contextVolumeName,
		projectName,
		profileName: serviceName,
	});
	const candidateRuntimeDir = resolveLiveCandidateArtifactsDir({
		scanContextMount,
		scanJobId: scanJob.scanJobId,
		candidateId: candidate.vulnerabilityCandidateId,
		projectName,
		profileName: serviceName,
	});
	const appServerJsonlPath = path.join(candidateRuntimeDir, "verify-app-server-messages.jsonl");
	const appServerTextPath = path.join(candidateRuntimeDir, "verify-app-server-text.log");
	const appServerStderrPath = path.join(candidateRuntimeDir, "verify-app-server-stderr.log");
	await updateVulnerabilityCandidateCurrentStage(
		candidate.vulnerabilityCandidateId,
		stage,
	);

	const startedAt = Date.now();
	let currentThreadId = getCandidateVerifierThreadId(candidate);
	const result = await runSingleTurnAgentInContainer({
		scanJob,
		agentProfile: verifierAgentProfile,
		containerName,
		codexHome,
		runtimeDirHost: candidateRuntimeDir,
		runtimeRootInContainer: candidateRuntimeRootInContainer,
		runtimeFileNames: {
			jsonl: "verify-app-server-messages.jsonl",
			text: "verify-app-server-text.log",
			stderr: "verify-app-server-stderr.log",
		},
		cwd: "/workspace/repo",
		prompt: input.prompt,
		setupMarkdownPathInContainer: `${candidateRuntimeRootInContainer}/verify/00_setup.md`,
		setupMarkdown: [
			"# Candidate Verify Setup",
			"",
			`- scan_job_id: ${scanJob.scanJobId}`,
			`- candidate_id: ${candidate.vulnerabilityCandidateId}`,
			`- agent: verifier`,
			`- agent_profile: ${verifierAgentProfile?.name || verifierAgentProfile?.agentProfileId || "default"}`,
			`- agent_provider: ${verifierAgentProfile?.provider || "codex"}`,
			`- agent_model: ${verifierAgentProfile?.model || "gpt-5.4"}`,
			`- app_name: ${appName}`,
			`- context_storage: ${scanContextMount.mountDescription}`,
		].join("\n"),
		onThreadId: async (threadId) => {
			currentThreadId = threadId;
			await updateVulnerabilityCandidateVerifierThreadId(
				candidate.vulnerabilityCandidateId,
				threadId,
			);
		},
	});
	await persistVerificationResultPayload({
		scanJobId: scanJob.scanJobId,
		candidateId: candidate.vulnerabilityCandidateId,
		payload: await readVerificationResultFile(
			path.join(candidateRuntimeDir, "verify", "verification_result.json"),
		),
		runtimeSeconds: (Date.now() - startedAt) / 1000,
		threadId: result.threadId || currentThreadId || undefined,
	});

	return {
		scanJobId: scanJob.scanJobId,
		vulnerabilityCandidateId: candidate.vulnerabilityCandidateId,
		stage,
		threadId: result.threadId,
		runtimeDir: candidateRuntimeDir,
	};
};

const buildCandidateAnalysisPrompt = async (input: {
	scanJob: ScanJob;
	candidate: VulnerabilityCandidate;
}) => {
	await resolveScanExecutionContext(input.scanJob);
	const reportPath = buildCandidateAnalysisReportPath(
		input.scanJob.scanJobId,
		input.candidate.vulnerabilityCandidateId,
	);
	const resultPath = buildCandidateAnalysisResultPath(
		input.scanJob.scanJobId,
		input.candidate.vulnerabilityCandidateId,
	);

	return [
		"You are the analysis agent for one vulnerability candidate.",
		"Work only on this candidate and decide whether it is a real issue.",
		`scan_job_id: ${input.scanJob.scanJobId}`,
		`candidate_id: ${input.candidate.vulnerabilityCandidateId}`,
		`candidate_title: ${input.candidate.title}`,
		`candidate_description: ${input.candidate.description || "-"}`,
		`candidate_file: ${input.candidate.filePath || "-"}`,
		`candidate_line: ${
			typeof input.candidate.line === "number" ? input.candidate.line : "-"
		}`,
		`write_report_to: ${toAgentVisiblePath(reportPath)}`,
		`write_result_json_to: ${toAgentVisiblePath(resultPath)}`,
		"",
		"Use the installed skill named deep-analysis as your working method.",
		"Strictly follow the fixed markdown template defined in the skill.",
		"After the report is written, write analysis_result.json as a top-level object.",
		"Required JSON fields for this run: result, score, summary.",
		"Optional JSON field: confidence.",
		"Compute score as a 0-10 estimated severity score. Consider CVSS-style dimensions and real-world impact breadth, including whether the vulnerable path appears in common usage scenarios.",
		"",
		"Recommended result enum values:",
		"- real_vulnerability",
		"- likely_vulnerability",
		"- plausible_but_unproven",
		"- false_positive",
	].join("\n");
};

const buildCandidateVerificationPrompt = async (input: {
	scanJob: ScanJob;
	candidate: VulnerabilityCandidate;
	analysisResult: AnalysisResult;
}) => {
	await resolveScanExecutionContext(input.scanJob);
	const {
		reportPath,
		issueDraftPath,
		pocPath,
		dockerfilePath,
		runScriptPath,
	} = buildCandidateVerificationArtifactPaths(
		input.scanJob.scanJobId,
		input.candidate.vulnerabilityCandidateId,
	);
	const resultPath = buildCandidateVerificationResultPath(
		input.scanJob.scanJobId,
		input.candidate.vulnerabilityCandidateId,
	);

	return [
		"You are the verifier agent for one vulnerability candidate.",
		"Work only on this candidate and validate the existing analysis result.",
		`scan_job_id: ${input.scanJob.scanJobId}`,
		`candidate_id: ${input.candidate.vulnerabilityCandidateId}`,
		`candidate_title: ${input.candidate.title}`,
		`candidate_description: ${input.candidate.description || "-"}`,
		`candidate_file: ${input.candidate.filePath || "-"}`,
		`candidate_line: ${
			typeof input.candidate.line === "number" ? input.candidate.line : "-"
		}`,
		`analysis_result: ${input.analysisResult.result}`,
		`analysis_summary: ${input.analysisResult.summary || "-"}`,
		`analysis_report_path: ${input.analysisResult.reportPath ? toAgentVisiblePath(input.analysisResult.reportPath) : "-"}`,
		`write_verify_report_to: ${toAgentVisiblePath(reportPath)}`,
		`write_issue_draft_to: ${toAgentVisiblePath(issueDraftPath)}`,
		`write_poc_to: ${toAgentVisiblePath(pocPath)}`,
		`write_repro_dockerfile_to: ${toAgentVisiblePath(dockerfilePath)}`,
		`write_repro_run_script_to: ${toAgentVisiblePath(runScriptPath)}`,
		`write_result_json_to: ${toAgentVisiblePath(resultPath)}`,
		"",
		"Use the installed skill named verify as your working method.",
		"Strictly follow the fixed markdown templates defined in the skill.",
		"After the verification artifacts are written, write verification_result.json as a top-level object.",
		"Required JSON fields for this run: result, isBug, isSecurity, score, summary.",
		"Optional JSON field: confidence.",
		"Compute score as a 0-10 estimated severity score. Consider CVSS-style dimensions and real-world impact breadth, including whether the vulnerable path appears in common usage scenarios.",
		"",
		"Recommended result enum values:",
		"- real_vulnerability",
		"- likely_vulnerability",
		"- plausible_but_unproven",
		"- false_positive",
		"- api_misuse",
	].join("\n");
};

const shouldVerifyFromAnalysisResult = (
	result: string | null | undefined,
) =>
	result === "real_vulnerability" || result === "likely_vulnerability";

const resolveVerificationConcurrencyKey = (
	scanJob: Pick<ScanJob, "applicationId" | "composeId" | "scanJobId">,
) => {
	if (scanJob.applicationId) {
		return `application:${scanJob.applicationId}`;
	}

	if (scanJob.composeId) {
		return `compose:${scanJob.composeId}`;
	}

	return `scan-job:${scanJob.scanJobId}`;
};

const resolveAnalysisConcurrencyKey = (
	scanJob: Pick<ScanJob, "applicationId" | "composeId" | "scanJobId">,
) => {
	if (scanJob.applicationId) {
		return `application:${scanJob.applicationId}`;
	}

	if (scanJob.composeId) {
		return `compose:${scanJob.composeId}`;
	}

	return `scan-job:${scanJob.scanJobId}`;
};

const resolveModuleScanConcurrencyKey = (
	scanJob: Pick<ScanJob, "scanJobId">,
) => `scan-job:${scanJob.scanJobId}:module`;

const resolveFunctionScanConcurrencyKey = (
	scanJob: Pick<ScanJob, "scanJobId">,
) => `scan-job:${scanJob.scanJobId}:function`;

const enqueueCandidateAnalysisWork = async (
	scanJobId: string,
	vulnerabilityCandidateId: string,
) => {
	await candidateAnalysisQueue.add(
		"analysis",
		{
			scanJobId,
			vulnerabilityCandidateId,
		},
		{
			jobId: `analysis:${vulnerabilityCandidateId}`,
			removeOnComplete: true,
			removeOnFail: true,
		},
	);
};

const enqueueModuleScanWork = async (
	scanJobId: string,
	scanModuleTaskId: string,
) => {
	await moduleScanQueue.add(
		"module",
		{
			scanJobId,
			scanModuleTaskId,
		},
		{
			jobId: `module:${scanModuleTaskId}`,
			removeOnComplete: true,
			removeOnFail: true,
		},
	);
};

const enqueueFunctionScanWork = async (
	scanJobId: string,
	scanFunctionTaskId: string,
) => {
	await functionScanQueue.add(
		"function",
		{
			scanJobId,
			scanFunctionTaskId,
		},
		{
			jobId: `function:${scanFunctionTaskId}`,
			removeOnComplete: true,
			removeOnFail: true,
		},
	);
};

const enqueuePendingModuleScanWork = async (scanJobId: string) => {
	const moduleTasks = await findScanModuleTasksByScanJobId(scanJobId);
	for (const moduleTask of moduleTasks) {
		if (moduleTask.status === "completed" || moduleTask.status === "failed") {
			continue;
		}
		await enqueueModuleScanWork(scanJobId, moduleTask.scanModuleTaskId);
	}
};

const enqueuePendingFunctionScanWorkForModule = async (
	scanJobId: string,
	scanModuleTaskId: string,
) => {
	const functionTasks = await findScanFunctionTasksByModuleTaskId(scanModuleTaskId);
	for (const functionTask of functionTasks) {
		if (
			functionTask.scanJobId !== scanJobId ||
			functionTask.status === "completed" ||
			functionTask.status === "failed"
		) {
			continue;
		}
		await enqueueFunctionScanWork(scanJobId, functionTask.scanFunctionTaskId);
	}
};

const enqueueCandidateVerificationWork = async (
	scanJobId: string,
	vulnerabilityCandidateId: string,
) => {
	await candidateVerificationQueue.add(
		"verification",
		{
			scanJobId,
			vulnerabilityCandidateId,
		},
		{
			jobId: `verification:${vulnerabilityCandidateId}`,
			removeOnComplete: true,
			removeOnFail: true,
		},
	);
};

const removeQueuedCandidateAnalysisWork = async (
	vulnerabilityCandidateId: string,
) => {
	const existingJob = await candidateAnalysisQueue.getJob(
		`analysis:${vulnerabilityCandidateId}`,
	);
	if (existingJob) {
		await existingJob.remove().catch(() => {});
	}
};

const forceRemoveCandidateQueueJob = async (
	queue: Queue<ScanCandidateQueueJob>,
	jobId: string,
) => {
	const existingJob = await queue.getJob(jobId).catch(() => null);
	if (existingJob) {
		const state = await existingJob.getState().catch(() => null);
		if (state && state !== "active") {
			await existingJob.remove().catch(() => {});
			return;
		}
	}

	const client = await queue.client;
	const jobKey = queue.toKey(jobId);
	await client
		.multi()
		.lrem(queue.toKey("active"), 0, jobId)
		.lrem(queue.toKey("wait"), 0, jobId)
		.lrem(queue.toKey("paused"), 0, jobId)
		.zrem(queue.toKey("delayed"), jobId)
		.zrem(queue.toKey("prioritized"), jobId)
		.zrem(queue.toKey("completed"), jobId)
		.zrem(queue.toKey("failed"), jobId)
		.zrem(queue.toKey("waiting-children"), jobId)
		.del(
			jobKey,
			`${jobKey}:lock`,
			`${jobKey}:logs`,
			`${jobKey}:dependencies`,
			`${jobKey}:processed`,
		)
		.exec();
};

const removeQueuedCandidateVerificationWork = async (
	vulnerabilityCandidateId: string,
) => {
	await forceRemoveCandidateQueueJob(
		candidateVerificationQueue,
		`verification:${vulnerabilityCandidateId}`,
	).catch(() => {});
};

const getPendingAnalysisCandidates = async (scanJobId: string) => {
	const [candidates, analysisResultsList] = await Promise.all([
		findVulnerabilityCandidatesByScanJobId(scanJobId),
		findAnalysisResultsByScanJobId(scanJobId),
	]);
	const analysisCandidateIds = new Set(
		analysisResultsList.map((item) => item.vulnerabilityCandidateId),
	);

	const pendingCandidates = candidates.filter(
		(candidate) =>
			!analysisCandidateIds.has(candidate.vulnerabilityCandidateId) &&
			candidate.status !== "failed",
	);
	const failed = candidates.filter(
		(candidate) =>
			!analysisCandidateIds.has(candidate.vulnerabilityCandidateId) &&
			candidate.status === "failed",
	).length;

	return {
		candidates,
		pendingCandidates,
		failed,
	};
};

const getPendingVerificationCandidates = async (scanJobId: string) => {
	const [candidates, analysisResultsList, verificationResultsList] =
		await Promise.all([
			findVulnerabilityCandidatesByScanJobId(scanJobId),
			findAnalysisResultsByScanJobId(scanJobId),
			findVerificationResultsByScanJobId(scanJobId),
		]);
	const latestAnalysisResultByCandidateId = new Map<string, AnalysisResult>();
	for (const analysisResult of analysisResultsList) {
		if (
			!latestAnalysisResultByCandidateId.has(
				analysisResult.vulnerabilityCandidateId,
			)
		) {
			latestAnalysisResultByCandidateId.set(
				analysisResult.vulnerabilityCandidateId,
				analysisResult as AnalysisResult,
			);
		}
	}
	const latestVerificationResultByCandidateId = new Map<
		string,
		VerificationResult
	>();
	for (const verificationResult of verificationResultsList) {
		if (
			!latestVerificationResultByCandidateId.has(
				verificationResult.vulnerabilityCandidateId,
			)
		) {
			latestVerificationResultByCandidateId.set(
				verificationResult.vulnerabilityCandidateId,
				verificationResult as VerificationResult,
			);
		}
	}

	const pendingCandidates = candidates.filter((candidate) => {
		const latestAnalysisResult = latestAnalysisResultByCandidateId.get(
			candidate.vulnerabilityCandidateId,
		);
		if (!latestAnalysisResult) {
			return false;
		}

		if (!shouldVerifyFromAnalysisResult(latestAnalysisResult.result)) {
			return false;
		}

		if (
			latestVerificationResultByCandidateId.has(
				candidate.vulnerabilityCandidateId,
			)
		) {
			return false;
		}

		return candidate.status !== "failed";
	});

	const failed = candidates.filter((candidate) => {
		const latestAnalysisResult = latestAnalysisResultByCandidateId.get(
			candidate.vulnerabilityCandidateId,
		);
		if (!latestAnalysisResult) {
			return false;
		}

		if (!shouldVerifyFromAnalysisResult(latestAnalysisResult.result)) {
			return false;
		}

		if (
			latestVerificationResultByCandidateId.has(
				candidate.vulnerabilityCandidateId,
			)
		) {
			return false;
		}

		return candidate.status === "failed";
	}).length;

	return {
		candidates,
		pendingCandidates,
		totalTargets: candidates.filter((candidate) => {
			const latestAnalysisResult = latestAnalysisResultByCandidateId.get(
				candidate.vulnerabilityCandidateId,
			);
			if (!latestAnalysisResult) {
				return false;
			}

			return shouldVerifyFromAnalysisResult(latestAnalysisResult.result);
		}).length,
		failed,
	};
};

const getPendingScanTaskState = async (scanJobId: string) => {
	const [scanJob, moduleTasks, functionTasks] = await Promise.all([
		findScanJobById(scanJobId),
		findScanModuleTasksByScanJobId(scanJobId),
		findScanFunctionTasksByScanJobId(scanJobId),
	]);

	const repositoryPending =
		scanJob.repositoryTaskStatus !== "completed" &&
		scanJob.repositoryTaskStatus !== "failed";
	const modulePending = moduleTasks.filter(
		(moduleTask) =>
			moduleTask.status !== "completed" && moduleTask.status !== "failed",
	);
	const functionPending = functionTasks.filter(
		(functionTask) =>
			functionTask.status !== "completed" && functionTask.status !== "failed",
	);

	return {
		scanJob,
		repositoryPending,
		modulePending,
		functionPending,
		moduleFailed: moduleTasks.filter((task) => task.status === "failed").length,
		functionFailed: functionTasks.filter((task) => task.status === "failed").length,
	};
};

export const reconcileScanJobCandidatePipelineStatus = async (
	scanJobId: string,
) => {
	const [scanState, analysisState, verificationState] = await Promise.all([
		getPendingScanTaskState(scanJobId),
		getPendingAnalysisCandidates(scanJobId),
		getPendingVerificationCandidates(scanJobId),
	]);

	if (scanState.repositoryPending) {
		if (scanState.scanJob.status !== "scanning") {
			await updateScanJobStatus(scanJobId, "scanning").catch(() => {});
		}
		await updateScanJobPhase(scanJobId, "repository_scanning").catch(() => {});
		return {
			status: "scanning" as const,
			scanPhase: "repository_scanning" as const,
			analysisFailed: analysisState.failed,
			verificationFailed: verificationState.failed,
			moduleFailed: scanState.moduleFailed,
			functionFailed: scanState.functionFailed,
		};
	}

	if (scanState.functionPending.length > 0) {
		if (scanState.scanJob.status !== "scanning") {
			await updateScanJobStatus(scanJobId, "scanning").catch(() => {});
		}
		await updateScanJobPhase(scanJobId, "function_scanning").catch(() => {});
		return {
			status: "scanning" as const,
			scanPhase: "function_scanning" as const,
			analysisFailed: analysisState.failed,
			verificationFailed: verificationState.failed,
			moduleFailed: scanState.moduleFailed,
			functionFailed: scanState.functionFailed,
		};
	}

	if (scanState.modulePending.length > 0) {
		if (scanState.scanJob.status !== "scanning") {
			await updateScanJobStatus(scanJobId, "scanning").catch(() => {});
		}
		await updateScanJobPhase(scanJobId, "module_scanning").catch(() => {});
		return {
			status: "scanning" as const,
			scanPhase: "module_scanning" as const,
			analysisFailed: analysisState.failed,
			verificationFailed: verificationState.failed,
			moduleFailed: scanState.moduleFailed,
			functionFailed: scanState.functionFailed,
		};
	}

	if (scanState.scanJob.repositoryTaskStatus === "failed") {
		await updateScanJobStatus(
			scanJobId,
			"failed",
			"Repository scanning failed",
		).catch(() => {});
		return {
			status: "failed" as const,
			scanPhase: "repository_scanning" as const,
			analysisFailed: analysisState.failed,
			verificationFailed: verificationState.failed,
			moduleFailed: scanState.moduleFailed,
			functionFailed: scanState.functionFailed,
		};
	}

	if (scanState.moduleFailed > 0 || scanState.functionFailed > 0) {
		await updateScanJobStatus(
			scanJobId,
			"failed",
			`${scanState.moduleFailed} module tasks failed, ${scanState.functionFailed} function tasks failed`,
		).catch(() => {});
		return {
			status: "failed" as const,
			scanPhase: "function_scanning" as const,
			analysisFailed: analysisState.failed,
			verificationFailed: verificationState.failed,
			moduleFailed: scanState.moduleFailed,
			functionFailed: scanState.functionFailed,
		};
	}

	if (analysisState.pendingCandidates.length > 0) {
		if (scanState.scanJob.status !== "analyzing") {
			await updateScanJobStatus(scanJobId, "analyzing").catch(() => {});
		}
		return {
			status: "analyzing" as const,
			scanPhase: "analyzing" as const,
			analysisFailed: analysisState.failed,
			verificationFailed: verificationState.failed,
			moduleFailed: scanState.moduleFailed,
			functionFailed: scanState.functionFailed,
		};
	}

	if (verificationState.pendingCandidates.length > 0) {
		if (scanState.scanJob.status !== "verifying") {
			await updateScanJobStatus(scanJobId, "verifying").catch(() => {});
		}
		return {
			status: "verifying" as const,
			scanPhase: "verifying" as const,
			analysisFailed: analysisState.failed,
			verificationFailed: verificationState.failed,
			moduleFailed: scanState.moduleFailed,
			functionFailed: scanState.functionFailed,
		};
	}

	if (analysisState.failed > 0) {
		await updateScanJobStatus(
			scanJobId,
			"failed",
			`${analysisState.failed} candidate analyses failed`,
		).catch(() => {});
		return {
			status: "failed" as const,
			scanPhase: "analyzing" as const,
			analysisFailed: analysisState.failed,
			verificationFailed: verificationState.failed,
			moduleFailed: scanState.moduleFailed,
			functionFailed: scanState.functionFailed,
		};
	}

	if (verificationState.failed > 0) {
		await updateScanJobStatus(
			scanJobId,
			"failed",
			`${verificationState.failed} candidate verifications failed`,
		).catch(() => {});
		return {
			status: "failed" as const,
			scanPhase: "verifying" as const,
			analysisFailed: analysisState.failed,
			verificationFailed: verificationState.failed,
			moduleFailed: scanState.moduleFailed,
			functionFailed: scanState.functionFailed,
		};
	}

	if (scanState.scanJob.status !== "completed") {
		await updateScanJobStatus(scanJobId, "completed").catch(() => {});
	}
	return {
		status: "completed" as const,
		scanPhase: "completed" as const,
		analysisFailed: 0,
		verificationFailed: 0,
		moduleFailed: scanState.moduleFailed,
		functionFailed: scanState.functionFailed,
	};
};

const normalizeCandidateStatusesForScanJob = async (scanJobId: string) => {
	const [candidates, analysisResultsList, verificationResultsList] =
		await Promise.all([
			findVulnerabilityCandidatesByScanJobId(scanJobId),
			findAnalysisResultsByScanJobId(scanJobId),
			findVerificationResultsByScanJobId(scanJobId),
		]);

	const latestAnalysisResultByCandidateId = new Map<string, AnalysisResult>();
	for (const analysisResult of analysisResultsList) {
		if (
			!latestAnalysisResultByCandidateId.has(
				analysisResult.vulnerabilityCandidateId,
			)
		) {
			latestAnalysisResultByCandidateId.set(
				analysisResult.vulnerabilityCandidateId,
				analysisResult as AnalysisResult,
			);
		}
	}

	const latestVerificationResultByCandidateId = new Map<
		string,
		VerificationResult
	>();
	for (const verificationResult of verificationResultsList) {
		if (
			!latestVerificationResultByCandidateId.has(
				verificationResult.vulnerabilityCandidateId,
			)
		) {
			latestVerificationResultByCandidateId.set(
				verificationResult.vulnerabilityCandidateId,
				verificationResult as VerificationResult,
			);
		}
	}

	for (const candidate of candidates) {
		const verificationResult = latestVerificationResultByCandidateId.get(
			candidate.vulnerabilityCandidateId,
		);
		if (verificationResult) {
			if (candidate.currentStage !== "verifying") {
				await updateVulnerabilityCandidateCurrentStage(
					candidate.vulnerabilityCandidateId,
					"verifying",
				).catch(() => {});
			}
			if (candidate.status !== "completed") {
				await updateVulnerabilityCandidateStatus(
					candidate.vulnerabilityCandidateId,
					"completed",
				).catch(() => {});
			}
			continue;
		}

		const analysisResult = latestAnalysisResultByCandidateId.get(
			candidate.vulnerabilityCandidateId,
		);
		if (!analysisResult) {
			continue;
		}

		if (shouldVerifyFromAnalysisResult(analysisResult.result)) {
				if (candidate.currentStage !== "verifying") {
					await updateVulnerabilityCandidateCurrentStage(
						candidate.vulnerabilityCandidateId,
						"verifying",
					).catch(() => {});
				}
				if (
					candidate.status !== "failed" &&
					candidate.status !== "running" &&
					candidate.status !== "queued"
				) {
					await updateVulnerabilityCandidateStatus(
						candidate.vulnerabilityCandidateId,
						"queued",
					).catch(() => {});
				}
				continue;
		}

		if (candidate.currentStage !== "analyzing") {
			await updateVulnerabilityCandidateCurrentStage(
				candidate.vulnerabilityCandidateId,
				"analyzing",
			).catch(() => {});
		}
		if (candidate.status !== "completed") {
			await updateVulnerabilityCandidateStatus(
				candidate.vulnerabilityCandidateId,
				"completed",
			).catch(() => {});
		}
	}
};

export const processCandidateAnalysisQueueJob = async (
	scanJobId: string,
	vulnerabilityCandidateId: string,
) => {
	const [scanJob, candidate, existingAnalysisResult, existingVerificationResult] =
		await Promise.all([
			findScanJobById(scanJobId),
			findVulnerabilityCandidateById(vulnerabilityCandidateId),
			findLatestAnalysisResultByCandidateId(vulnerabilityCandidateId),
			findLatestVerificationResultByCandidateId(vulnerabilityCandidateId),
		]);

	if (existingAnalysisResult) {
			if (
				shouldVerifyFromAnalysisResult(existingAnalysisResult.result) &&
				!existingVerificationResult
			) {
				await updateVulnerabilityCandidateStatus(
					vulnerabilityCandidateId,
					"queued",
				).catch(() => {});
			await updateVulnerabilityCandidateCurrentStage(
				vulnerabilityCandidateId,
				"verifying",
			).catch(() => {});
			await enqueueCandidateVerificationWork(
				scanJobId,
				vulnerabilityCandidateId,
			);
		}
		return;
	}

	const executionContext = await resolveScanExecutionContext(scanJob);
	const releaseAnalysisSlot = await acquireAnalysisExecutionSlot(
		resolveAnalysisConcurrencyKey(scanJob),
		executionContext.analysisConcurrency,
	);

	await updateVulnerabilityCandidateStatus(vulnerabilityCandidateId, "running");
	await updateVulnerabilityCandidateCurrentStage(
		vulnerabilityCandidateId,
		"analyzing",
	);

	try {
		const prompt = await buildCandidateAnalysisPrompt({
			scanJob,
			candidate,
		});
		await runCandidateAnalysisAgentInContainer({
			vulnerabilityCandidateId,
			stage: "analyzing",
			prompt,
		});

		const latestAnalysisResult = await findLatestAnalysisResultByCandidateId(
			vulnerabilityCandidateId,
		);
		if (!latestAnalysisResult) {
			throw new Error(
				`Analysis finished without a persisted analysis result for candidate ${vulnerabilityCandidateId}`,
			);
		}

			if (shouldVerifyFromAnalysisResult(latestAnalysisResult.result)) {
				await updateVulnerabilityCandidateStatus(
					vulnerabilityCandidateId,
					"queued",
				).catch(() => {});
			await updateVulnerabilityCandidateCurrentStage(
				vulnerabilityCandidateId,
				"verifying",
			).catch(() => {});
			await enqueueCandidateVerificationWork(
				scanJobId,
				vulnerabilityCandidateId,
			);
			return;
		}

		const refreshed = await findVulnerabilityCandidateById(
			vulnerabilityCandidateId,
		);
		if (
			refreshed.status === "running" &&
			refreshed.currentStage === "analyzing"
		) {
			await updateVulnerabilityCandidateStatus(
				vulnerabilityCandidateId,
				"completed",
			);
		}
	} catch (error) {
		await updateVulnerabilityCandidateStatus(
			vulnerabilityCandidateId,
			"failed",
		).catch(() => {});
		throw error;
	} finally {
		releaseAnalysisSlot();
		await reconcileScanJobCandidatePipelineStatus(scanJobId).catch(() => {});
	}
};

export const processCandidateVerificationQueueJob = async (
	scanJobId: string,
	vulnerabilityCandidateId: string,
) => {
	const [scanJob, candidate, latestAnalysisResult, existingVerificationResult] =
		await Promise.all([
			findScanJobById(scanJobId),
			findVulnerabilityCandidateById(vulnerabilityCandidateId),
			findLatestAnalysisResultByCandidateId(vulnerabilityCandidateId),
			findLatestVerificationResultByCandidateId(vulnerabilityCandidateId),
		]);

	if (existingVerificationResult) {
		return;
	}

	if (!latestAnalysisResult || !shouldVerifyFromAnalysisResult(latestAnalysisResult.result)) {
		return;
	}

	const executionContext = await resolveScanExecutionContext(scanJob);
	const releaseVerificationSlot = await acquireVerificationExecutionSlot(
		resolveVerificationConcurrencyKey(scanJob),
		executionContext.verifyConcurrency,
	);

	await updateVulnerabilityCandidateStatus(vulnerabilityCandidateId, "running");
	await updateVulnerabilityCandidateCurrentStage(
		vulnerabilityCandidateId,
		"verifying",
	);

	try {
		const prompt = await buildCandidateVerificationPrompt({
			scanJob,
			candidate,
			analysisResult: latestAnalysisResult,
		});
		await runCandidateVerifierInContainer({
			vulnerabilityCandidateId,
			prompt,
		});

		const latestVerificationResult = await findLatestVerificationResultByCandidateId(
			vulnerabilityCandidateId,
		);
		if (!latestVerificationResult) {
			throw new Error(
				`Verification finished without a persisted verification result for candidate ${vulnerabilityCandidateId}`,
			);
		}

		const refreshed = await findVulnerabilityCandidateById(
			vulnerabilityCandidateId,
		);
		if (
			refreshed.status === "running" &&
			refreshed.currentStage === "verifying"
		) {
			await updateVulnerabilityCandidateStatus(
				vulnerabilityCandidateId,
				"completed",
			);
		}
	} catch (error) {
		await updateVulnerabilityCandidateStatus(
			vulnerabilityCandidateId,
			"failed",
		).catch(() => {});
		throw error;
	} finally {
		releaseVerificationSlot();
		await reconcileScanJobCandidatePipelineStatus(scanJobId).catch(() => {});
	}
};

export const runScanJobAnalysisPipeline = async (scanJobId: string) => {
	const initialState = await getPendingAnalysisCandidates(scanJobId);
	if (initialState.candidates.length === 0) {
		return { total: 0, failed: 0 };
	}
	if (initialState.pendingCandidates.length > 0) {
		await updateScanJobStatus(scanJobId, "analyzing").catch(() => {});
		for (const candidate of initialState.pendingCandidates) {
			await enqueueCandidateAnalysisWork(
				scanJobId,
				candidate.vulnerabilityCandidateId,
			);
		}
	}

	while (true) {
		const state = await getPendingAnalysisCandidates(scanJobId);
		if (state.pendingCandidates.length === 0) {
			return {
				total: state.candidates.length,
				failed: state.failed,
			};
		}

		await updateScanJobStatus(scanJobId, "analyzing").catch(() => {});
		for (const candidate of state.pendingCandidates) {
			await enqueueCandidateAnalysisWork(
				scanJobId,
				candidate.vulnerabilityCandidateId,
			);
		}
		await sleep(1_000);
	}
};

export const runScanJobVerificationPipeline = async (scanJobId: string) => {
	const initialState = await getPendingVerificationCandidates(scanJobId);
	if (initialState.totalTargets === 0) {
		return { total: 0, failed: 0 };
	}
	if (
		initialState.pendingCandidates.length === 0 &&
		initialState.failed === 0
	) {
		return { total: initialState.totalTargets, failed: 0 };
	}

	while (true) {
		const state = await getPendingVerificationCandidates(scanJobId);
		if (state.pendingCandidates.length === 0) {
			return {
				total: state.totalTargets,
				failed: state.failed,
			};
		}

		await updateScanJobStatus(scanJobId, "verifying").catch(() => {});
		for (const candidate of state.pendingCandidates) {
			await updateVulnerabilityCandidateCurrentStage(
				candidate.vulnerabilityCandidateId,
				"verifying",
			).catch(() => {});
			await enqueueCandidateVerificationWork(
				scanJobId,
				candidate.vulnerabilityCandidateId,
			);
		}
		await sleep(1_000);
	}
};

export const recoverPendingScanCandidateQueues = async () => {
	const jobs = await db
		.select({
			scanJobId: scanJobs.scanJobId,
			status: scanJobs.status,
			scanPhase: scanJobs.scanPhase,
		})
		.from(scanJobs)
		.where(
			sql`${scanJobs.status} <> 'completed' and ${scanJobs.status} <> 'failed'`,
		);

	let analysisCandidates = 0;
	let verificationCandidates = 0;

	for (const job of jobs) {
		const currentScanJob = await findScanJobById(job.scanJobId);
		await normalizeCandidateStatusesForScanJob(job.scanJobId);
		const analysisState = await getPendingAnalysisCandidates(job.scanJobId);
		const verificationState = await getPendingVerificationCandidates(job.scanJobId);

		for (const candidate of analysisState.pendingCandidates) {
			await updateVulnerabilityCandidateCurrentStage(
				candidate.vulnerabilityCandidateId,
				"analyzing",
			).catch(() => {});
			if (candidate.status !== "failed") {
				if (candidate.status !== "running") {
					await updateVulnerabilityCandidateStatus(
						candidate.vulnerabilityCandidateId,
						"queued",
					).catch(() => {});
				}
				await enqueueCandidateAnalysisWork(
					job.scanJobId,
					candidate.vulnerabilityCandidateId,
				);
				analysisCandidates += 1;
			}
		}

		for (const candidate of verificationState.pendingCandidates) {
			if (candidate.status !== "running") {
				await updateVulnerabilityCandidateStatus(
					candidate.vulnerabilityCandidateId,
					"queued",
				).catch(() => {});
			}
			await updateVulnerabilityCandidateCurrentStage(
				candidate.vulnerabilityCandidateId,
				"verifying",
			).catch(() => {});
			await enqueueCandidateVerificationWork(
				job.scanJobId,
				candidate.vulnerabilityCandidateId,
			);
			verificationCandidates += 1;
		}

		if (
			job.status !== "scanning" &&
			job.status !== "queued" &&
			verificationState.pendingCandidates.length > 0
		) {
			await updateScanJobStatus(job.scanJobId, "verifying").catch(() => {});
		} else if (
			job.status !== "scanning" &&
			job.status !== "queued" &&
			analysisState.pendingCandidates.length > 0
		) {
			await updateScanJobStatus(job.scanJobId, "analyzing").catch(() => {});
		}

		await reconcileScanJobCandidatePipelineStatus(job.scanJobId).catch(() => {});
	}

	return {
		scanJobs: jobs.length,
		analysisCandidates,
		verificationCandidates,
	};
};

export const recoverPendingFullScanQueues = async () => {
	const jobs = await db
		.select({
			scanJobId: scanJobs.scanJobId,
			scanType: scanJobs.scanType,
			status: scanJobs.status,
			repositoryTaskStatus: scanJobs.repositoryTaskStatus,
		})
		.from(scanJobs)
		.where(
			sql`${scanJobs.status} <> 'completed' and ${scanJobs.status} <> 'failed'`,
		);

	let moduleTasksEnqueued = 0;
	let functionTasksEnqueued = 0;

	for (const job of jobs) {
		if (job.scanType !== "full") {
			continue;
		}

		if (job.repositoryTaskStatus === "completed") {
			const moduleTasks = await findScanModuleTasksByScanJobId(job.scanJobId);
			for (const moduleTask of moduleTasks) {
				if (moduleTask.status !== "completed" && moduleTask.status !== "failed") {
					await enqueueModuleScanWork(job.scanJobId, moduleTask.scanModuleTaskId);
					moduleTasksEnqueued += 1;
					continue;
				}

				if (
					moduleTask.status === "completed" &&
					moduleTask.functionPlanJsonPath
				) {
					const scanJob = await findScanJobById(job.scanJobId);
					await syncFunctionTasksFromPlanFile({
						scanJob,
						scanModuleTask: moduleTask,
						functionPlanPath: moduleTask.functionPlanJsonPath,
					}).catch(() => {});
					const functionTasks = await findScanFunctionTasksByModuleTaskId(
						moduleTask.scanModuleTaskId,
					);
					for (const functionTask of functionTasks) {
						if (
							functionTask.status === "completed" ||
							functionTask.status === "failed"
						) {
							continue;
						}
						await enqueueFunctionScanWork(
							job.scanJobId,
							functionTask.scanFunctionTaskId,
						);
						functionTasksEnqueued += 1;
					}
				}
			}
		}

		await recalculateScanTaskCounts(job.scanJobId).catch(() => {});
		await reconcileScanJobCandidatePipelineStatus(job.scanJobId).catch(() => {});
	}

	return {
		scanJobs: jobs.length,
		moduleTasksEnqueued,
		functionTasksEnqueued,
	};
};

export const startCandidateVerification = async (
	vulnerabilityCandidateId: string,
) => {
	const candidate = await findVulnerabilityCandidateById(vulnerabilityCandidateId);
	const scanJob = await findScanJobById(candidate.scanJobId);
	const latestAnalysisResult = await findLatestAnalysisResultByCandidateId(
		vulnerabilityCandidateId,
	);

	if (
		!latestAnalysisResult ||
		(latestAnalysisResult.result !== "real_vulnerability" &&
			latestAnalysisResult.result !== "likely_vulnerability")
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"Verification can only be started for candidates with likely or real analysis results",
		});
	}

	const hasPreviousVerification = Boolean(candidate.verifierThreadId);
	if (
		candidate.currentStage === "verifying" &&
		(candidate.status === "running" || candidate.status === "queued")
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Candidate verification is already queued or running",
		});
	}

	if (hasPreviousVerification || candidate.status === "failed") {
		await removeQueuedCandidateVerificationWork(
			vulnerabilityCandidateId,
		).catch(() => {});
	}

	await updateVulnerabilityCandidateStatus(vulnerabilityCandidateId, "queued");
	await updateVulnerabilityCandidateCurrentStage(
		vulnerabilityCandidateId,
		"verifying",
	);

	if (hasPreviousVerification) {
		await deleteVerificationResultsByCandidateId(vulnerabilityCandidateId);
		await syncVulnerabilityCandidateResolvedRiskMetrics(
			vulnerabilityCandidateId,
		).catch(() => {});
	}
	await enqueueCandidateVerificationWork(
		scanJob.scanJobId,
		vulnerabilityCandidateId,
	);

	return {
		started: true,
		reverify: hasPreviousVerification,
	};
};
