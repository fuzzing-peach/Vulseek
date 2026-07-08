import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { apiCheckoutScanEnvironment } from "@vulseek/server/db/schema";
import { TRPCError } from "@trpc/server";
import { Queue } from "bullmq";
import { nanoid } from "nanoid";
import { SandboxAgent } from "sandbox-agent";
import { Agent, type Dispatcher } from "undici";
import { getGlobalContainerEnvironmentPairs } from "../utils/docker/utils";
import { execAsync, execAsyncStream } from "../utils/process/execAsync";
import { getAgentProfileById } from "./ai";
import { findApplicationById } from "./application";
import { findComposeById } from "./compose";
import {
	type Analysis,
	analysisFeedbackEnvelopeSchema,
	analysisSchema,
	type CriticResponse,
	criticResponseSchema,
	type Evidence,
	type FinalAnalysis,
	finalAnalysisSchema,
	targetKindSchema,
	verificationSchema,
	type Verification,
} from "./scan/artifacts/contracts/domain-object.contract";
import {
	copyTaskJsonArtifact,
	readTaskJsonArtifact,
	writeTaskJsonArtifact,
	writeTaskTextArtifact,
} from "./scan/artifacts/task-artifact-paths";
import { DEFAULT_DELTA_COMMIT_WINDOW } from "./scan/constants";
import {
	findVulnerabilityCandidateByIdAndScanJobIdRepo,
	findVulnerabilityCandidateByIdRepo,
	findVulnerabilityCandidatesByScanJobIdRepo,
} from "./scan/persistence/candidate.repo";
import { findCandidateTaskLineage } from "./scan/api/candidate-records";
import { readTaskJsonArtifactForTask } from "./scan/persistence/task-artifact-resolver";
import {
	findScanJobByIdRepo,
	listUnfinishedScanJobsRepo,
	recalculateScanTaskCountsRepo,
	resetScanJobForRetryRepo,
	updateScanJobStatusRepo,
} from "./scan/persistence/scan-job.repo";
import {
	findStageGroupInstanceByIdRepo,
	listStageLaneRuntimesByScanJobIdRepo,
	listStageGroupInstancesByScanJobIdRepo,
	resetStageLaneRuntimesByScanJobIdRepo,
} from "./scan/persistence/stage-lane-runtime.repo";
import {
	createTaskRepo,
	findLatestAnalysisResultByCandidateIdRepo,
	findLatestTriageResultByCandidateIdRepo,
	findLatestVerificationResultByCandidateIdRepo,
	findTaskByIdRepo,
	listAnalysisResultsByScanJobIdRepo,
	listCandidateDescendantTasksByProducerTaskIdRepo,
	listChildTasksByParentTaskIdAndStageRepo,
	listTaskStatusCountsByScanJobIdRepo,
	listTasksByScanJobAndStageRepo,
	listTasksByScanJobAndStatusesRepo,
	listTasksByScanJobIdRepo,
	listTerminalTasksPageByScanJobIdRepo,
	listTriageResultsByScanJobIdRepo,
	listVerificationResultsByScanJobIdRepo,
	requeueTaskRepo,
	resetFailedTaskForRetryRepo,
	updateTaskRepo,
	updateTaskStatusRepo,
} from "./scan/persistence/task.repo";
import type {
	AnyStageDefinition,
	PipelineDefinition,
	PipelineEdge,
} from "./scan/pipeline/pipeline-definition";
import {
	createPipelineDefinition,
	createPipelineEdge,
} from "./scan/pipeline/pipeline-definition";
import { createStageRuntimeConfig } from "./scan/pipeline/scan-stage-runtime-config";
import {
	SCAN_PIPELINE_DEFINITIONS,
	readScanPipelineDefinitionsYaml,
	validatePipelineRegistryCoverage,
	type ScanPipelineDefinitions,
	type ScanPipelineConfig,
} from "./scan/pipeline/scan-pipeline-definitions";
import { transformPipelineEdgeInput } from "./scan/pipeline/scan-pipeline-edge-transform";
import {
	createJsonSchemaContract,
	type StructuredOutputSchemaSource,
} from "./scan/pipeline/scan-pipeline-schema-contracts";
import {
	runPipeline,
	startPipelineRuntime,
	stopPipelineRuntimesForScanJob,
} from "./scan/pipeline/pipeline-runner";
import {
	createStageQueueBinding,
	type StageDefinition,
} from "./scan/pipeline/stage-definition";
import {
	buildKnownQueueJobIdsForTask,
	buildQueueTaskJobId,
} from "./scan/queue-job-ids";
import { buildTaskAgentProfileSnapshot } from "./scan/agent-profile-snapshot";
import {
	isRetryableTaskStageName,
	retryFailedScanJobTasksWithDeps,
} from "./scan/retry-failed-tasks";
import { SANDBOX_AGENT_RUNTIME_FILE_NAMES } from "./scan/runtime/sandbox-agent-shared";
import {
	buildEffectiveDisabledStageSet,
	getRuntimeStageConcurrency,
	getRuntimeStageSetting,
} from "./scan/runtime-settings";
import { SCAN_STAGE_IDS, SCAN_STAGE_METADATA } from "./scan/stage-metadata";
import {
	type AnalysisCriticStageInput,
	createAnalysisCriticStageDefinition,
} from "./scan/stages/analysis-critic.stage";
import {
	createAttackSurfaceModelStageDefinition,
	type AttackSurfaceModelStageInput,
} from "./scan/stages/attack-surface-model.stage";
import {
	type CandidateAnalysisStageInput,
	type CandidateAnalysisStageOutput,
	createAnalysisStageDefinition,
} from "./scan/stages/candidate-analysis.stage";
import {
	type CandidateTriageStageInput,
	createTriageStageDefinition,
} from "./scan/stages/candidate-triage.stage";
import {
	type CandidateVerificationStageInput,
	createVerifyingStageDefinition,
} from "./scan/stages/candidate-verification.stage";
import {
	resolveScanProfileConcurrencySettingsFromTarget,
	resolveStageAgentProfile,
	resolveStageAgentProfileFromTarget,
	resolveTaskRootSegment,
	resolveTaskRuntimeDirForTask,
} from "./scan/stages/full-scan-stage.runtime";
import type {
	PipelineContext,
	StageAgentKind,
} from "./scan/stages/full-scan-stage.runtime";
import {
	createIdentifyTargetStageDefinition,
	type IdentifyTargetStageInput,
} from "./scan/stages/identify-target.stage";
import {
	createScanTargetStageDefinition,
	type ScanTargetStageInput,
	type ScanTargetStageOutput,
} from "./scan/stages/scan-target.stage";
import {
	createDeltaScopeStageDefinition,
} from "./scan/stages/delta-scope.stage";
import {
	createRepositoryScanningStageDefinition,
	type RepositoryScanningStageInput,
	type RepositoryScanningStageOutput,
} from "./scan/stages/repository-scan.stage";
import {
	getPendingAnalysisCandidateState,
	getPendingVerificationCandidateState,
} from "./scan/state/pending-candidate-state";
import { getPendingScanTaskStateView } from "./scan/state/scan-pipeline-read-model";
import { resolveNextScanPipelineState } from "./scan/state/scan-state-machine";
import { createShortTaskId } from "./scan/task-id";
import type {
	AgentProfileLike,
	AnalysisResult,
	Candidate as CanonicalCandidate,
	Function as CanonicalFunction,
	Module as CanonicalModule,
	ModuleThreatModel as CanonicalModuleThreatModel,
	Repository as CanonicalRepository,
	RepositoryModule as CanonicalRepositoryModule,
	ScanJob,
	Target as CanonicalTarget,
	Task,
	TriageResult,
	VerificationResult,
	VulnerabilityCandidateStage,
} from "./scan/types";

const DEFAULT_FULL_SCAN_MODULE_CONCURRENCY = 4;
const DEFAULT_FULL_SCAN_FUNCTION_CONCURRENCY = 4;
const DEFAULT_ANALYSIS_CONCURRENCY = 2;
const DEFAULT_VERIFY_CONCURRENCY = 1;
const DEFAULT_TRIAGE_CONCURRENCY = 1;
const ACP_HTTP_TIMEOUT_MS = 15 * 60 * 1000;
const PREINSTALLED_TOOL_SKILLS = [] as const;
const RUNTIME_CUSTOM_SKILLS = [
	"codeql",
	"semgrep",
	"delta-scope",
	"full-scan",
	"full-scan-subagent",
	"scan-repository",
	"attack-surface-model",
	"identify-target",
	"scan-target",
	"scan-module",
	"scan-function",
	"analyze",
	"libafl",
	"criticize",
	"verify",
	"search-registries",
	"tree-sitter",
] as const;

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

type UnifiedModuleTaskView = {
	taskId: string;
	scanModuleTaskId: string;
	moduleId: string;
	moduleName: string;
	status: string;
	priority: number;
	attempt: number;
	errorMessage: string | null;
	startedAt: string | null;
	completedAt: string | null;
	updatedAt: string;
};

type UnifiedFunctionTaskView = {
	taskId: string;
	functionTaskId: string;
	scanModuleTaskId: string | null;
	moduleId: string;
	moduleName: string;
	functionId: string;
	functionName: string;
	filePath: string | null;
	line: number | null;
	status: string;
	priority: number;
	attempt: number;
	score: number | null;
	vulnerabilityType: string | null;
	summary: string | null;
	errorMessage: string | null;
	startedAt: string | null;
	completedAt: string | null;
	updatedAt: string;
};

type InProgressTaskView = {
	id: string;
	taskId: string;
	title: string;
	subtitle: string;
	stage:
		| "delta_scoping"
		| "repository_scanning"
		| "attack_surface_modeling"
		| "module_scanning"
		| "function_scanning"
		| "analyzing"
		| "criticizing"
		| "verifying"
		| "triaging";
	startedAt: string | null;
	updatedAt: string;
};

type TerminalTaskView = InProgressTaskView & {
	status: "completed" | "failed" | "canceled" | "exited";
	completedAt: string | null;
	errorMessage: string | null;
};

type QueuePendingCountView = {
	id: ScanStageQueueKind;
	title: string;
	stageName: Task["stageName"];
	queueName: string;
	concurrencyLimit: number;
	waitingCount: number;
	queuedCount: number;
	launchingCount: number;
	launchedCount: number;
	startingCount: number;
	runningCount: number;
	completedCount: number;
	failedCount: number;
	exitedCount: number;
	canceledCount: number;
	totalCount: number;
	pendingCount: number;
};

const IN_PROGRESS_TASK_STAGE_ORDER: Record<
	InProgressTaskView["stage"],
	number
> = {
	delta_scoping: 0,
	repository_scanning: 1,
	attack_surface_modeling: 2,
	module_scanning: 3,
	function_scanning: 4,
	analyzing: 5,
	criticizing: 6,
	verifying: 7,
	triaging: 8,
};

const compareInProgressTaskView = (
	left: InProgressTaskView,
	right: InProgressTaskView,
) => {
	const stageRankDiff =
		IN_PROGRESS_TASK_STAGE_ORDER[left.stage] -
		IN_PROGRESS_TASK_STAGE_ORDER[right.stage];
	if (stageRankDiff !== 0) {
		return stageRankDiff;
	}
	return right.updatedAt.localeCompare(left.updatedAt);
};

const compareTerminalTaskView = (
	left: TerminalTaskView,
	right: TerminalTaskView,
) => {
	const leftCompletedAt = left.completedAt || left.updatedAt;
	const rightCompletedAt = right.completedAt || right.updatedAt;
	const completedAtDiff = rightCompletedAt.localeCompare(leftCompletedAt);
	if (completedAtDiff !== 0) {
		return completedAtDiff;
	}
	return compareInProgressTaskView(left, right);
};

export const MAX_CANDIDATE_ANALYSIS_WORKER_CONCURRENCY = 16;
export const MAX_CANDIDATE_VERIFICATION_WORKER_CONCURRENCY = 16;
export const MAX_SCAN_MODULE_WORKER_CONCURRENCY = 32;
export const MAX_SCAN_FUNCTION_WORKER_CONCURRENCY = 32;

type ScanStageQueueKind =
	| "repository"
	| "delta-scope"
	| "module"
	| "attack-surface-model"
	| "function"
	| "analysis"
	| "analysis-critic"
	| "verification"
	| "triage";

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

const buildAnalysisFingerprint = (value: unknown) =>
	crypto.createHash("sha1").update(JSON.stringify(value)).digest("hex");

const parseRedisConnection = (url?: string) => {
	if (!url) {
		return {
			host: process.env.REDIS_HOST || "vulseek-redis-dev",
			port: process.env.REDIS_PORT
				? Number.parseInt(process.env.REDIS_PORT, 10)
				: 6379,
		};
	}

	try {
		const parsed = new URL(url);
		return {
			host: parsed.hostname || "vulseek-redis-dev",
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

const scanStageQueueCache = new Map<string, Queue<string>>();

const buildScanStageQueueName = (scanJobId: string, kind: ScanStageQueueKind) =>
	`scan:${scanJobId}:${kind}`;

const buildScanStageGroupQueueName = (
	scanJobId: string,
	groupInstanceId: string,
	kind: ScanStageQueueKind,
) => `scan:${scanJobId}:group:${groupInstanceId}:${kind}`;

const getScanStageQueue = (scanJobId: string, kind: ScanStageQueueKind) => {
	const queueName = buildScanStageQueueName(scanJobId, kind);
	const cached = scanStageQueueCache.get(queueName);
	if (cached) {
		return cached;
	}

	const queue = new Queue<string>(queueName, {
		connection: bullRedisConnection,
	});
	scanStageQueueCache.set(queueName, queue);
	return queue;
};

const getScanStageGroupQueue = (
	scanJobId: string,
	groupInstanceId: string,
	kind: ScanStageQueueKind,
) => {
	const queueName = buildScanStageGroupQueueName(
		scanJobId,
		groupInstanceId,
		kind,
	);
	const cached = scanStageQueueCache.get(queueName);
	if (cached) {
		return cached;
	}

	const queue = new Queue<string>(queueName, {
		connection: bullRedisConnection,
	});
	scanStageQueueCache.set(queueName, queue);
	return queue;
};

const obliterateScanStageGroupQueue = async (
	scanJobId: string,
	groupInstanceId: string,
	kind: ScanStageQueueKind,
) => {
	const queueName = buildScanStageGroupQueueName(
		scanJobId,
		groupInstanceId,
		kind,
	);
	const queue =
		scanStageQueueCache.get(queueName) ||
		new Queue<string>(queueName, {
			connection: bullRedisConnection,
		});
	await queue.obliterate({ force: true }).catch(() => {});
	await queue.close().catch(() => {});
	scanStageQueueCache.delete(queueName);
};

const obliterateScanStageGroupQueues = async (
	scanJobId: string,
	groupInstanceId: string,
) => {
	await Promise.all(
		(
			[
				"repository",
				"delta-scope",
				"module",
				"attack-surface-model",
				"function",
				"analysis",
				"analysis-critic",
				"verification",
				"triage",
			] satisfies ScanStageQueueKind[]
		).map((kind) =>
			obliterateScanStageGroupQueue(scanJobId, groupInstanceId, kind),
		),
	);
};

const taskMatchesStageQueueScope = async (
	task: Pick<Task, "taskId" | "stageGroupInstanceId">,
	groupInstanceId?: string | null,
) => {
	if (groupInstanceId) {
		return task.stageGroupInstanceId === groupInstanceId;
	}
	if (!task.stageGroupInstanceId) {
		return true;
	}
	const group = await findStageGroupInstanceByIdRepo(
		task.stageGroupInstanceId,
	).catch(() => null);
	return group?.leaderTaskId === task.taskId;
};

const getRepositoryScanQueue = (scanJobId: string) =>
	getScanStageQueue(scanJobId, "repository");

const getDeltaScopeQueue = (scanJobId: string) =>
	getScanStageQueue(scanJobId, "repository");

const getModuleScanQueue = (scanJobId: string) =>
	getScanStageQueue(scanJobId, "module");

const getAttackSurfaceModelQueue = (scanJobId: string) =>
	getScanStageQueue(scanJobId, "attack-surface-model");

const getFunctionScanQueue = (scanJobId: string) =>
	getScanStageQueue(scanJobId, "function");

const getAnalysisQueue = (scanJobId: string) =>
	getScanStageQueue(scanJobId, "analysis");

const getAnalysisCriticQueue = (scanJobId: string) =>
	getScanStageQueue(scanJobId, "analysis-critic");

const getVerificationQueue = (scanJobId: string) =>
	getScanStageQueue(scanJobId, "verification");

const getTriageQueue = (scanJobId: string) =>
	getScanStageQueue(scanJobId, "triage");

const stopScanContainer = async (containerName: string | null | undefined) => {
	if (!containerName) {
		return false;
	}

	try {
		await execAsync(`docker rm -f ${containerName}`);
		return true;
	} catch {
		return false;
	}
};

const listDockerContainersForScanJob = async (scanJobId: string) => {
	const scanJobNamePart = sanitizeContainerNamePart(scanJobId);
	if (!scanJobNamePart) {
		return [];
	}
	const { stdout } = await execAsync(
		"docker ps -a --format '{{.Names}}'",
	).catch(() => ({ stdout: "" }));
	return stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((name) => name?.includes(scanJobNamePart));
};

const sleep = async (ms: number) =>
	await new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});

const SANDBOX_AGENT_PROMPT_TIMEOUT_MS = 30 * 60 * 1000;

const extractNamedString = (value: unknown, keys: string[]): string | null => {
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

const asTaskRecord = (value: unknown): Record<string, unknown> | null =>
	value && typeof value === "object"
		? (value as Record<string, unknown>)
		: null;

const readString = (
	record: Record<string, unknown> | null,
	key: string,
): string | null => {
	const value = record?.[key];
	return typeof value === "string" ? value : null;
};

const readNumber = (
	record: Record<string, unknown> | null,
	key: string,
): number | null => {
	const value = record?.[key];
	return typeof value === "number" ? value : null;
};

const readModuleTaskView = (task: Task): UnifiedModuleTaskView | null => {
	if (task.stageName !== SCAN_STAGE_IDS.moduleScan) {
		return null;
	}
	const input = asTaskRecord(task.input);
	const module = asTaskRecord(input?.module);
	const moduleId =
		readString(input, "moduleId") || readString(module, "moduleId");
	const moduleName =
		readString(input, "moduleName") || readString(module, "name");
	if (!moduleId && !moduleName) {
		return null;
	}
	return {
		taskId: task.taskId,
		scanModuleTaskId: task.taskId,
		moduleId: moduleId || task.taskId,
		moduleName: moduleName || task.name,
		status: task.status,
		priority: task.priority ?? 0,
		attempt: task.attempt,
		errorMessage: task.errorMessage ?? null,
		startedAt: task.startedAt ?? null,
		completedAt: task.completedAt ?? null,
		updatedAt: task.updatedAt,
	};
};

const readFunctionTaskView = (task: Task): UnifiedFunctionTaskView | null => {
	if (task.stageName !== SCAN_STAGE_IDS.functionScan) {
		return null;
	}
	const input = asTaskRecord(task.input);
	const func = asTaskRecord(input?.function);
	const target = asTaskRecord(input?.target);
	const functionId =
		readString(input, "targetId") ||
		readString(target, "targetId") ||
		readString(input, "functionId") ||
		readString(func, "functionId");
	const functionName =
		readString(input, "targetName") ||
		readString(target, "targetName") ||
		readString(input, "functionName") ||
		readString(func, "functionName");
	if (!functionId && !functionName) {
		return null;
	}
	const module = asTaskRecord(input?.module);
	return {
		taskId: task.taskId,
		functionTaskId: task.taskId,
		scanModuleTaskId: task.parentTaskId ?? null,
		moduleId:
			readString(input, "moduleId") ||
			readString(target, "moduleId") ||
			readString(func, "moduleId") ||
			readString(module, "moduleId") ||
			task.parentTaskId ||
			task.taskId,
		moduleName:
			readString(input, "moduleName") ||
			readString(target, "moduleName") ||
			readString(func, "moduleName") ||
			readString(module, "name") ||
			"Module",
		functionId: functionId || task.taskId,
		functionName: functionName || task.name,
		filePath:
			readString(input, "filePath") ||
			readString(target, "filePath") ||
			readString(func, "filePath"),
		line:
			readNumber(input, "line") ??
			readNumber(target, "line") ??
			readNumber(func, "line"),
		status: task.status,
		priority: task.priority ?? 0,
		attempt: task.attempt,
		score: readNumber(input, "score") ?? readNumber(func, "score"),
		vulnerabilityType:
			readString(input, "targetKind") ||
			readString(target, "targetKind") ||
			readString(input, "vulnerabilityType") ||
			readString(func, "vulnerabilityType") ||
			readString(func, "riskType"),
		summary: readString(input, "summary") || readString(func, "summary"),
		errorMessage: task.errorMessage ?? null,
		startedAt: task.startedAt ?? null,
		completedAt: task.completedAt ?? null,
		updatedAt: task.updatedAt,
	};
};

const listUnifiedModuleTaskViewsByScanJobId = async (scanJobId: string) =>
	(
		await listTasksByScanJobAndStageRepo({
			scanJobId,
			stageName: SCAN_STAGE_IDS.moduleScan,
		})
	)
		.map(readModuleTaskView)
		.filter((task): task is UnifiedModuleTaskView => Boolean(task));

const listUnifiedFunctionTaskViewsByScanJobId = async (scanJobId: string) =>
	(
		await listTasksByScanJobAndStageRepo({
			scanJobId,
			stageName: SCAN_STAGE_IDS.functionScan,
		})
	)
		.map(readFunctionTaskView)
		.filter((task): task is UnifiedFunctionTaskView => Boolean(task));

const listUnifiedFunctionTaskViewsByModuleTaskId = async (
	moduleTaskId: string,
) =>
	(
		await listChildTasksByParentTaskIdAndStageRepo({
			parentTaskId: moduleTaskId,
			stageName: SCAN_STAGE_IDS.functionScan,
		})
	)
		.map(readFunctionTaskView)
		.filter((task): task is UnifiedFunctionTaskView => Boolean(task));

const formatTaskLocation = (filePath: string | null, line: number | null) => {
	if (!filePath) {
		return null;
	}
	return typeof line === "number" ? `${filePath}:${line}` : filePath;
};

const joinTaskSubtitle = (...parts: Array<string | null | undefined>) =>
	parts
		.filter((part): part is string => Boolean(part && part.length > 0))
		.join(" · ");

const readCandidateRecordFromTaskInput = (
	task: Task,
): Record<string, unknown> | null => {
	const input = asTaskRecord(task.input);
	if (task.stageName === SCAN_STAGE_IDS.analysis) {
		return asTaskRecord(input?.candidate);
	}
	if (task.stageName === SCAN_STAGE_IDS.analysisCritic) {
		return asTaskRecord(input?.candidate);
	}
	if (task.stageName === SCAN_STAGE_IDS.verification) {
		return asTaskRecord(asTaskRecord(input?.analysisResult)?.candidate);
	}
	if (task.stageName === SCAN_STAGE_IDS.triage) {
		return asTaskRecord(input?.candidate);
	}
	return null;
};

const buildInProgressTaskView = (task: Task): InProgressTaskView | null => {
	const input = asTaskRecord(task.input);
	switch (task.stageName) {
		case SCAN_STAGE_IDS.deltaScope:
			return {
				id: `delta-scope-${task.taskId}`,
				taskId: task.taskId,
				title: "Delta Scope",
				subtitle: "Diff impact function scoping",
				stage: "delta_scoping",
				startedAt: task.startedAt,
				updatedAt: task.updatedAt,
			};
		case SCAN_STAGE_IDS.repositoryScan:
			return {
				id: `repository-${task.taskId}`,
				taskId: task.taskId,
				title: "Repository Scanner",
				subtitle: "Repository-wide planner and module partitioning",
				stage: "repository_scanning",
				startedAt: task.startedAt,
				updatedAt: task.updatedAt,
			};
		case SCAN_STAGE_IDS.attackSurfaceModel:
			return {
				id: `attack-surface-model-${task.taskId}`,
				taskId: task.taskId,
				title: readString(input, "moduleName") || task.name,
				subtitle: readString(input, "moduleId") || "-",
				stage: "attack_surface_modeling",
				startedAt: task.startedAt,
				updatedAt: task.updatedAt,
			};
		case SCAN_STAGE_IDS.moduleScan: {
			const module = asTaskRecord(input?.module);
			return {
				id: `module-${task.taskId}`,
				taskId: task.taskId,
				title:
					readString(input, "moduleName") ||
					readString(module, "name") ||
					task.name,
				subtitle:
					readString(input, "moduleId") ||
					readString(module, "moduleId") ||
					"-",
				stage: "module_scanning",
				startedAt: task.startedAt,
				updatedAt: task.updatedAt,
			};
		}
		case SCAN_STAGE_IDS.functionScan: {
			const func = asTaskRecord(input?.function);
			const target = asTaskRecord(input?.target);
			const module = asTaskRecord(input?.module);
			return {
				id: `function-${task.taskId}`,
				taskId: task.taskId,
				title:
					readString(input, "targetName") ||
					readString(input, "targetId") ||
					readString(target, "targetName") ||
					readString(target, "targetId") ||
					readString(input, "functionName") ||
					readString(input, "functionId") ||
					readString(func, "functionName") ||
					readString(func, "functionId") ||
					task.name,
				subtitle:
					joinTaskSubtitle(
						readString(input, "moduleName") ||
							readString(module, "name") ||
							readString(target, "moduleName") ||
							readString(func, "moduleName"),
						formatTaskLocation(
							readString(input, "filePath") ||
								readString(target, "filePath") ||
								readString(func, "filePath"),
							readNumber(input, "line") ??
								readNumber(target, "line") ??
								readNumber(func, "line"),
						),
					) || "-",
				stage: "function_scanning",
				startedAt: task.startedAt,
				updatedAt: task.updatedAt,
			};
		}
		case SCAN_STAGE_IDS.analysis: {
			const candidate = readCandidateRecordFromTaskInput(task);
			return {
				id: `analysis-${task.taskId}`,
				taskId: task.taskId,
				title: readString(candidate, "title") || task.name,
				subtitle:
					joinTaskSubtitle(
						formatTaskLocation(
							readString(candidate, "filePath"),
							readNumber(candidate, "line"),
						),
						readString(candidate, "vulnerabilityType"),
					) || "-",
				stage: "analyzing",
				startedAt: task.startedAt,
				updatedAt: task.updatedAt,
			};
		}
		case SCAN_STAGE_IDS.analysisCritic: {
			const candidate = readCandidateRecordFromTaskInput(task);
			return {
				id: `analysis-critic-${task.taskId}`,
				taskId: task.taskId,
				title: readString(candidate, "title") || task.name,
				subtitle:
					joinTaskSubtitle(
						formatTaskLocation(
							readString(candidate, "filePath"),
							readNumber(candidate, "line"),
						),
						readString(candidate, "vulnerabilityType"),
					) || "-",
				stage: "criticizing",
				startedAt: task.startedAt,
				updatedAt: task.updatedAt,
			};
		}
		case SCAN_STAGE_IDS.verification: {
			const candidate = readCandidateRecordFromTaskInput(task);
			return {
				id: `verification-${task.taskId}`,
				taskId: task.taskId,
				title: readString(candidate, "title") || task.name,
				subtitle:
					joinTaskSubtitle(
						formatTaskLocation(
							readString(candidate, "filePath"),
							readNumber(candidate, "line"),
						),
						readString(candidate, "vulnerabilityType"),
					) || "-",
				stage: "verifying",
				startedAt: task.startedAt,
				updatedAt: task.updatedAt,
			};
		}
		case SCAN_STAGE_IDS.triage: {
			const candidate = readCandidateRecordFromTaskInput(task);
			return {
				id: `triage-${task.taskId}`,
				taskId: task.taskId,
				title: readString(candidate, "title") || task.name,
				subtitle:
					joinTaskSubtitle(
						formatTaskLocation(
							readString(candidate, "filePath"),
							readNumber(candidate, "line"),
						),
						readString(candidate, "vulnerabilityType"),
					) || "-",
				stage: "triaging",
				startedAt: task.startedAt,
				updatedAt: task.updatedAt,
			};
		}
		default:
			return null;
	}
};

const buildTerminalTaskView = (task: Task): TerminalTaskView | null => {
	const status = task.status as string;
	if (
		status !== "completed" &&
		status !== "failed" &&
		status !== "canceled" &&
		status !== "exited"
	) {
		return null;
	}
	const baseTask = buildInProgressTaskView(task);
	if (!baseTask) {
		return null;
	}
	return {
		...baseTask,
		status: status as TerminalTaskView["status"],
		completedAt: task.completedAt,
		errorMessage: task.errorMessage,
	};
};

const listQueuePendingCountsByScanJobId = async (
	scanJobId: string,
	taskStatusCounts: Array<{
		stageName: Task["stageName"];
		status: Task["status"];
		count: number;
	}>,
	concurrencyLimitByStageName = new Map<Task["stageName"], number>(),
	stageNames?: Array<string>,
): Promise<QueuePendingCountView[]> => {
	const activeStageGroups = (
		await listStageGroupInstancesByScanJobIdRepo(scanJobId).catch(() => [])
	).filter((group) => group.status === "active");
	const allowedStageNames = stageNames ? new Set(stageNames) : null;
	const hasDeltaScopeRoot = taskStatusCounts.some(
		(row) => row.stageName === SCAN_STAGE_IDS.deltaScope,
	);
	const queueEntries: Array<{
		id: ScanStageQueueKind;
		title: string;
		stageName: Task["stageName"];
		queue: Queue<string>;
	}> = [
		hasDeltaScopeRoot
			? {
					id: "delta-scope",
					title: SCAN_STAGE_METADATA.deltaScope.name,
					stageName: SCAN_STAGE_IDS.deltaScope,
					queue: getDeltaScopeQueue(scanJobId),
				}
			: {
					id: "repository",
					title: SCAN_STAGE_METADATA.repositoryScan.name,
					stageName: SCAN_STAGE_IDS.repositoryScan,
					queue: getRepositoryScanQueue(scanJobId),
		},
		{
			id: "attack-surface-model",
			title: SCAN_STAGE_METADATA.attackSurfaceModel.name,
			stageName: SCAN_STAGE_IDS.attackSurfaceModel,
			queue: getAttackSurfaceModelQueue(scanJobId),
		},
		{
			id: "module",
			title: SCAN_STAGE_METADATA.moduleScan.name,
			stageName: SCAN_STAGE_IDS.moduleScan,
			queue: getModuleScanQueue(scanJobId),
		},
		{
			id: "function",
			title: SCAN_STAGE_METADATA.functionScan.name,
			stageName: SCAN_STAGE_IDS.functionScan,
			queue: getFunctionScanQueue(scanJobId),
		},
		{
			id: "analysis",
			title: SCAN_STAGE_METADATA.analysis.name,
			stageName: SCAN_STAGE_IDS.analysis,
			queue: getAnalysisQueue(scanJobId),
		},
		{
			id: "analysis-critic",
			title: SCAN_STAGE_METADATA.analysisCritic.name,
			stageName: SCAN_STAGE_IDS.analysisCritic,
			queue: getAnalysisCriticQueue(scanJobId),
		},
		{
			id: "verification",
			title: SCAN_STAGE_METADATA.verification.name,
			stageName: SCAN_STAGE_IDS.verification,
			queue: getVerificationQueue(scanJobId),
		},
		{
			id: "triage",
			title: SCAN_STAGE_METADATA.triage.name,
			stageName: SCAN_STAGE_IDS.triage,
			queue: getTriageQueue(scanJobId),
		},
	];

	const visibleQueueEntries = allowedStageNames
		? queueEntries.filter((entry) => allowedStageNames.has(entry.stageName))
		: queueEntries;

	return await Promise.all(
		visibleQueueEntries.map(async ({ id, title, stageName, queue }) => {
			const readCounts = async (targetQueue: Queue<string>) =>
				await targetQueue
					.getJobCounts("waiting", "prioritized", "delayed")
					.catch((error) => {
						console.warn(
							"[scan-status-view]",
							JSON.stringify({
								event: "queueCounts.readFailed",
								scanJobId,
								queueName: targetQueue.name,
								error: error instanceof Error ? error.message : String(error),
							}),
						);
						return {
							waiting: 0,
							prioritized: 0,
							delayed: 0,
						};
					});
			const counts = await readCounts(queue);
			const groupCounts = await Promise.all(
				activeStageGroups.map((group) =>
					readCounts(
						getScanStageGroupQueue(scanJobId, group.groupInstanceId, id),
					),
				),
			);
			const stageCounts = taskStatusCounts.filter(
				(row) => row.stageName === stageName,
			);
			const getStatusCount = (status: Task["status"]) =>
				stageCounts.find((row) => row.status === status)?.count ?? 0;
			const queuedCount = getStatusCount("pending");
			const launchingCount = getStatusCount("launching");
			const launchedCount = getStatusCount("launched");
			const startingCount = getStatusCount("starting");
			const waitingCount =
				(counts.waiting || 0) +
				(counts.prioritized || 0) +
				(counts.delayed || 0) +
				groupCounts.reduce(
					(total, item) =>
						total +
						(item.waiting || 0) +
						(item.prioritized || 0) +
						(item.delayed || 0),
					0,
				);
			return {
				id,
				title,
				stageName,
				queueName: queue.name,
				concurrencyLimit: Math.max(
					1,
					concurrencyLimitByStageName.get(stageName) ?? 1,
				),
				waitingCount,
				queuedCount,
				launchingCount,
				launchedCount,
				startingCount,
				runningCount: getStatusCount("running"),
				completedCount: getStatusCount("completed"),
				failedCount: getStatusCount("failed"),
				exitedCount: getStatusCount("exited"),
				canceledCount: getStatusCount("canceled"),
				totalCount: stageCounts.reduce((total, row) => total + row.count, 0),
				pendingCount: queuedCount,
			};
		}),
	);
};

export const retryFailedScanJobTasks = async (scanJobId: string) =>
	await retryFailedScanJobTasksWithDeps(scanJobId, {
		loadScanJob: findScanJobByIdRepo,
		listTasks: listTasksByScanJobIdRepo,
		removeQueuedTask: removeQueuedTaskForRetry,
		clearTaskArtifacts: clearTaskArtifactsForRetry,
		resetFailedTask: resetFailedTaskForRetryRepo,
		enqueueTask: enqueueRetriedTask,
		recalculateScanTaskCounts: recalculateScanTaskCountsRepo,
		resetScanJobForRetry: async (input) =>
			await resetScanJobForRetryRepo(input.scanJobId, {
				status: "pending",
				errorMessage: null,
			}),
	});

const RERUNNABLE_TASK_STATUSES = new Set<Task["status"]>([
	"completed",
	"failed",
	"exited",
	"canceled",
]);

const RERUNNABLE_TASK_STAGE_NAMES = new Set<Task["stageName"]>([
	SCAN_STAGE_IDS.deltaScope,
	SCAN_STAGE_IDS.repositoryScan,
	SCAN_STAGE_IDS.moduleScan,
	SCAN_STAGE_IDS.functionScan,
	SCAN_STAGE_IDS.analysis,
	SCAN_STAGE_IDS.analysisCritic,
	SCAN_STAGE_IDS.verification,
	SCAN_STAGE_IDS.triage,
]);

const getTaskHostDir = (input: {
	projectProfileHostContextRoot: string;
	task: Task;
}) =>
	path.join(
		input.projectProfileHostContextRoot,
		"jobs",
		input.task.scanJobId,
		resolveTaskRootSegment(
			input.task.stageName,
			input.task.name,
			input.task.taskId,
		),
	);

const taskHasInputsDir = async (taskDir: string) => {
	const stat = await fs.stat(path.join(taskDir, "inputs")).catch(() => null);
	return stat?.isDirectory() ?? false;
};

const getRerunBaseTaskName = (name: string) =>
	name.replace(/(?: \(rerun\))+$/, "");

const findRerunSourceTaskWithInputs = async (input: {
	projectProfileHostContextRoot: string;
	originalTask: Task;
}) => {
	const originalTaskDir = getTaskHostDir({
		projectProfileHostContextRoot: input.projectProfileHostContextRoot,
		task: input.originalTask,
	});
	if (await taskHasInputsDir(originalTaskDir)) {
		return input.originalTask;
	}

	const baseName = getRerunBaseTaskName(input.originalTask.name);
	const tasks = await listTasksByScanJobIdRepo(input.originalTask.scanJobId);
	for (const task of tasks) {
		if (task.taskId === input.originalTask.taskId) {
			continue;
		}
		if (task.stageName !== input.originalTask.stageName) {
			continue;
		}
		if (task.parentTaskId !== input.originalTask.parentTaskId) {
			continue;
		}
		if (getRerunBaseTaskName(task.name) !== baseName) {
			continue;
		}
		if (task.createdAt > input.originalTask.createdAt) {
			continue;
		}

		const taskDir = getTaskHostDir({
			projectProfileHostContextRoot: input.projectProfileHostContextRoot,
			task,
		});
		if (await taskHasInputsDir(taskDir)) {
			return task;
		}
	}

	return null;
};

const copyTaskInputsForRerun = async (input: {
	scanJob: Awaited<ReturnType<typeof findScanJobByIdRepo>>;
	originalTask: Task;
	rerunTask: Task;
}) => {
	const projectProfileHostContextRoot =
		await resolveRequiredProjectProfileHostContextRootByScanJob(input.scanJob);
	const sourceTask = await findRerunSourceTaskWithInputs({
		projectProfileHostContextRoot,
		originalTask: input.originalTask,
	});
	if (!sourceTask) {
		return;
	}

	const sourceTaskDir = getTaskHostDir({
		projectProfileHostContextRoot,
		task: sourceTask,
	});
	const rerunTaskDir = getTaskHostDir({
		projectProfileHostContextRoot,
		task: input.rerunTask,
	});
	const sourceInputsDir = path.join(sourceTaskDir, "inputs");
	const rerunInputsDir = path.join(rerunTaskDir, "inputs");

	await fs.rm(rerunInputsDir, { recursive: true, force: true }).catch(() => {});
	await fs.mkdir(rerunTaskDir, { recursive: true });
	await fs.cp(sourceInputsDir, rerunInputsDir, {
		recursive: true,
		force: true,
	});
};

export const rerunScanTask = async (taskId: string) => {
	const originalTask = await findTaskByIdRepo(taskId);
	const scanJob = await findScanJobByIdRepo(originalTask.scanJobId);
	if (scanJob.scanType !== "full") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Task rerun is only supported for full scan jobs",
		});
	}
	if (!RERUNNABLE_TASK_STATUSES.has(originalTask.status)) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Only completed, failed, exited, or canceled tasks can be rerun",
		});
	}
	if (!RERUNNABLE_TASK_STAGE_NAMES.has(originalTask.stageName)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Task stage is not rerunnable: ${originalTask.stageName}`,
		});
	}

	const task = await createTaskRepo({
		taskId: createShortTaskId(),
		scanJobId: originalTask.scanJobId,
		parentTaskId: originalTask.parentTaskId,
		name: `${originalTask.name} (rerun)`,
		stageName: originalTask.stageName,
		priority: originalTask.priority,
		input: originalTask.input,
		runtimeMode: originalTask.runtimeMode,
		forkedFromTaskId: originalTask.forkedFromTaskId,
		forkedFromThreadId: originalTask.forkedFromThreadId,
	});

	await copyTaskInputsForRerun({ scanJob, originalTask, rerunTask: task });
	await enqueueRetriedTask(task.scanJobId, task);
	if (scanJob.status === "finished" || scanJob.status === "canceled") {
		await resetScanJobForRetryRepo(scanJob.scanJobId, {
			status: "pending",
			errorMessage: null,
		}).catch(() => {});
	}
	await recalculateScanTaskCountsRepo(scanJob.scanJobId).catch(() => {});

	return {
		originalTaskId: originalTask.taskId,
		task,
	};
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
	if (provider === "github")
		return `https://github.com/${owner}/${cleanedRepo}.git`;
	if (provider === "gitlab")
		return `https://gitlab.com/${owner}/${cleanedRepo}.git`;
	if (provider === "bitbucket")
		return `https://bitbucket.org/${owner}/${cleanedRepo}.git`;
	return `https://${giteaHost || "gitea.local"}/${owner}/${cleanedRepo}.git`;
};

const isUrlLike = (value?: string | null) =>
	Boolean(value && /^(https?:\/\/|git@)/.test(value));

const resolveDockerfileAssetPath = async (fileName: string) => {
	const candidates = [
		path.resolve(
			process.cwd(),
			"packages/server/src/services/dockerfiles",
			fileName,
		),
		path.resolve(
			process.cwd(),
			"packages/server/dist/services/dockerfiles",
			fileName,
		),
		path.resolve(
			process.cwd(),
			"../../packages/server/src/services/dockerfiles",
			fileName,
		),
		path.resolve(
			process.cwd(),
			"../../packages/server/dist/services/dockerfiles",
			fileName,
		),
		path.join("/app/packages/server/src/services/dockerfiles", fileName),
		path.resolve(
			process.cwd(),
			"node_modules/@vulseek/server/src/services/dockerfiles",
			fileName,
		),
		path.resolve(
			process.cwd(),
			"node_modules/@vulseek/server/dist/services/dockerfiles",
			fileName,
		),
		path.join(
			"/app/node_modules/@vulseek/server/src/services/dockerfiles",
			fileName,
		),
		path.join(
			"/app/node_modules/@vulseek/server/dist/services/dockerfiles",
			fileName,
		),
	];

	for (const candidate of candidates) {
		try {
			const stat = await fs.stat(candidate);
			if (stat.isFile()) {
				return candidate;
			}
		} catch {}
	}

	throw new Error(`Unable to locate ${fileName}`);
};

const resolveScanDockerfileTemplatePath = async () => {
	return await resolveDockerfileAssetPath("Dockerfile.scan.template");
};

const buildScanDockerfileTemplate = async () => {
	const templatePath = await resolveScanDockerfileTemplatePath();
	return await fs.readFile(templatePath, "utf-8");
};

const resolveSandboxAgentPatchPath = async () => {
	return await resolveDockerfileAssetPath("sandbox-agent@0.4.2.patch");
};

const resolveCodexAcpForkPatchPath = async () => {
	return await resolveDockerfileAssetPath("codex-acp-fork-0.14.0.patch");
};

type CheckoutStatus = "running" | "completed" | "failed";

type CheckoutTask = {
	checkoutId: string;
	status: CheckoutStatus;
	imageTag: string;
	gitUrl: string;
	gitBranch: string;
	gitTag: string;
	enableSubmodules: boolean;
	postCheckoutScript: string;
	dockerfileTemplate: string;
	localPath?: string | null;
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

const resolveCheckoutDockerBuildResourceOptions = () => {
	const dockerBuildkit = process.env.DOCKER_BUILDKIT?.trim() || "1";
	const memory = process.env.VULSEEK_SCAN_CHECKOUT_BUILD_MEMORY?.trim() || "";
	const memorySwap =
		process.env.VULSEEK_SCAN_CHECKOUT_BUILD_MEMORY_SWAP?.trim() || "";
	const env = {
		...process.env,
		DOCKER_BUILDKIT: dockerBuildkit,
	};

	if (!memory || dockerBuildkit !== "0") {
		const logMessage =
			memory && dockerBuildkit !== "0"
				? `[checkout] memory limit requested but ignored because DOCKER_BUILDKIT=${dockerBuildkit || "<unset>"}; set DOCKER_BUILDKIT=0 to use --memory with the legacy docker builder\n`
				: null;
		return {
			args: [] as string[],
			env,
			logMessage,
		};
	}

	const args = ["--memory", memory];
	if (memorySwap) {
		args.push("--memory-swap", memorySwap);
	}

	return {
		args,
		env,
		logMessage:
			`[checkout] using DOCKER_BUILDKIT=0 with memory limit ${memory}` +
			(memorySwap ? ` and memory-swap ${memorySwap}` : "") +
			"\n",
	};
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
	let gitTag = "";
	let enableSubmodules = false;
	let postCheckoutScript = "";
	let imageNameSeed = "scan";
	let localPath: string | null = null;

	if (input.applicationId) {
		const application = await findApplicationById(input.applicationId);
		imageNameSeed =
			application.appName || application.name || application.applicationId;
		enableSubmodules = application.enableSubmodules ?? false;
		postCheckoutScript = application.postCheckoutScript || "";
		gitTag = application.targetTag?.trim() || "";
		switch (application.sourceType) {
			case "git":
				gitUrl = application.customGitUrl || "<GIT_URL>";
				gitBranch = application.customGitBranch || "main";
				break;
			case "github":
				gitUrl =
					(isUrlLike(application.repository)
						? application.repository
						: undefined) ||
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
			case "local":
				localPath = application.localPath || null;
				gitUrl = "";
				gitBranch = "";
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
					(isUrlLike(compose.gitlabRepository)
						? compose.gitlabRepository
						: undefined) ||
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
					(isUrlLike(compose.giteaRepository)
						? compose.giteaRepository
						: undefined) ||
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
		gitTag,
		enableSubmodules,
		postCheckoutScript,
		localPath,
	};
};

const resolveCheckoutContext = async (
	input: typeof apiCheckoutScanEnvironment._type,
) => {
	const dockerfileTemplate = await buildScanDockerfileTemplate();
	const {
		imageNameSeed,
		gitUrl,
		gitBranch,
		gitTag,
		enableSubmodules,
		postCheckoutScript,
		localPath,
	} =
		await resolveScanGitRepositoryContext(input);

	const imageTag = `vulseek-scan-${sanitizeForImageTag(imageNameSeed)}:latest`;
	return {
		imageTag,
		gitUrl,
		gitBranch,
		gitTag,
		enableSubmodules,
		postCheckoutScript,
		localPath,
		dockerfileTemplate,
	};
};

const runDockerBuildInBackground = async (task: CheckoutTask) => {
	const tempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "vulseek-scan-checkout-"),
	);
	const dockerfilePath = path.join(tempDir, "Dockerfile.scan");
	const tempAgentsPath = path.join(tempDir, "agents");
	const tempSandboxAgentPatchPath = path.join(
		tempDir,
		"sandbox-agent@0.4.2.patch",
	);
	const tempCodexAcpForkPatchPath = path.join(
		tempDir,
		"codex-acp-fork-0.14.0.patch",
	);
	const isLocalPath = !!task.localPath;
	const args = [
		"build",
		"--progress=plain",
		"-f",
		dockerfilePath,
		"-t",
		task.imageTag,
		...(isLocalPath
			? ["--build-arg", `POST_CHECKOUT_SCRIPT=${task.postCheckoutScript}`]
			: [
					"--build-arg",
					`GIT_URL=${task.gitUrl}`,
					"--build-arg",
					`GIT_BRANCH=${task.gitBranch}`,
					"--build-arg",
					`ENABLE_SUBMODULES=${task.enableSubmodules ? "true" : "false"}`,
					"--build-arg",
					`POST_CHECKOUT_SCRIPT=${task.postCheckoutScript}`,
				]),
	];
	const containerBuildArgs = getGlobalContainerEnvironmentPairs();
	for (const pair of containerBuildArgs) {
		args.push("--build-arg", pair);
	}
	args.push(tempDir);

	try {
		const buildResourceOptions = resolveCheckoutDockerBuildResourceOptions();
		if (task.postCheckoutScript.trim()) {
			const latest = checkoutTasks.get(task.checkoutId);
			if (latest) {
				latest.stderr = appendLog(
					latest.stderr,
					"[checkout] post-checkout script configured\n",
				);
			}
		}
		if (buildResourceOptions.args.length > 0) {
			args.splice(args.length - 1, 0, ...buildResourceOptions.args);
			const latest = checkoutTasks.get(task.checkoutId);
			if (latest && buildResourceOptions.logMessage) {
				latest.stderr = appendLog(
					latest.stderr,
					buildResourceOptions.logMessage,
				);
			}
		}
		const agentsDir = await resolveAgentsDirectory();
		await fs.mkdir(tempAgentsPath, { recursive: true });
		if (agentsDir) {
			await fs.cp(agentsDir, tempAgentsPath, { recursive: true });
		}
		await fs.copyFile(
			await resolveSandboxAgentPatchPath(),
			tempSandboxAgentPatchPath,
		);
		await fs.copyFile(
			await resolveCodexAcpForkPatchPath(),
			tempCodexAcpForkPatchPath,
		);

		let dockerfileContent = task.dockerfileTemplate;
		if (isLocalPath && task.localPath) {
			// Pre-copy the local directory into tempDir/repo so it's in the build context
			const repoDir = path.join(tempDir, "repo");
			await fs.cp(task.localPath, repoDir, { recursive: true });

			// Replace the repository-source stage to use COPY instead of git clone
			const localRepositorySourceStage = `FROM ubuntu:24.04 AS repository-source

ARG POST_CHECKOUT_SCRIPT=""

WORKDIR /workspace

COPY repo /workspace/repo

RUN if [ -n "\${POST_CHECKOUT_SCRIPT}" ]; then \\
      cd /workspace/repo; \\
      printf '%s\\n' "\${POST_CHECKOUT_SCRIPT}" > /tmp/vulseek-post-checkout.sh; \\
      bash /tmp/vulseek-post-checkout.sh; \\
      rm -f /tmp/vulseek-post-checkout.sh; \\
    fi`;

			// Replace everything from "FROM ubuntu:24.04 AS repository-source" up to the next "FROM"
			dockerfileContent = dockerfileContent.replace(
				/FROM ubuntu:24\.04 AS repository-source[\s\S]*?(?=FROM )/,
				`${localRepositorySourceStage}\n\n`,
			);
		}
		await fs.writeFile(dockerfilePath, dockerfileContent, "utf-8");
		await new Promise<void>((resolve, reject) => {
			const child = spawn("docker", args, {
				stdio: ["ignore", "pipe", "pipe"],
				env: buildResourceOptions.env,
			});
			child.stdout.on("data", (chunk) => {
				const text = chunk.toString();
				const latestTask = checkoutTasks.get(task.checkoutId);
				if (!latestTask) return;
				latestTask.stdout = appendLog(latestTask.stdout, text);
			});
			child.stderr.on("data", (chunk) => {
				const text = chunk.toString();
				const latestTask = checkoutTasks.get(task.checkoutId);
				if (!latestTask) return;
				latestTask.stderr = appendLog(latestTask.stderr, text);
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

		if (task.localPath) {
			// Populate /workspace/repo from host path via docker run.
			// The host Docker daemon can bind-mount host paths directly.
			const tempName = `vulseek-local-${task.checkoutId.replace(/[^a-z0-9]/g, "-").slice(0, 40)}`;
			const appendToTask = (text: string) => {
				const t = checkoutTasks.get(task.checkoutId);
				if (t) t.stderr = appendLog(t.stderr, text);
			};
			appendToTask("[checkout] copying local repo into image via docker run...\n");
			try {
					await execAsyncStream(
						`docker run --name ${tempName} -v ${task.localPath}:/tmp/localrepo:ro ${task.imageTag} bash -c "` +
							"cp -a /tmp/localrepo/. /workspace/repo/ && " +
							"cd /workspace/repo && " +
							"git config --global --add safe.directory /workspace/repo && " +
							"if [ ! -d .git ]; then " +
							"  git init && " +
							`  git config user.email 'local@vulseek' && ` +
							`  git config user.name 'Local Source' && ` +
							"  git add -A && " +
							`  git commit -m 'local source snapshot' --allow-empty; ` +
							"fi && " +
							`echo '[checkout] local copy complete'"`,
						appendToTask,
					);
				appendToTask("[checkout] committing image...\n");
				await execAsyncStream(
					`docker commit ${tempName} ${task.imageTag}`,
					appendToTask,
				);
			} finally {
				await execAsync(`docker rm -f ${tempName}`).catch(() => {});
			}
		}

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
		gitTag: context.gitTag,
		enableSubmodules: context.enableSubmodules,
		postCheckoutScript: context.postCheckoutScript,
		localPath: context.localPath,
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
		gitTag: task.gitTag,
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

const CODEX_AUTO_APPROVE_CONFIG_TOML = [
	`approval_policy = "never"`,
	`sandbox_mode = "danger-full-access"`,
	"",
].join("\n");
const resolveCodexAuthMode = (
	agentProfile: AgentProfileLike | null | undefined,
) => (agentProfile?.authMode === "host_home" ? "host_home" : "api_key");

const resolveCodexHomeHostPath = (
	agentProfile: AgentProfileLike | null | undefined,
) => agentProfile?.homePath?.trim() || "";

const REVIEW_CONTAINER_HOST_CODEX_HOME = "/host-codex-home";

const buildReviewContainerCodexHomeMountArg = (
	agentProfile: AgentProfileLike | null | undefined,
) => {
	if (!agentProfile) {
		return "";
	}
	if (resolveCodexAuthMode(agentProfile) !== "host_home") {
		return "";
	}
	const hostPath = resolveCodexHomeHostPath(agentProfile);
	if (!hostPath) {
		return "";
	}
	return `-v '${escapeSingleQuotes(hostPath)}:${REVIEW_CONTAINER_HOST_CODEX_HOME}:ro'`;
};

const withCodexAutoApproveConfigToml = (configToml: string) => {
	const defaults: string[] = [];
	if (!/^\s*approval_policy\s*=/m.test(configToml)) {
		defaults.push(`approval_policy = "never"`);
	}
	if (!/^\s*sandbox_mode\s*=/m.test(configToml)) {
		defaults.push(`sandbox_mode = "danger-full-access"`);
	}
	if (defaults.length === 0) {
		return configToml;
	}
	return joinTomlBlocks(`${defaults.join("\n")}\n`, configToml);
};

const stripProfileControlledCodexConfigToml = (configToml: string) => {
	let seenTable = false;
	return configToml
		.split(/\r?\n/)
		.filter((line) => {
			const trimmed = line.trim();
			if (/^\[.*\]\s*$/.test(trimmed)) {
				seenTable = true;
			}
			return (
				seenTable ||
				!/^\s*(approval_policy|sandbox_mode|model|model_reasoning_effort)\s*=/.test(
					line,
				)
			);
		})
		.join("\n");
};

const withCodexProfileRuntimeConfig = (
	configToml: string,
	agentProfile: AgentProfileLike,
) => {
	const profileConfig = [
		`approval_policy = "never"`,
		`sandbox_mode = "danger-full-access"`,
		`model = "${agentProfile.model}"`,
		...(agentProfile.thinkingLevelEnabled
			? [`model_reasoning_effort = "${agentProfile.thinkingLevel}"`]
			: []),
	].join("\n");

	return joinTomlBlocks(
		profileConfig,
		stripProfileControlledCodexConfigToml(configToml),
	);
};

const buildCodexConfigToml = (agentProfile: AgentProfileLike) => {
	const providerName = sanitizeProviderName(agentProfile.agentProfileId);
	const reasoningConfig = agentProfile.thinkingLevelEnabled
		? [`model_reasoning_effort = "${agentProfile.thinkingLevel}"`]
		: [];

	return withCodexAutoApproveConfigToml(
		[
			`model = "${agentProfile.model}"`,
			...reasoningConfig,
			`model_provider = "${providerName}"`,
			`preferred_auth_method = "apikey"`,
			"",
			`[model_providers.${providerName}]`,
			`name = "${providerName}"`,
			`base_url = "${agentProfile.baseUrl}"`,
			`wire_api = "responses"`,
			"",
		].join("\n"),
	);
};

const withTrustedReviewWorkspaceConfig = (configToml: string) =>
	joinTomlBlocks(
		configToml,
		`[projects."/workspace/review"]\ntrust_level = "trusted"`,
	);

const loadCodexMcpConfigToml = async (agentsDir: string | null) => {
	if (!agentsDir) {
		return "";
	}

	const mcpDir = path.join(agentsDir, "mcp");
	try {
		const entries = await fs.readdir(mcpDir, { withFileTypes: true });
		const tomlFiles = entries
			.filter(
				(entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".toml"),
			)
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

const parseAgentProfileEnvPairs = (agentProfile: AgentProfileLike) =>
	(agentProfile.envs || "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.flatMap((line) => {
			const separatorIndex = line.indexOf("=");
			if (separatorIndex <= 0) {
				return [];
			}
			const key = line.slice(0, separatorIndex).trim();
			const value = line.slice(separatorIndex + 1);
			if (!key) {
				return [];
			}
			return [`${key}=${value}`];
		});

const buildClaudeEnvPairs = (agentProfile: AgentProfileLike) => {
	const envPairs = [
		...(resolveCodexAuthMode(agentProfile) === "api_key"
			? [
					`ANTHROPIC_BASE_URL=${agentProfile.baseUrl}`,
					`ANTHROPIC_API_KEY=${agentProfile.apiKey}`,
					`ANTHROPIC_AUTH_TOKEN=${agentProfile.apiKey}`,
				]
			: []),
			`ANTHROPIC_MODEL=${agentProfile.model}`,
			`ANTHROPIC_DEFAULT_SONNET_MODEL=${agentProfile.model}`,
			`ANTHROPIC_DEFAULT_OPUS_MODEL=${agentProfile.model}`,
			`ANTHROPIC_DEFAULT_HAIKU_MODEL=${agentProfile.model}`,
			"CLAUDE_CODE_ENTRYPOINT=vulseek",
			...parseAgentProfileEnvPairs(agentProfile),
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

const resolveScanExecutionContext = async (scanJob: ScanJob) => {
	const isApplicationJob = Boolean(scanJob.applicationId);
	const target = isApplicationJob
		? await findApplicationById(scanJob.applicationId as string)
		: await findComposeById(scanJob.composeId as string);
	const repositoryScanAgentProfileId =
		target.scanStageSettings?.[SCAN_STAGE_IDS.repositoryScan]?.agentProfileId ||
		null;
	const scanAgentProfile = repositoryScanAgentProfileId
		? await getAgentProfileById(repositoryScanAgentProfileId).catch(() => null)
		: null;

	const appName = target.appName;
	const imageTag = toImageTagFromAppName(appName);
	const projectName = target.environment.project.name;
	const serviceName = target.name || target.appName;
	const projectProfileContextRoot = buildProjectProfileContextRoot();
	const projectProfileCacheRoot = buildProjectProfileCacheRoot();

	const configuredHostRoot = resolveConfiguredScanContextHostPath();
	if (!configuredHostRoot) {
		throw new Error(
			"Scan context host path is not configured. Restart vulseek-dev from dev.sh so /scan-context is mounted.",
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
		scanAgentProfile,
	};
};

const copyCodexAssetsToContainerHome = async (
	containerName: string,
	codexHome: string,
	agentsDir: string | null,
	agentProfile?: AgentProfileLike | null,
) => {
	const mcpConfigToml = await loadCodexMcpConfigToml(agentsDir);

	if (agentProfile) {
		if (agentProfile.provider === "codex") {
			if (resolveCodexAuthMode(agentProfile) === "host_home") {
				const hostPath = resolveCodexHomeHostPath(agentProfile);
				if (!hostPath) {
					throw new Error(
						"Codex host home auth mode is enabled but no home path was configured on the agent profile.",
					);
				}
				const { stdout: sourceConfigToml } = await execAsync(
					`docker exec ${containerName} bash -lc "cat '${REVIEW_CONTAINER_HOST_CODEX_HOME}/config.toml' 2>/dev/null || true"`,
				);
				await execAsync(
					`docker exec ${containerName} bash -lc "mkdir -p '${codexHome}' && cp -a '${REVIEW_CONTAINER_HOST_CODEX_HOME}/.' '${codexHome}/'"`,
				);
				await writeContainerFile(
					containerName,
					`${codexHome}/config.toml`,
					withTrustedReviewWorkspaceConfig(
						joinTomlBlocks(
							withCodexProfileRuntimeConfig(sourceConfigToml, agentProfile),
							mcpConfigToml,
						),
					),
				);
				return;
			}
			await writeContainerFile(
				containerName,
				`${codexHome}/config.toml`,
				withTrustedReviewWorkspaceConfig(
					joinTomlBlocks(buildCodexConfigToml(agentProfile), mcpConfigToml),
				),
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
			withTrustedReviewWorkspaceConfig(
				joinTomlBlocks(
					withCodexAutoApproveConfigToml(baseConfigToml),
					mcpConfigToml,
				),
			),
		);
	} catch {
		if (mcpConfigToml) {
			await writeContainerFile(
				containerName,
				`${codexHome}/config.toml`,
				withTrustedReviewWorkspaceConfig(
					joinTomlBlocks(CODEX_AUTO_APPROVE_CONFIG_TOML, mcpConfigToml),
				),
			);
		} else {
			await writeContainerFile(
				containerName,
				`${codexHome}/config.toml`,
				withTrustedReviewWorkspaceConfig(CODEX_AUTO_APPROVE_CONFIG_TOML),
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
const CONTAINER_TASK_RUNTIME_ROOT = "/task";

const buildProjectProfileContextRoot = () => CONTAINER_SCAN_CONTEXT_ROOT;

const toAgentVisiblePath = (containerPath: string) => containerPath;

const buildProjectProfileCacheRoot = () =>
	path.posix.join(buildProjectProfileContextRoot(), "cache");

const buildScanJobContextRoot = (scanJobId: string) =>
	path.posix.join(buildProjectProfileContextRoot(), "jobs", scanJobId);

const buildFullScanRoot = (scanJobId: string) =>
	path.posix.join(buildScanJobContextRoot(scanJobId), "scanning", "full_scan");

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

const buildTaskHostRootForScanJob = (input: {
	hostProfileDir: string;
	scanJobId: string;
	stageName: string;
	taskName: string;
	taskId: string;
}) =>
	path.join(
		input.hostProfileDir,
		"jobs",
		input.scanJobId,
		resolveTaskRootSegment(input.stageName, input.taskName, input.taskId),
	);

const buildTaskMountPathForReview = (input: {
	scanJobId: string;
	stageName: string;
	taskName: string;
	taskId: string;
}) =>
	path.posix.join(
		CONTAINER_TASK_RUNTIME_ROOT,
		"jobs",
		input.scanJobId,
		resolveTaskRootSegment(input.stageName, input.taskName, input.taskId)
			.split(path.sep)
			.join(path.posix.sep),
	);

const resolveConfiguredScanContextHostPath = () =>
	process.env.VULSEEK_SCAN_CONTEXT_HOST_PATH?.trim() || "";

const resolveScanContextMount = async (input: {
	contextVolumeName: string | null | undefined;
	projectName: string;
	profileName: string;
}) => {
	const configuredHostRoot = resolveConfiguredScanContextHostPath();
	if (!configuredHostRoot) {
		throw new Error(
			"Scan context host path is not configured in process env VULSEEK_SCAN_CONTEXT_HOST_PATH",
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

const resolveTaskArtifactsDir = async (input: {
	scanJobId: string;
	stageName: string;
	taskName: string;
}) => {
	const scanJob = await findScanJobByIdRepo(input.scanJobId);
	const projectProfileHostContextRoot =
		await resolveRequiredProjectProfileHostContextRootByScanJob(scanJob);
	return path.join(
		projectProfileHostContextRoot,
		"jobs",
		input.scanJobId,
		"scanning",
		"full_scan",
		"stages",
		sanitizeContextPathPart(input.stageName),
		"tasks",
		sanitizeContextPathPart(input.taskName),
	);
};

const resolveCandidateTaskRuntimeDir = async (
	scanJobId: string,
	candidateId: string,
	stageName:
		| typeof SCAN_STAGE_IDS.analysis
		| typeof SCAN_STAGE_IDS.verification,
) => {
	const task = await findCandidateTaskByStage(
		scanJobId,
		candidateId,
		stageName,
	);
	if (!task) {
		return null;
	}
	return await resolveTaskArtifactsDir({
		scanJobId,
		stageName: task.stageName,
		taskName: task.name,
	});
};

export const getScanJobAppServerJsonlPath = async (scanJobId: string) =>
	path.join(
		await resolveScanJobArtifactsDir(scanJobId),
		"app-server-messages.jsonl",
	);

export const getScanJobAppServerTextPath = (scanJobId: string) =>
	path.join(resolveScanJobScanningRuntimeDir(scanJobId), "app-server-text.log");

export const getScanJobAppServerStderrPath = (scanJobId: string) =>
	path.join(
		resolveScanJobScanningRuntimeDir(scanJobId),
		"app-server-stderr.log",
	);

export const getCandidateAnalysisAppServerJsonlPath = async (
	scanJobId: string,
	candidateId: string,
) => {
	const runtimeDir = await resolveCandidateTaskRuntimeDir(
		scanJobId,
		candidateId,
		SCAN_STAGE_IDS.analysis,
	);
	return runtimeDir
		? path.join(runtimeDir, SANDBOX_AGENT_RUNTIME_FILE_NAMES.jsonl)
		: null;
};

export const getCandidateAnalysisAppServerTextPath = (
	scanJobId: string,
	candidateId: string,
) =>
	resolveCandidateTaskRuntimeDir(
		scanJobId,
		candidateId,
		SCAN_STAGE_IDS.analysis,
	).then((runtimeDir) =>
		runtimeDir
			? path.join(runtimeDir, SANDBOX_AGENT_RUNTIME_FILE_NAMES.text)
			: null,
	);

export const getCandidateAnalysisAppServerStderrPath = (
	scanJobId: string,
	candidateId: string,
) =>
	resolveCandidateTaskRuntimeDir(
		scanJobId,
		candidateId,
		SCAN_STAGE_IDS.analysis,
	).then((runtimeDir) =>
		runtimeDir
			? path.join(runtimeDir, SANDBOX_AGENT_RUNTIME_FILE_NAMES.stderr)
			: null,
	);

export const getCandidateVerifierAppServerJsonlPath = async (
	scanJobId: string,
	candidateId: string,
) => {
	const runtimeDir = await resolveCandidateTaskRuntimeDir(
		scanJobId,
		candidateId,
		SCAN_STAGE_IDS.verification,
	);
	return runtimeDir
		? path.join(runtimeDir, SANDBOX_AGENT_RUNTIME_FILE_NAMES.jsonl)
		: null;
};

export const getCandidateVerifierAppServerTextPath = (
	scanJobId: string,
	candidateId: string,
) =>
	resolveCandidateTaskRuntimeDir(
		scanJobId,
		candidateId,
		SCAN_STAGE_IDS.verification,
	).then((runtimeDir) =>
		runtimeDir
			? path.join(runtimeDir, SANDBOX_AGENT_RUNTIME_FILE_NAMES.text)
			: null,
	);

export const getCandidateVerifierAppServerStderrPath = (
	scanJobId: string,
	candidateId: string,
) =>
	resolveCandidateTaskRuntimeDir(
		scanJobId,
		candidateId,
		SCAN_STAGE_IDS.verification,
	).then((runtimeDir) =>
		runtimeDir
			? path.join(runtimeDir, SANDBOX_AGENT_RUNTIME_FILE_NAMES.stderr)
			: null,
	);

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

const resolveProjectProfileHostContextRootByScanJob = async (
	scanJob: ScanJob,
) => {
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
			"Scan context host path is not configured in process env VULSEEK_SCAN_CONTEXT_HOST_PATH",
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
	const scanJob = await findScanJobByIdRepo(scanJobId);
	const projectProfileHostContextRoot =
		await resolveRequiredProjectProfileHostContextRootByScanJob(scanJob);
	return path.join(
		projectProfileHostContextRoot,
		"jobs",
		scanJobId,
		"scanning",
	);
};

const resolveFullScanRootDir = async (scanJobId: string) =>
	path.join(await resolveScanJobArtifactsDir(scanJobId), "full_scan");

const resolveModuleArtifactsDir = async (scanJobId: string, moduleId: string) =>
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

const resolveScanJobBrowsableRoot = async (scanJobId: string) => {
	const scanJob = await findScanJobByIdRepo(scanJobId);
	const projectProfileHostContextRoot =
		await resolveRequiredProjectProfileHostContextRootByScanJob(scanJob);
	return path.join(projectProfileHostContextRoot, "jobs", scanJobId);
};

type CandidateArtifactRoot = {
	name: string;
	hostRootPath: string;
	containerRootPath: string;
	sourceContainerRootPath: string;
};

const CANDIDATE_ARTIFACT_CONTAINER_ROOT = "/candidate-artifacts";

const resolveHostPathFromContainerScanPath = (
	projectProfileHostContextRoot: string,
	containerPath: string,
) => {
	const relativePath = path.posix.relative(
		CONTAINER_SCAN_CONTEXT_ROOT,
		containerPath,
	);
	if (
		!relativePath ||
		relativePath === ".." ||
		relativePath.startsWith("../")
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Invalid scan artifact path",
		});
	}
	return path.join(
		projectProfileHostContextRoot,
		relativePath.split("/").join(path.sep),
	);
};

const isPathWithinPosixRoot = (filePath: string, rootPath: string) =>
	filePath === rootPath || filePath.startsWith(`${rootPath}/`);

const buildCandidateArtifactRoot = async (input: {
	name: string;
	scanJobId: string;
	taskId: string | null | undefined;
	projectProfileHostContextRoot: string;
	containerFilePath: string | null | undefined;
}): Promise<CandidateArtifactRoot | null> => {
	const {
		name,
		scanJobId,
		taskId,
		projectProfileHostContextRoot,
		containerFilePath,
	} = input;
	if (!containerFilePath) {
		return null;
	}

	const normalizedFilePath = containerFilePath.trim();
	if (!path.posix.isAbsolute(normalizedFilePath)) {
		return null;
	}

	const sourceContainerRootPath = path.posix.dirname(normalizedFilePath);
	if (
		isPathWithinPosixRoot(sourceContainerRootPath, CONTAINER_SCAN_CONTEXT_ROOT)
	) {
		try {
			return {
				name,
				containerRootPath: sourceContainerRootPath,
				sourceContainerRootPath,
				hostRootPath: resolveHostPathFromContainerScanPath(
					projectProfileHostContextRoot,
					sourceContainerRootPath,
				),
			};
		} catch {
			return null;
		}
	}

	if (
		taskId &&
		isPathWithinPosixRoot(sourceContainerRootPath, CONTAINER_TASK_RUNTIME_ROOT)
	) {
		const taskRootPath = await resolveScanTaskBrowsableRoot({
			scanJobId,
			taskId,
		});
		const relativePath = path.posix.relative(
			CONTAINER_TASK_RUNTIME_ROOT,
			sourceContainerRootPath,
		);
		return {
			name,
			containerRootPath: path.posix.join(
				CANDIDATE_ARTIFACT_CONTAINER_ROOT,
				name,
			),
			sourceContainerRootPath,
			hostRootPath: path.join(
				taskRootPath,
				relativePath.split("/").join(path.sep),
			),
		};
	}

	return null;
};

const listCandidateArtifactRoots = async (input: {
	scanJobId: string;
	candidateId: string;
}) => {
	const scanJob = await findScanJobByIdRepo(input.scanJobId);
	const projectProfileHostContextRoot =
		await resolveRequiredProjectProfileHostContextRootByScanJob(scanJob);
	const candidate = await findVulnerabilityCandidateByIdAndScanJobIdRepo({
		scanJobId: input.scanJobId,
		vulnerabilityCandidateId: input.candidateId,
	});
	const [analysisResult, verificationResult, triageResult] = await Promise.all([
		findLatestAnalysisResultByCandidateIdRepo({
			scanJobId: input.scanJobId,
			vulnerabilityCandidateId: input.candidateId,
			producerTaskId: candidate.producerTaskId,
		}),
		findLatestVerificationResultByCandidateIdRepo({
			scanJobId: input.scanJobId,
			vulnerabilityCandidateId: input.candidateId,
			producerTaskId: candidate.producerTaskId,
		}),
		findLatestTriageResultByCandidateIdRepo({
			scanJobId: input.scanJobId,
			vulnerabilityCandidateId: input.candidateId,
			producerTaskId: candidate.producerTaskId,
		}),
	]);

	const roots = (
		await Promise.all([
			buildCandidateArtifactRoot({
				name: "analysis",
				scanJobId: input.scanJobId,
				taskId: analysisResult?.taskId,
				projectProfileHostContextRoot,
				containerFilePath: analysisResult?.reportPath,
			}),
			buildCandidateArtifactRoot({
				name: "verify",
				scanJobId: input.scanJobId,
				taskId: verificationResult?.taskId,
				projectProfileHostContextRoot,
				containerFilePath: verificationResult?.reportPath,
			}),
			buildCandidateArtifactRoot({
				name: "triage",
				scanJobId: input.scanJobId,
				taskId: triageResult?.taskId,
				projectProfileHostContextRoot,
				containerFilePath: triageResult?.reportPath,
			}),
		])
	).filter((root): root is CandidateArtifactRoot => Boolean(root));

	const dedupedRoots = roots.filter(
		(root, index) =>
			roots.findIndex(
				(candidateRoot) =>
					candidateRoot.name === root.name &&
					candidateRoot.containerRootPath === root.containerRootPath,
			) === index,
	);

	const visibleRoots: CandidateArtifactRoot[] = [];
	for (const root of dedupedRoots) {
		const stat = await fs.stat(root.hostRootPath).catch(() => null);
		if (stat?.isDirectory()) {
			visibleRoots.push(root);
		}
	}
	return visibleRoots;
};

const assertWithinDirectory = (rootPath: string, targetPath: string) => {
	const resolvedRoot = path.resolve(rootPath);
	const resolvedTarget = path.resolve(targetPath);
	const relativePath = path.relative(resolvedRoot, resolvedTarget);
	if (
		relativePath === ".." ||
		relativePath.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relativePath)
	) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "File path is outside the scan job context",
		});
	}
};

const installRuntimeSkillsInContainer = async (
	containerName: string,
	agentsDir: string | null,
) => {
	if (!agentsDir) {
		return [] as string[];
	}

	const hostTempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "vulseek-runtime-skills-"),
	);
	const hostRepoRoot = path.join(hostTempDir, "repo");
	const hostSkillsRoot = path.join(hostRepoRoot, "skills");
	const copiedSkills: string[] = [];

	try {
		await fs.mkdir(hostSkillsRoot, { recursive: true });

		for (const skillName of RUNTIME_CUSTOM_SKILLS) {
			const sourceDir = path.join(agentsDir, "skills", skillName);
			try {
				await fs.stat(sourceDir);
			} catch {
				continue;
			}

			await fs.cp(sourceDir, path.join(hostSkillsRoot, skillName), {
				recursive: true,
			});
			copiedSkills.push(skillName);
		}

		const cacheSchemaSourceDir = path.join(agentsDir, "cache-schema");
		try {
			await fs.stat(cacheSchemaSourceDir);
			await fs.cp(
				cacheSchemaSourceDir,
				path.join(hostRepoRoot, "cache-schema"),
				{
					recursive: true,
				},
			);
		} catch {}

		if (copiedSkills.length === 0) {
			return [];
		}

		const containerRepoRoot = "/tmp/vulseek-runtime-skills";
		await execAsync(
			`docker exec ${containerName} bash -lc "rm -rf '${containerRepoRoot}' && mkdir -p '${containerRepoRoot}'"`,
		);
		await execAsync(
			`docker cp "${hostRepoRoot}/." ${containerName}:"${containerRepoRoot}/"`,
		);

		const skillFlags = copiedSkills
			.map((skillName) => `--skill '${escapeSingleQuotes(skillName)}'`)
			.join(" ");

			await execAsync(
				`docker exec ${containerName} bash -lc "mkdir -p /workspace/repo/.agents && cd /workspace/repo && skills add '${containerRepoRoot}' ${skillFlags} -a claude-code -a codex --copy -y"`,
			);

		return copiedSkills;
	} finally {
		await fs.rm(hostTempDir, { recursive: true, force: true }).catch(() => {});
	}
};

const resolveBrowsableFilePath = (input: {
	rootPath: string;
	filePath: string;
	containerRootPath: string;
}) => {
	const normalizedInput = input.filePath.trim();
	if (!normalizedInput) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "File path is required",
		});
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

const buildContainerFileTreeItems = async (input: {
	hostDirPath: string;
	containerDirPath: string;
}): Promise<ScanJobFileTreeItem[]> => {
	const entries = (
		await fs.readdir(input.hostDirPath, { withFileTypes: true })
	).filter(
		(entry) =>
			!shouldHideCandidateFileTreeEntry({
				entryName: entry.name,
				containerDirPath: input.containerDirPath,
			}),
	);
	const sortedEntries = entries.sort((left, right) => {
		if (left.isDirectory() && !right.isDirectory()) return -1;
		if (!left.isDirectory() && right.isDirectory()) return 1;
		return left.name.localeCompare(right.name);
	});

	return await Promise.all(
		sortedEntries.map(async (entry) => {
			const hostPath = path.join(input.hostDirPath, entry.name);
			const containerPath = path.posix.join(input.containerDirPath, entry.name);
			if (entry.isDirectory()) {
				return {
					id: containerPath,
					name: entry.name,
					type: "directory" as const,
					children: await buildContainerFileTreeItems({
						hostDirPath: hostPath,
						containerDirPath: containerPath,
					}),
				};
			}
			return { id: containerPath, name: entry.name, type: "file" as const };
		}),
	);
};

const resolveCandidateBrowsableFilePath = async (input: {
	scanJobId: string;
	candidateId: string;
	filePath: string;
}) => {
	const roots = await listCandidateArtifactRoots({
		scanJobId: input.scanJobId,
		candidateId: input.candidateId,
	});
	const normalizedInput = input.filePath.trim();
	if (!normalizedInput) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "File path is required",
		});
	}

	const candidates: Array<{ root: CandidateArtifactRoot; targetPath: string }> =
		[];

	for (const root of roots) {
		if (
			path.posix.isAbsolute(normalizedInput) &&
			(normalizedInput === root.containerRootPath ||
				normalizedInput.startsWith(`${root.containerRootPath}/`))
		) {
			candidates.push({
				root,
				targetPath: path.join(
					root.hostRootPath,
					path.posix
						.relative(root.containerRootPath, normalizedInput)
						.split("/")
						.join(path.sep),
				),
			});
			continue;
		}

		if (
			path.posix.isAbsolute(normalizedInput) &&
			(normalizedInput === root.sourceContainerRootPath ||
				normalizedInput.startsWith(`${root.sourceContainerRootPath}/`))
		) {
			candidates.push({
				root,
				targetPath: path.join(
					root.hostRootPath,
					path.posix
						.relative(root.sourceContainerRootPath, normalizedInput)
						.split("/")
						.join(path.sep),
				),
			});
			continue;
		}

		if (
			path.isAbsolute(normalizedInput) &&
			(normalizedInput === root.hostRootPath ||
				normalizedInput.startsWith(`${root.hostRootPath}${path.sep}`) ||
				normalizedInput.startsWith(`${root.hostRootPath}/`))
		) {
			candidates.push({ root, targetPath: path.resolve(normalizedInput) });
		}
	}

	if (roots.length === 1 && !path.isAbsolute(normalizedInput)) {
		const [root] = roots;
		if (!root) {
			throw new TRPCError({ code: "NOT_FOUND", message: "File not found" });
		}
		candidates.push({
			root,
			targetPath: path.join(root.hostRootPath, normalizedInput),
		});
	}

	for (const candidate of candidates) {
		const stat = await fs.stat(candidate.targetPath).catch(() => null);
		if (stat) {
			return candidate;
		}
	}

	if (candidates[0]) {
		return candidates[0];
	}

	throw new TRPCError({ code: "NOT_FOUND", message: "File not found" });
};

const shouldHideScanJobBrowsableEntry = (entryName: string) =>
	entryName.startsWith(".");

const shouldHideCandidateFileTreeEntry = (input: {
	entryName: string;
	containerDirPath: string;
}) =>
	shouldHideScanJobBrowsableEntry(input.entryName) ||
	input.entryName === "node_modules" ||
	(input.entryName === "cache" &&
		input.containerDirPath.endsWith("/agent-home"));

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
				containerRootPath: path.posix.join(
					buildScanJobContextRoot(input.scanJobId),
				),
			})
		: rootPath;

	assertWithinDirectory(rootPath, targetDirectoryPath);
	const stat = await fs.stat(targetDirectoryPath).catch(() => null);
	if (!stat || !stat.isDirectory()) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Directory not found" });
	}

	const entries = await fs.readdir(targetDirectoryPath, {
		withFileTypes: true,
	});
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
				const children = await fs
					.readdir(fullPath, { withFileTypes: true })
					.catch(() => []);
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

export const readScanJobFileContent = async (input: {
	scanJobId: string;
	filePath: string;
}) => {
	const rootPath = await resolveScanJobBrowsableRoot(input.scanJobId);
	const targetPath = resolveBrowsableFilePath({
		rootPath,
		filePath: input.filePath,
		containerRootPath: path.posix.join(
			buildScanJobContextRoot(input.scanJobId),
		),
	});
	assertWithinDirectory(rootPath, targetPath);
	const stat = await fs.stat(targetPath).catch(() => null);
	if (!stat || !stat.isFile()) {
		throw new TRPCError({ code: "NOT_FOUND", message: "File not found" });
	}
	const content = await fs.readFile(targetPath, "utf-8");
	return {
		path: targetPath,
		relativePath: path.relative(rootPath, targetPath),
		content,
	};
};

const resolveScanTaskBrowsableRoot = async (input: {
	scanJobId: string;
	taskId: string;
}) => {
	const task = await findTaskByIdRepo(input.taskId);
	if (task.scanJobId !== input.scanJobId) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Task not found for this scan job",
		});
	}

	const jobRootPath = await resolveScanJobBrowsableRoot(input.scanJobId);
	const expectedTaskRootPath = path.join(
		jobRootPath,
		resolveTaskRootSegment(task.stageName, task.name, task.taskId),
	);
	const expectedStat = await fs.stat(expectedTaskRootPath).catch(() => null);
	if (expectedStat?.isDirectory()) {
		return expectedTaskRootPath;
	}

	const stageTasksDir = path.join(
		jobRootPath,
		"scanning",
		"full_scan",
		"stages",
		sanitizeContextPathPart(task.stageName),
		"tasks",
	);
	const taskIdSuffix = `-${sanitizeContextPathPart(task.taskId).slice(0, 6)}`;
	const entries = await fs
		.readdir(stageTasksDir, { withFileTypes: true })
		.catch(() => []);
	const fallbackEntry = entries.find(
		(entry) => entry.isDirectory() && entry.name.endsWith(taskIdSuffix),
	);
	if (fallbackEntry) {
		return path.join(stageTasksDir, fallbackEntry.name);
	}

	return expectedTaskRootPath;
};

export const listScanTaskDirectory = async (input: {
	scanJobId: string;
	taskId: string;
	directoryPath?: string;
}) => {
	const rootPath = await resolveScanTaskBrowsableRoot(input);
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
				containerRootPath: CONTAINER_TASK_RUNTIME_ROOT,
			})
		: rootPath;

	assertWithinDirectory(rootPath, targetDirectoryPath);
	const stat = await fs.stat(targetDirectoryPath).catch(() => null);
	if (!stat || !stat.isDirectory()) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Directory not found" });
	}

	const entries = await fs.readdir(targetDirectoryPath, {
		withFileTypes: true,
	});
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
				const children = await fs
					.readdir(fullPath, { withFileTypes: true })
					.catch(() => []);
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

export const readScanTaskFileContent = async (input: {
	scanJobId: string;
	taskId: string;
	filePath: string;
}) => {
	const rootPath = await resolveScanTaskBrowsableRoot(input);
	const targetPath = resolveBrowsableFilePath({
		rootPath,
		filePath: input.filePath,
		containerRootPath: CONTAINER_TASK_RUNTIME_ROOT,
	});
	assertWithinDirectory(rootPath, targetPath);
	const stat = await fs.stat(targetPath).catch(() => null);
	if (!stat || !stat.isFile()) {
		throw new TRPCError({ code: "NOT_FOUND", message: "File not found" });
	}
	const content = await fs.readFile(targetPath, "utf-8");
	return {
		path: targetPath,
		relativePath: path.relative(rootPath, targetPath),
		content,
	};
};

export const readCandidateFilesTree = async (input: {
	scanJobId: string;
	candidateId: string;
}) => {
	const roots = await listCandidateArtifactRoots(input);
	return await Promise.all(
		roots.map(async (root) => ({
			id: root.containerRootPath,
			name: root.name,
			type: "directory" as const,
			children: await buildContainerFileTreeItems({
				hostDirPath: root.hostRootPath,
				containerDirPath: root.containerRootPath,
			}),
		})),
	);
};

export const readCandidateFileContent = async (input: {
	scanJobId: string;
	candidateId: string;
	filePath: string;
}) => {
	const { root, targetPath } = await resolveCandidateBrowsableFilePath(input);
	assertWithinDirectory(root.hostRootPath, targetPath);
	const stat = await fs.stat(targetPath).catch(() => null);
	if (!stat || !stat.isFile()) {
		throw new TRPCError({ code: "NOT_FOUND", message: "File not found" });
	}
	const content = await fs.readFile(targetPath, "utf-8");
	return {
		path: targetPath,
		relativePath: path.posix.join(
			root.name,
			path.relative(root.hostRootPath, targetPath).split(path.sep).join("/"),
		),
		content,
	};
};

const appendScanRuntimeFile = async (filePath: string, chunk: string) => {
	if (!chunk) return;
	await fs.appendFile(filePath, chunk, "utf-8");
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
		typeof record.method === "string" || "result" in record || "error" in record
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
							params: universalData || {
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
				const item = asRecord(universalData?.item) || universalData || {};
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
						buildSandboxAgentTextDeltaMessage(input.fallbackItemId, text),
					],
				};
			}
		}
	}

	const update =
		asRecord(payloadRecord.sessionUpdate) ||
		asRecord(payloadRecord.update) ||
		payloadRecord;
	const updateType = asString(update.type) || asString(update.kind) || "";

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
					buildSandboxAgentTextDeltaMessage(input.fallbackItemId, text),
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
		"payload" in parsed &&
		(parsed as Record<string, unknown>).payload &&
		typeof (parsed as Record<string, unknown>).payload === "object"
	) {
		const eventRecord = parsed as Record<string, unknown>;
		const payloadRecord =
			(eventRecord.payload as Record<string, unknown> | null) || null;
		const sessionUpdate =
			payloadRecord && typeof payloadRecord.sessionUpdate === "string"
				? payloadRecord.sessionUpdate
				: "";
		return {
			timestamp:
				typeof eventRecord.createdAt === "string"
					? eventRecord.createdAt
					: undefined,
			message: {
				method:
					sessionUpdate === "tool_call" || sessionUpdate === "tool_call_update"
						? "item/started"
						: "session/update",
				params:
					sessionUpdate === "tool_call" || sessionUpdate === "tool_call_update"
						? {
								item: {
									id:
										typeof payloadRecord?.toolCallId === "string"
											? payloadRecord.toolCallId
											: typeof payloadRecord?.itemId === "string"
												? payloadRecord.itemId
												: "sandbox-agent",
									type: "dynamicToolCall",
									tool:
										typeof payloadRecord?.title === "string"
											? payloadRecord.title
											: typeof payloadRecord?.tool === "string"
												? payloadRecord.tool
												: "tool",
									rawInput: payloadRecord?.rawInput,
									status: payloadRecord?.status,
								},
							}
						: {
								update: payloadRecord,
								content: payloadRecord?.content,
								text:
									payloadRecord?.content &&
									typeof payloadRecord.content === "object"
										? (payloadRecord.content as Record<string, unknown>).text
										: undefined,
							},
			},
		};
	}
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
	const maxMessages = Math.max(
		1,
		options?.maxMessages ?? STATUS_VIEW_STREAM_MAX_MESSAGES,
	);
	const maxBytes = Math.max(
		4096,
		options?.maxBytes ?? STATUS_VIEW_STREAM_TAIL_MAX_BYTES,
	);

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
		const runtimeDir = await resolveCandidateTaskRuntimeDir(
			scanJobId,
			candidateId,
			SCAN_STAGE_IDS.analysis,
		);
		if (!runtimeDir) {
			return [];
		}
		const file = await fs.readFile(
			path.join(runtimeDir, SANDBOX_AGENT_RUNTIME_FILE_NAMES.jsonl),
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
		const runtimeDir = await resolveCandidateTaskRuntimeDir(
			scanJobId,
			candidateId,
			SCAN_STAGE_IDS.verification,
		);
		if (!runtimeDir) {
			return [];
		}
		const file = await fs.readFile(
			path.join(runtimeDir, SANDBOX_AGENT_RUNTIME_FILE_NAMES.jsonl),
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
): Promise<JsonRpcMessageWithLine[]> => {
	const runtimeDir = await resolveCandidateTaskRuntimeDir(
		scanJobId,
		candidateId,
		SCAN_STAGE_IDS.analysis,
	);
	if (!runtimeDir) {
		return [];
	}
	return await readJsonRpcMessagesWithLineNumbersTail(
		path.join(runtimeDir, SANDBOX_AGENT_RUNTIME_FILE_NAMES.jsonl),
	);
};

const readCandidateVerifierAppServerMessagesTailWithLineNumbers = async (
	scanJobId: string,
	candidateId: string,
): Promise<JsonRpcMessageWithLine[]> => {
	const runtimeDir = await resolveCandidateTaskRuntimeDir(
		scanJobId,
		candidateId,
		SCAN_STAGE_IDS.verification,
	);
	if (!runtimeDir) {
		return [];
	}
	return await readJsonRpcMessagesWithLineNumbersTail(
		path.join(runtimeDir, SANDBOX_AGENT_RUNTIME_FILE_NAMES.jsonl),
	);
};

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
		return await fs.readFile(
			path.join(
				await resolveScanJobArtifactsDir(scanJobId),
				"app-server-text.log",
			),
			"utf-8",
		);
	} catch {
		return "";
	}
};

export const readCandidateAnalysisAppServerText = async (
	scanJobId: string,
	candidateId: string,
) => {
	try {
		const runtimeDir = await resolveCandidateTaskRuntimeDir(
			scanJobId,
			candidateId,
			SCAN_STAGE_IDS.analysis,
		);
		if (!runtimeDir) {
			return "";
		}
		return await fs.readFile(
			path.join(runtimeDir, SANDBOX_AGENT_RUNTIME_FILE_NAMES.text),
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
		const runtimeDir = await resolveCandidateTaskRuntimeDir(
			scanJobId,
			candidateId,
			SCAN_STAGE_IDS.verification,
		);
		if (!runtimeDir) {
			return "";
		}
		return await fs.readFile(
			path.join(runtimeDir, SANDBOX_AGENT_RUNTIME_FILE_NAMES.text),
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
			actionText: formatActionText(prompt ? `${tool}: ${prompt}` : tool, tool),
		};
	}

	return null;
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

		if (
			message.method === "item/started" ||
			message.method === "item/completed"
		) {
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
	const messages = await readCandidateAnalysisAppServerMessages(
		scanJobId,
		candidateId,
	);
	return deriveRuntimeLiveActionFromMessages(messages);
};

const deriveCandidateVerifierRuntimeLiveAction = async (
	scanJobId: string,
	candidateId: string,
): Promise<ScanRuntimeLiveAction | null> => {
	const messages = await readCandidateVerifierAppServerMessages(
		scanJobId,
		candidateId,
	);
	return deriveRuntimeLiveActionFromMessages(messages);
};

export const findScanJobStatusView = async (scanJobId: string) => {
	const [
		scanJob,
		candidates,
		analysisResultsList,
		verificationResultsList,
		triageResultsList,
		runningTasks,
		taskStatusCounts,
	] = await Promise.all([
		findScanJobByIdRepo(scanJobId),
		findVulnerabilityCandidatesByScanJobIdRepo(scanJobId),
		listAnalysisResultsByScanJobIdRepo(scanJobId),
		listVerificationResultsByScanJobIdRepo(scanJobId),
		listTriageResultsByScanJobIdRepo(scanJobId),
		listTasksByScanJobAndStatusesRepo({
			scanJobId,
			statuses: ["running"],
		}),
		listTaskStatusCountsByScanJobIdRepo(scanJobId),
	]);

	const statusPipelineContext = await buildFullScanPipelineContext(scanJobId);
	const statusPipeline =
		statusPipelineContext.scanJob.scanType === "delta"
			? buildDeltaScanPipeline(statusPipelineContext)
			: buildFullScanPipeline(statusPipelineContext);
	const concurrencyLimitByStageName = new Map<Task["stageName"], number>();
	await Promise.all(
		statusPipeline.stages.map(async (stage) => {
			concurrencyLimitByStageName.set(
				stage.id as Task["stageName"],
				Math.max(
					1,
					(await stage.getDesiredConcurrency?.(statusPipelineContext)) ?? 1,
				),
			);
		}),
	);
	const queuePendingCounts = await listQueuePendingCountsByScanJobId(
		scanJobId,
		taskStatusCounts,
		concurrencyLimitByStageName,
		statusPipeline.stages.map((stage) => stage.id),
	);

	const latestAnalysisResultByCandidateId = new Map<string, AnalysisResult>();
	for (const analysisResult of analysisResultsList) {
		if (
			!latestAnalysisResultByCandidateId.has(
				analysisResult.vulnerabilityCandidateId,
			)
		) {
			latestAnalysisResultByCandidateId.set(
				analysisResult.vulnerabilityCandidateId,
				analysisResult,
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
				verificationResult,
			);
		}
	}

	const latestTriageResultByCandidateId = new Map<string, TriageResult>();
	for (const triageResult of triageResultsList) {
		if (
			!latestTriageResultByCandidateId.has(
				triageResult.vulnerabilityCandidateId,
			)
		) {
			latestTriageResultByCandidateId.set(
				triageResult.vulnerabilityCandidateId,
				triageResult,
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
		return (
			latestVerificationResult?.result === "true" ||
			latestVerificationResult?.result === "likely"
		);
	}).length;
	const analysisCompletedCount = candidates.filter((candidate) =>
		latestAnalysisResultByCandidateId.has(candidate.vulnerabilityCandidateId),
	).length;
	const failedAnalysisCount = candidates.filter(
		(candidate) =>
			candidate.status === "failed" &&
			(candidate.currentStage || "analyzing") === "analyzing",
	).length;
	const verificationEligibleCount = analysisLikelyOrConfirmedCount;
	const verificationCompletedCount = candidates.filter((candidate) =>
		latestVerificationResultByCandidateId.has(
			candidate.vulnerabilityCandidateId,
		),
	).length;
	const triageCompletedCount = candidates.filter((candidate) =>
		latestTriageResultByCandidateId.has(candidate.vulnerabilityCandidateId),
	).length;
	const failedVerificationCount = candidates.filter(
		(candidate) =>
			candidate.status === "failed" && candidate.currentStage === "verifying",
	).length;
	const analysisQueuedCount = candidates.filter(
		(candidate) =>
			candidate.status === "pending" &&
			(candidate.currentStage || "analyzing") === "analyzing",
	).length;
	const verificationQueuedCount = candidates.filter(
		(candidate) =>
			candidate.status === "pending" && candidate.currentStage === "verifying",
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
				const taskId =
					candidateStage === "verifying"
						? latestVerificationResultByCandidateId.get(
								candidate.vulnerabilityCandidateId,
							)?.taskId || ""
						: latestAnalysisResultByCandidateId.get(
								candidate.vulnerabilityCandidateId,
							)?.taskId || "";

				return {
					taskId,
					vulnerabilityCandidateId: candidate.vulnerabilityCandidateId,
					title: candidate.title,
					filePath: candidate.filePath,
					line: candidate.line,
					stage: candidate.currentStage || resolvedStage,
					actionType: resolvedActionType,
					actionText: resolvedActionText,
					updatedAt: candidate.updatedAt,
				};
			}),
	);

	const inProgressTasks = runningTasks
		.map(buildInProgressTaskView)
		.filter((task): task is InProgressTaskView => Boolean(task))
		.sort(compareInProgressTaskView);

	return {
		scan: {
			scanJobId: scanJob.scanJobId,
			status: scanJob.status,
			repositoryTaskStatus: scanJob.repositoryTaskStatus,
		},
		summary: {
			totalCandidates: candidates.length,
			analysisCompletedCandidates: analysisCompletedCount,
			analysisFailedCandidates: failedAnalysisCount,
			analysisLikelyOrConfirmedCandidates: analysisLikelyOrConfirmedCount,
			analysisQueuedCandidates: analysisQueuedCount,
			verificationEligibleCandidates: verificationEligibleCount,
			verificationCompletedCandidates: verificationCompletedCount,
			verificationFailedCandidates: failedVerificationCount,
			verificationQueuedCandidates: verificationQueuedCount,
			verifiedZeroDayCandidates: verifiedZeroDayCount,
			triageCompletedCandidates: triageCompletedCount,
			moduleTasksTotal: scanJob.moduleTasksTotal,
			moduleTasksCompleted: scanJob.moduleTasksCompleted,
			moduleTasksFailed: scanJob.moduleTasksFailed,
			functionTasksTotal: scanJob.functionTasksTotal,
			functionTasksCompleted: scanJob.functionTasksCompleted,
			functionTasksFailed: scanJob.functionTasksFailed,
		},
		inProgressTasks,
		queuePendingCounts,
		inProgressCandidates,
	};
};

const SCAN_TASK_VIEW_STAGE_TO_STAGE_NAME: Record<string, Task["stageName"]> = {
	delta_scoping: SCAN_STAGE_IDS.deltaScope,
	repository_scanning: SCAN_STAGE_IDS.repositoryScan,
	attack_surface_modeling: SCAN_STAGE_IDS.attackSurfaceModel,
	module_scanning: SCAN_STAGE_IDS.moduleScan,
	function_scanning: SCAN_STAGE_IDS.functionScan,
	analyzing: SCAN_STAGE_IDS.analysis,
	criticizing: SCAN_STAGE_IDS.analysisCritic,
	verifying: SCAN_STAGE_IDS.verification,
	triaging: SCAN_STAGE_IDS.triage,
};

export const findScanJobTerminalTasksPage = async (input: {
	scanJobId: string;
	page: number;
	pageSize: number;
	query?: string;
	stage?: string;
	status?: string;
}) => {
	const stageName =
		input.stage && input.stage !== "all"
			? SCAN_TASK_VIEW_STAGE_TO_STAGE_NAME[input.stage]
			: undefined;
	const status =
		input.status === "completed" ||
		input.status === "failed" ||
		input.status === "exited"
			? input.status
			: undefined;
	const page = await listTerminalTasksPageByScanJobIdRepo({
		scanJobId: input.scanJobId,
		page: input.page,
		pageSize: input.pageSize,
		query: input.query,
		stageName,
		status,
	});
	return {
		...page,
		items: page.items
			.map(buildTerminalTaskView)
			.filter((task): task is TerminalTaskView => Boolean(task))
			.sort(compareTerminalTaskView),
	};
};

type ScanStageGraphNodeStatus =
	| "pending"
	| "launching"
	| "launched"
	| "starting"
	| "running"
	| "completed"
	| "failed"
	| "exited";

type ScanStageGraphCounts = {
	waiting: number;
	queued: number;
	launching: number;
	launched: number;
	starting: number;
	running: number;
	completed: number;
	failed: number;
	exited: number;
	total: number;
	pending: number;
};

const emptyStageGraphCounts = (): ScanStageGraphCounts => ({
	waiting: 0,
	queued: 0,
	launching: 0,
	launched: 0,
	starting: 0,
	running: 0,
	completed: 0,
	failed: 0,
	exited: 0,
	total: 0,
	pending: 0,
});

const toStageGraphCounts = (
	queue: QueuePendingCountView | undefined,
): ScanStageGraphCounts => {
	if (!queue) {
		return emptyStageGraphCounts();
	}
	return {
		waiting: queue.waitingCount,
		queued: queue.queuedCount,
		launching: queue.launchingCount,
		launched: queue.launchedCount,
		starting: queue.startingCount,
		running: queue.runningCount,
		completed: queue.completedCount,
		failed: queue.failedCount,
		exited: queue.exitedCount,
		total: queue.totalCount,
		pending: queue.pendingCount,
	};
};

const deriveStageGraphStatus = (
	stageName: string,
	counts: ScanStageGraphCounts,
	scanJob: ScanJob,
): ScanStageGraphNodeStatus => {
	if (
		stageName === SCAN_STAGE_IDS.repositoryScan ||
		stageName === SCAN_STAGE_IDS.deltaScope
	) {
		const repositoryStatus = scanJob.repositoryTaskStatus;
		if (
			repositoryStatus === "pending" ||
			repositoryStatus === "launching" ||
			repositoryStatus === "launched" ||
			repositoryStatus === "starting" ||
			repositoryStatus === "running" ||
			repositoryStatus === "completed" ||
			repositoryStatus === "failed" ||
			repositoryStatus === "exited"
		) {
			return repositoryStatus;
		}
	}
	if (counts.failed > 0) {
		return "failed";
	}
	if (counts.running > 0 || counts.starting > 0) {
		return "running";
	}
	if (counts.launching > 0 || counts.launched > 0) {
		return "launching";
	}
	if (counts.total > 0 && counts.completed + counts.exited >= counts.total) {
		return counts.exited > 0 ? "exited" : "completed";
	}
	return "pending";
};

const resolveStageGraphAgentKind = (stageName: string): StageAgentKind => {
	switch (stageName) {
		case SCAN_STAGE_IDS.analysis:
		case SCAN_STAGE_IDS.analysisCritic:
			return "analysis";
		case SCAN_STAGE_IDS.verification:
		case SCAN_STAGE_IDS.triage:
			return "verification";
		default:
			return "scan";
	}
};

type ScanStageGraphTargetInput = {
	applicationId?: string | null;
	composeId?: string | null;
	scanType?: "delta" | "full" | null;
};

export const getScanPipelineDefinitions = () => SCAN_PIPELINE_DEFINITIONS;

export const getScanPipelineYaml = () => readScanPipelineDefinitionsYaml();

const resolveStaticStageConcurrency = (
	stageName: string,
	settings: Awaited<
		ReturnType<typeof resolveScanProfileConcurrencySettingsFromTarget>
	>,
) => {
	const stageConcurrency = settings.scanStageSettings?.[stageName]?.concurrency;
	if (stageConcurrency) {
		return Math.max(1, stageConcurrency);
	}
	return getRuntimeStageConcurrency(stageName);
};

export const findFullScanStageGraph = async (
	target: ScanStageGraphTargetInput,
) => {
	const settings =
		await resolveScanProfileConcurrencySettingsFromTarget(target);
	const scanType =
		target.scanType === "delta"
			? "delta"
			: "full";
	const pipeline =
		scanType === "delta"
			? SCAN_PIPELINE_DEFINITIONS.pipelines.delta
			: SCAN_PIPELINE_DEFINITIONS.pipelines.full;
	const stages = pipeline.stageIds.map((stageId) => {
		const stage = SCAN_PIPELINE_DEFINITIONS.stageMetadataById[stageId];
		if (!stage) {
			throw new Error(`Unknown scan stage ${stageId} in ${pipeline.name}`);
		}
		return stage;
	});
	return {
		pipelineName: pipeline.name,
		nodes: await Promise.all(
			stages.map(async (stage, index) => {
				const agentProfile = await resolveStageAgentProfileFromTarget(
					target,
					resolveStageGraphAgentKind(stage.id),
					stage.id,
				);
				return {
					id: stage.id,
					stageId: stage.id,
					stageName: stage.id,
					name: stage.name,
					title: stage.name,
					queueId: null,
					queueName: null,
					status: "pending" as const,
					counts: emptyStageGraphCounts(),
					concurrencyLimit: resolveStaticStageConcurrency(stage.id, settings),
					disabled: false,
					effectiveDisabled: false,
					configuredConcurrency: null,
					configuredAgentProfileId: null,
					agentProfile:
						buildTaskAgentProfileSnapshot(agentProfile).agentProfile,
					groupId: null,
					order: index,
				};
			}),
		),
		edges: pipeline.edges.map((edge) => ({
			id: edge.id,
			name: edge.name,
			source: edge.from,
			target: edge.to,
			fork: edge.fork,
			routeKey: edge.route?.key ?? null,
			isDefaultRoute: Boolean(edge.route?.default),
		})),
		groups: pipeline.groups.map((group) => ({
			id: group.id,
			name: group.name,
			leaderStageName: group.leader,
			memberStageNames: group.members,
			stageNames: [group.leader, ...group.members],
		})),
	};
};

export const findScanJobStageGraph = async (scanJobId: string) => {
	const context = await buildFullScanPipelineContext(scanJobId);
	const pipeline =
		context.scanJob.scanType === "delta"
			? buildDeltaScanPipeline(context)
			: buildFullScanPipeline(context);
	const disabledStages = buildEffectiveDisabledStageSet({
		settings: context.scanJob.scanRuntimeSettings,
		stageNames: pipeline.stages.map((stage) => stage.id),
		edges: pipeline.edges.map((edge) => ({
			source: edge.from.id,
			target: edge.to.id,
		})),
		rootStageName: pipeline.stages[0]?.id,
	});
	const taskStatusCounts = await listTaskStatusCountsByScanJobIdRepo(scanJobId);
	const queuePendingCounts = await listQueuePendingCountsByScanJobId(
		scanJobId,
		taskStatusCounts,
		new Map<Task["stageName"], number>(),
		pipeline.stages.map((stage) => stage.id),
	);
	const queueByStageName = new Map(
		queuePendingCounts.map((queue) => [queue.stageName, queue]),
	);
	const groupNameByStageName = new Map<string, string>();
	for (const group of pipeline.groups ?? []) {
		groupNameByStageName.set(group.leader.id, group.name);
		for (const member of group.members) {
			groupNameByStageName.set(member.id, group.name);
		}
	}

	return {
		pipelineName: pipeline.name,
		nodes: await Promise.all(
			pipeline.stages.map(async (stage, index) => {
				const queue = queueByStageName.get(stage.id);
				const counts = toStageGraphCounts(queue);
				const runtimeSetting = getRuntimeStageSetting(
					context.scanJob.scanRuntimeSettings,
					stage.id,
				);
				const concurrencyLimit = Math.max(
					1,
					(await stage.getDesiredConcurrency?.(context)) ?? 1,
				);
				const agentProfile = await resolveStageAgentProfile(
					context.scanJob,
					resolveStageGraphAgentKind(stage.id),
					stage.id,
				);
				return {
					id: stage.id,
					stageId: stage.id,
					stageName: stage.id,
					name: stage.name,
					title: stage.name,
					queueId: queue?.id ?? null,
					queueName: queue?.queueName ?? null,
					status: deriveStageGraphStatus(stage.id, counts, context.scanJob),
					counts,
					concurrencyLimit,
					disabled: runtimeSetting.disabled === true,
					effectiveDisabled: disabledStages.has(stage.id),
					configuredConcurrency: runtimeSetting.concurrency ?? null,
					configuredAgentProfileId: runtimeSetting.agentProfileId ?? null,
					agentProfile:
						buildTaskAgentProfileSnapshot(agentProfile).agentProfile,
					groupId: groupNameByStageName.get(stage.id) ?? null,
					order: index,
				};
			}),
		),
		edges: pipeline.edges.map((edge) => ({
			id: edge.name,
			name: edge.name,
			source: edge.from.id,
			target: edge.to.id,
			fork: Boolean(edge.fork),
			routeKey: edge.route?.key ?? null,
			isDefaultRoute: Boolean(edge.route?.default),
		})),
		groups: (pipeline.groups ?? []).map((group) => ({
			id: group.name,
			name: group.name,
			leaderStageName: group.leader.id,
			memberStageNames: group.members.map((stage) => stage.id),
			stageNames: [group.leader.id, ...group.members.map((stage) => stage.id)],
		})),
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
				extractTextValue(
					(message.params as Record<string, unknown> | undefined)?.turn,
				) ||
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
			const errorRecord = (
				message.params as Record<string, unknown> | undefined
			)?.error;
			const errorMessage = extractTurnErrorMessage(errorRecord) || text;
			return errorMessage ? `\n[error] ${errorMessage}\n` : "";
		}
		default:
			return "";
	}
};

const captureContainerCodexState = async (
	containerName: string,
	scanRootDir: string,
	fileName: string,
	) => {
		const shellScript = [
			"set -eu",
			`mkdir -p '${scanRootDir}'`,
			`output='${scanRootDir}/${fileName}'`,
			"{",
			`echo '# Codex Runtime State'`,
			"echo",
			`echo '## config.toml'`,
			"echo '```toml'",
			`if [ -f /root/.codex/config.toml ]; then cat /root/.codex/config.toml; else echo '(missing)'; fi`,
			"echo '```'",
			"echo",
			`echo '## auth.json'`,
			"echo '```json'",
			`if [ -f /root/.codex/auth.json ]; then cat /root/.codex/auth.json; else echo '(missing)'; fi`,
			"echo '```'",
			"echo",
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
	const commitWindow =
		input.scanJob.commitWindow || DEFAULT_DELTA_COMMIT_WINDOW;
	const isDeltaScan = input.scanJob.scanType === "delta";

	const shellScript = [
		`SCAN_ROOT='${escapeSingleQuotes(input.scanRootDir)}'`,
		'mkdir -p "$SCAN_ROOT"',
		'PREPARE_STDOUT="$SCAN_ROOT/00_repository_prepare.stdout.log"',
		'PREPARE_STDERR="$SCAN_ROOT/00_repository_prepare.stderr.log"',
		': > "$PREPARE_STDOUT"',
		': > "$PREPARE_STDERR"',
		'exec > >(tee -a "$PREPARE_STDOUT") 2> >(tee -a "$PREPARE_STDERR" >&2)',
		"set -Eeuo pipefail",
		'CURRENT_CMD="(initializing)"',
		"trap 'rc=$?; echo \"[error] command failed (exit ${rc}): ${CURRENT_CMD}\" >&2' ERR",
		"run() {",
		'  CURRENT_CMD="$*"',
		'  echo "[cmd] $CURRENT_CMD"',
		'  "$@"',
		"}",
		"cd /workspace/repo",
		'CURRENT_BRANCH="$(git symbolic-ref --quiet --short HEAD || true)"',
		'echo "[info] using repository state from checkout image; skipping remote fetch/pull"',
		`TARGET_REF='${escapeSingleQuotes(targetRef)}'`,
		`TARGET_TAG='${escapeSingleQuotes(targetTag)}'`,
		`REQUESTED_COMMIT='${escapeSingleQuotes(requestedCommit)}'`,
		`REQUESTED_BASE='${escapeSingleQuotes(requestedBase)}'`,
		`COMMIT_WINDOW='${commitWindow}'`,
		`FORCE_LATEST_REF='${forceLatestRef ? "true" : "false"}'`,
		`PREFER_LATEST_TAG='${preferLatestTag ? "true" : "false"}'`,
		'RESOLVED_TARGET=""',
		'EFFECTIVE_TARGET_MODE="explicit"',
		'if [ "$FORCE_LATEST_REF" = "true" ]; then',
		'  EFFECTIVE_TARGET_MODE="latest-ref"',
		'  if [ -n "$CURRENT_BRANCH" ]; then',
		'    RESOLVED_TARGET="$(git rev-parse HEAD)"',
		'    TARGET_REF="$CURRENT_BRANCH"',
		'    TARGET_TAG=""',
		'    REQUESTED_COMMIT=""',
		"  else",
		'    RESOLVED_TARGET="$(git rev-parse HEAD)"',
		'    TARGET_REF="HEAD"',
		'    TARGET_TAG=""',
		'    REQUESTED_COMMIT=""',
		"  fi",
		'elif [ "$PREFER_LATEST_TAG" = "true" ] && [ -z "$TARGET_TAG" ]; then',
		'  CURRENT_CMD="git for-each-ref --sort=-creatordate --count=1 --format=%(refname:short) refs/tags"',
		"  LATEST_TAG=\"$(git for-each-ref --sort=-creatordate --count=1 --format='%(refname:short)' refs/tags)\"",
		'  if [ -n "$LATEST_TAG" ]; then',
		'    EFFECTIVE_TARGET_MODE="latest-tag"',
		'    TARGET_TAG="$LATEST_TAG"',
		'    TARGET_REF=""',
		'    REQUESTED_COMMIT=""',
		'    CURRENT_CMD="git rev-parse --verify refs/tags/$TARGET_TAG^{commit}"',
		'    git rev-parse --verify "refs/tags/$TARGET_TAG^{commit}" >/dev/null',
		'    run git checkout -f "refs/tags/$TARGET_TAG"',
		'    RESOLVED_TARGET="$(git rev-parse HEAD)"',
		"  else",
		'    EFFECTIVE_TARGET_MODE="latest-head-no-tag"',
		'    RESOLVED_TARGET="$(git rev-parse HEAD)"',
		"  fi",
		'elif [ -n "$TARGET_TAG" ]; then',
		'  CURRENT_CMD="git rev-parse --verify refs/tags/$TARGET_TAG^{commit}"',
		'  git rev-parse --verify "refs/tags/$TARGET_TAG^{commit}" >/dev/null',
		'  run git checkout -f "refs/tags/$TARGET_TAG"',
		'  RESOLVED_TARGET="$(git rev-parse HEAD)"',
		'elif [ -n "$TARGET_REF" ]; then',
		'  CURRENT_CMD="git rev-parse --verify $TARGET_REF^{commit}"',
		'  if git rev-parse --verify "$TARGET_REF^{commit}" >/dev/null 2>&1; then',
		'    run git checkout -f "$TARGET_REF"',
		"  else",
		'    CURRENT_CMD="git rev-parse --verify origin/$TARGET_REF^{commit}"',
		'    if git rev-parse --verify "origin/$TARGET_REF^{commit}" >/dev/null 2>&1; then',
		'      run git checkout -f "origin/$TARGET_REF"',
		"    else",
		'      echo "Unable to resolve targetRef: $TARGET_REF" >&2',
		"      exit 1",
		"    fi",
		"  fi",
		'  RESOLVED_TARGET="$(git rev-parse HEAD)"',
		'elif [ -n "$REQUESTED_COMMIT" ]; then',
		'  CURRENT_CMD="git rev-parse --verify $REQUESTED_COMMIT^{commit}"',
		'  if git rev-parse --verify "$REQUESTED_COMMIT^{commit}" >/dev/null 2>&1; then',
		'    run git checkout -f "$REQUESTED_COMMIT"',
		'    RESOLVED_TARGET="$(git rev-parse HEAD)"',
		"  else",
		'    echo "Unable to resolve commitSha: $REQUESTED_COMMIT" >&2',
		"    exit 1",
		"  fi",
		"else",
		'  RESOLVED_TARGET="$(git rev-parse HEAD)"',
		"fi",
		'TARGET_SUBJECT="$(git log -1 --format=%s "$RESOLVED_TARGET")"',
		'TARGET_SHORT="$(git rev-parse --short "$RESOLVED_TARGET")"',
		'CURRENT_EXACT_TAG="$(git describe --tags --exact-match HEAD 2>/dev/null || true)"',
		...(isDeltaScan
			? [
					'if [ -n "$REQUESTED_BASE" ] && git rev-parse --verify "$REQUESTED_BASE^{commit}" >/dev/null 2>&1; then',
					'  RESOLVED_BASE="$REQUESTED_BASE"',
					"else",
					'  RESOLVED_BASE="$(git rev-parse "$RESOLVED_TARGET~$COMMIT_WINDOW" 2>/dev/null || true)"',
					"fi",
				]
			: ['RESOLVED_BASE=""']),
		"{",
		"  echo '# Repository State'",
		"  echo",
		'  echo "- effective_target_mode: ${EFFECTIVE_TARGET_MODE}"',
		'  echo "- target_tag: ${TARGET_TAG:-<none>}"',
		'  echo "- target_ref: ${TARGET_REF:-<none>}"',
		'  echo "- requested_commit_sha: ${REQUESTED_COMMIT:-<none>}"',
		'  echo "- requested_base_sha: ${REQUESTED_BASE:-<none>}"',
		'  echo "- resolved_target_sha: ${RESOLVED_TARGET}"',
		'  echo "- resolved_target_short: ${TARGET_SHORT}"',
		'  echo "- resolved_base_sha: ${RESOLVED_BASE:-<none>}"',
		'  echo "- target_subject: ${TARGET_SUBJECT}"',
		...(isDeltaScan
			? [
					'  echo "- commit_window: ${COMMIT_WINDOW}"',
					"  echo",
					"  echo '## Recent Commits'",
					'  CURRENT_CMD="git log --oneline -n $((COMMIT_WINDOW + 1)) $RESOLVED_TARGET"',
					'  git log --oneline -n "$((COMMIT_WINDOW + 1))" "$RESOLVED_TARGET" || true',
				]
			: []),
		'} > "$SCAN_ROOT/00_repository_state.md"',
		"jq -n \\",
		'  --arg effectiveTargetMode "$EFFECTIVE_TARGET_MODE" \\',
		'  --arg targetRef "$TARGET_REF" \\',
		'  --arg targetTag "$TARGET_TAG" \\',
		'  --arg requestedCommitSha "$REQUESTED_COMMIT" \\',
		'  --arg requestedBaseSha "$REQUESTED_BASE" \\',
		'  --arg resolvedTargetSha "$RESOLVED_TARGET" \\',
		'  --arg resolvedBaseSha "$RESOLVED_BASE" \\',
		'  --arg currentBranch "$CURRENT_BRANCH" \\',
		'  --arg currentExactTag "$CURRENT_EXACT_TAG" \\',
		'  --argjson commitWindow "$COMMIT_WINDOW" \\',
		"  '{",
		"    effectiveTargetMode: $effectiveTargetMode,",
		'    targetRef: (if $targetRef == "" then null else $targetRef end),',
		'    targetTag: (if $targetTag == "" then null else $targetTag end),',
		'    requestedCommitSha: (if $requestedCommitSha == "" then null else $requestedCommitSha end),',
		'    requestedBaseSha: (if $requestedBaseSha == "" then null else $requestedBaseSha end),',
		"    commitWindow: $commitWindow,",
		"    resolvedTargetSha: $resolvedTargetSha,",
		'    resolvedBaseSha: (if $resolvedBaseSha == "" then null else $resolvedBaseSha end),',
		'    currentBranch: (if $currentBranch == "" then null else $currentBranch end),',
		'    currentExactTag: (if $currentExactTag == "" then null else $currentExactTag end)',
		'  }\' > "$SCAN_ROOT/00_repository_state.json"',
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

		const message =
			error instanceof Error ? error.message : "Repository prepare failed";
		const tail = (value: string) =>
			value.split("\n").slice(-40).join("\n").trim();
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

	const parsed = JSON.parse(repositoryStateJson.stdout) as Omit<
		PreparedRepositoryState,
		"markdown"
	>;

	return {
		...parsed,
		markdown: repositoryState.stdout.trim(),
	};
};

const getPermissionRequestId = (request: Record<string, unknown>) =>
	asString(request.id) ||
	asString(request.permissionId) ||
	asString(asRecord(request.permission)?.id) ||
	asString(asRecord(request.rawRequest)?.id);

const autoApprovePermissionRequest = async (
	session: {
		respondPermission: (
			permissionId: string,
			reply: "always" | "once",
		) => Promise<void>;
	},
	stderrPath: string,
	request: Record<string, unknown>,
) => {
	const permissionId = getPermissionRequestId(request);
	if (!permissionId) {
		await appendScanRuntimeFile(
			stderrPath,
			"[sandbox-agent-permission] unable to auto-approve permission without id\n",
		);
		return;
	}

	const availableReplies = Array.isArray(request.availableReplies)
		? request.availableReplies
				.map((reply) => String(reply))
				.filter((reply) => reply.length > 0)
		: [];
	const replies = [
		...availableReplies.filter((reply) => reply === "always"),
		...availableReplies.filter((reply) => reply === "once"),
		"always",
		"once",
	].filter((reply, index, values) => values.indexOf(reply) === index) as Array<
		"always" | "once"
	>;

	for (const reply of replies) {
		try {
			await session.respondPermission(permissionId, reply);
			await appendScanRuntimeFile(
				stderrPath,
				`[sandbox-agent-permission] auto-approved permission id=${permissionId} reply=${reply}\n`,
			);
			return;
		} catch (error) {
			await appendScanRuntimeFile(
				stderrPath,
				`[sandbox-agent-permission] auto-approve attempt failed id=${permissionId} reply=${reply} error=${
					error instanceof Error ? error.message : String(error)
				}\n`,
			);
		}
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

	const sessionId = asString(session?.agentSessionId);
	if (!sessionId) {
		throw new Error("sandbox-agent session is missing native agentSessionId");
	}
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

	const appendNormalizedMessages = async (event: SandboxAgentSessionEvent) => {
		const normalized = normalizeSandboxAgentPayloadToJsonRpc({
			payload: event.payload,
			fallbackItemId: asString(event.sessionId) || sessionId || "sandbox-agent",
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
			.then(async () => {
				await appendNormalizedMessages(event);
				const payload = asRecord(event.payload);
				if (asString(payload?.method) !== "session/request_permission") {
					return;
				}
				const params = asRecord(payload?.params) || {};
				await autoApprovePermissionRequest(session, input.stderrPath, {
					...params,
					id: asString(payload?.id) || asString(params.id) || undefined,
				});
			})
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
		void autoApprovePermissionRequest(session, input.stderrPath, request);
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
		await appendScanRuntimeFile(
			input.stderrPath,
			`[sandbox-agent] ${message}\n`,
		);
		throw error;
	} finally {
		try {
			await (session as { close: () => Promise<void> }).close();
		} catch (error) {
			await appendScanRuntimeFile(
				input.stderrPath,
				`[sandbox-agent-cleanup] session.close failed: ${
					error instanceof Error ? error.message : "unknown error"
				}\n`,
			).catch(() => {});
		}
		const maybeClose = (client as { close?: () => Promise<void> }).close;
		if (typeof maybeClose === "function") {
			try {
				await maybeClose.call(client);
			} catch (error) {
				await appendScanRuntimeFile(
					input.stderrPath,
					`[sandbox-agent-cleanup] client.close failed: ${
						error instanceof Error ? error.message : "unknown error"
					}\n`,
				).catch(() => {});
			}
		}
	}

	return {
		sessionId,
	};
};

type FullScanExecutionContext = Awaited<
	ReturnType<typeof resolveScanExecutionContext>
>;

type FullScanPipelineContext = PipelineContext & {
	scanJob: ScanJob;
	executionContext: FullScanExecutionContext;
	refreshPipelineState: () => Promise<void>;
};

type FullScanPipelineStage = AnyStageDefinition<FullScanPipelineContext>;
type FullScanPipelineEdge = PipelineEdge<
	FullScanPipelineContext,
	FullScanPipelineStage,
	any,
	FullScanPipelineStage,
	any
>;

const buildDefinitionsSchemaContract = (
	definitions: ScanPipelineDefinitions,
	schema: Record<string, unknown> | null | undefined,
): StructuredOutputSchemaSource | undefined =>
	schema
		? createJsonSchemaContract({
				schemas: definitions.schemas,
				schema,
			})
		: undefined;

const getDefinitionsStageOutputSchema = (
	definitions: ScanPipelineDefinitions,
	stageId: string,
) =>
	buildDefinitionsSchemaContract(
		definitions,
		definitions.stages.find((stage) => stage.id === stageId)?.outputSchema,
	);

const buildPipelineStagesFromDefinitions = (
	pipeline: ScanPipelineConfig,
	stageRegistry: Map<string, FullScanPipelineStage>,
) =>
	pipeline.stageIds.map((stageId) => {
		const stage = stageRegistry.get(stageId);
		if (!stage) {
			throw new Error(`missing stage implementation: ${stageId}`);
		}
		return stage;
	});

const buildPipelineEdgesFromDefinitions = (
	definitions: ScanPipelineDefinitions,
	pipeline: ScanPipelineConfig,
	edgeRegistry: Map<string, FullScanPipelineEdge>,
) =>
	pipeline.edges.map((edgeConfig) => {
		const edge = edgeRegistry.get(edgeConfig.name);
		if (!edge) {
			throw new Error(`missing edge implementation: ${edgeConfig.name}`);
		}
		return {
			...edge,
			fork: edgeConfig.fork,
			transformOutput:
				edgeConfig.input !== null || edgeConfig.mode !== null
					? async (input: {
							ctx: FullScanPipelineContext;
							stageInput: unknown;
							stageOutput: unknown;
						}) =>
							transformPipelineEdgeInput(
								{
									mode: edgeConfig.mode,
									foreach: edgeConfig.foreach,
									input: edgeConfig.input,
								},
								{
									ctx: {
										...input.ctx,
										computed: {
											analysisFingerprint:
												edgeConfig.name ===
												"analyze-finding-to-critique-finding"
													? buildAnalysisFingerprint(input.stageOutput)
													: undefined,
										},
									},
									stageInput: input.stageInput,
									stageOutput: input.stageOutput,
								},
							) as any[]
					: edge.transformOutput,
			outputSchema:
				buildDefinitionsSchemaContract(definitions, edgeConfig.outputSchema) ??
				edge.outputSchema,
			outputSchemaDescription:
				edgeConfig.outputSchemaDescription ?? edge.outputSchemaDescription,
			route: edgeConfig.route
				? {
						key: edgeConfig.route.key,
						default: edgeConfig.route.default,
					}
				: undefined,
		};
	});

const buildPipelineGroupsFromDefinitions = (
	pipeline: ScanPipelineConfig,
	stageRegistry: Map<string, FullScanPipelineStage>,
) =>
	pipeline.groups.map((group) => {
		const leader = stageRegistry.get(group.leader);
		if (!leader) {
			throw new Error(`missing group leader implementation: ${group.leader}`);
		}
		return {
			name: group.name,
			leader,
			members: group.members.map((stageId) => {
				const stage = stageRegistry.get(stageId);
				if (!stage) {
					throw new Error(`missing group member implementation: ${stageId}`);
				}
				return stage;
			}),
		};
	});

const resolveScanJobPipelineDefinitions = (
	scanJob: Pick<ScanJob, "scanPipelineDefinitionSnapshot">,
): ScanPipelineDefinitions => {
	const snapshot = scanJob.scanPipelineDefinitionSnapshot;
	if (
		snapshot &&
		typeof snapshot === "object" &&
		"stages" in snapshot &&
		"pipelines" in snapshot
	) {
		return snapshot as ScanPipelineDefinitions;
	}
	throw new TRPCError({
		code: "INTERNAL_SERVER_ERROR",
		message: "Scan job pipeline definition snapshot is missing or invalid",
	});
};

const attachStageRuntimeConfigs = <TStage extends FullScanPipelineStage>(
	scanJobId: string,
	stages: readonly TStage[],
): FullScanPipelineStage[] =>
	stages.map((stage) => ({
		...stage,
		runtimeConfig: createStageRuntimeConfig(scanJobId, stage.id),
	}));

type FullScanRepositoryStage = StageDefinition<
	FullScanPipelineContext,
	RepositoryScanningStageInput,
	RepositoryScanningStageOutput
>;
type FullScanFunctionStage = StageDefinition<
	FullScanPipelineContext,
	ScanTargetStageInput,
	ScanTargetStageOutput | null
>;
type DeltaScopeFunctionInput = Pick<
	ScanTargetStageInput,
	| "scanJob"
	| "repositoryPath"
	| "modulePath"
	| "threatModelPath"
	| "targetPath"
	| "moduleId"
	| "moduleName"
	| "targetId"
	| "targetName"
	| "targetKind"
	| "priority"
>;

const buildRepositoryObject = (
	scanJob: ScanJob,
	repositoryName: string,
): CanonicalRepository => ({
	id: scanJob.repositoryTaskId || scanJob.scanJobId,
	name: repositoryName,
	summary: "",
	languages: [],
	buildSystems: [],
	runtimeDirectories: [],
	downrankedDirectories: [],
	notes: [],
	targetRef: scanJob.targetRef,
	targetTag: scanJob.targetTag,
	commitSha: scanJob.commitSha,
	baseSha: scanJob.baseSha,
	commitWindow: scanJob.commitWindow || DEFAULT_DELTA_COMMIT_WINDOW,
});

const buildCandidateObject = (candidate: {
	vulnerabilityCandidateId: string;
	producerTaskId: string | null;
	functionId: string | null;
	title: string;
	description: string | null;
	filePath: string | null;
	line: number | null;
	vulnerabilityType: string | null;
	confidence: number | null;
	score: number | null;
	targetId: string | null;
	targetKind: string | null;
	claim: string;
	rootCauseKey: string | null;
	evidence: Evidence[];
	attackerControl: string | null;
	affectedSink: string | null;
	preconditions: string[];
	quickDisproofAttempt: string | null;
	needsFuzzing: boolean;
	needsManualAnalysis: boolean;
	status: string;
	currentStage: string;
}): CanonicalCandidate => {
	const parsedTargetKind = targetKindSchema
		.nullable()
		.safeParse(candidate.targetKind);
	return {
		id: candidate.vulnerabilityCandidateId,
		functionId: candidate.functionId || candidate.producerTaskId,
		title: candidate.title,
		description: candidate.description || "",
		filePath: candidate.filePath,
		line: candidate.line,
		vulnerabilityType: candidate.vulnerabilityType,
		confidence: candidate.confidence,
		score: candidate.score,
		targetId: candidate.targetId,
		targetKind: parsedTargetKind.success ? parsedTargetKind.data : null,
		claim: candidate.claim,
		rootCauseKey: candidate.rootCauseKey,
		evidence: candidate.evidence,
		attackerControl: candidate.attackerControl,
		affectedSink: candidate.affectedSink,
		preconditions: candidate.preconditions,
		quickDisproofAttempt: candidate.quickDisproofAttempt,
		needsFuzzing: candidate.needsFuzzing,
		needsManualAnalysis: candidate.needsManualAnalysis,
		status:
			candidate.status === "running" ||
			candidate.status === "completed" ||
			candidate.status === "failed" ||
			candidate.status === "exited"
				? candidate.status
				: "pending",
		currentStage:
			candidate.currentStage === "verifying"
				? candidate.currentStage
				: "analyzing",
	};
};

const buildCandidateAnalysisStageInput = (input: {
	scanJob: ScanJob;
	module: CanonicalModule;
	function: CanonicalFunction;
	candidate: CanonicalCandidate;
}): CandidateAnalysisStageInput =>
	({
		scanJob: input.scanJob,
		repositoryPath: "",
		modulePath: "",
		functionPath: "",
		candidatePath: "",
		analysisReportTemplatePath: null,
		legacyCandidate: {
			...input.candidate,
			scanJob: input.scanJob,
			module: {
				...input.module,
				scanJob: input.scanJob,
			},
			function: {
				...input.function,
				scanJob: input.scanJob,
				module: {
					...input.module,
					scanJob: input.scanJob,
				},
			},
		},
	}) as unknown as CandidateAnalysisStageInput;

const buildFullScanPipelineContext = async (
	scanJobId: string,
): Promise<FullScanPipelineContext> => {
	const scanJob = await findScanJobByIdRepo(scanJobId);
	const executionContext = await resolveScanExecutionContext(scanJob);
	return {
		scanJob,
		executionContext,
		scanJobId: scanJob.scanJobId,
		projectName: executionContext.projectName,
		serviceName: executionContext.serviceName,
		refreshPipelineState: async () => {
			await recalculateScanTaskCountsRepo(scanJobId).catch((error) => {
				console.log(
					"[full-scan]",
					JSON.stringify({
						event: "refreshPipelineState.recalculate_failed",
						scanJobId,
						errorMessage:
							error instanceof Error ? error.message : String(error),
					}),
				);
			});
			await reconcileScanJobCandidatePipelineStatus(scanJobId);
		},
	};
};

const resolveFullScanTaskRuntimeDir = async (
	context: FullScanPipelineContext,
	input: {
		taskId: string;
		stageName: string;
		taskName: string;
	},
) =>
	await resolveTaskRuntimeDirForTask({
		scanJobId: context.scanJob.scanJobId,
		projectName: context.projectName,
		serviceName: context.serviceName,
		stageName: input.stageName,
		taskName: input.taskName,
		taskId: input.taskId,
	});

const resolveExistingFullScanTaskRuntimeDir = async (
	context: FullScanPipelineContext,
	task: Task,
) =>
	await resolveFullScanTaskRuntimeDir(context, {
		taskId: task.taskId,
		stageName: task.stageName,
		taskName: task.name,
	});

const copyArtifactToDownstreamInput = async (input: {
	fromTaskDir: string;
	fromPath: string;
	toTaskDir: string;
	toRelativePath: string;
}) =>
	await copyTaskJsonArtifact({
		fromTaskDir: input.fromTaskDir,
		fromContainerPath: input.fromPath,
		toTaskDir: input.toTaskDir,
		toRelativePath: input.toRelativePath,
	});

const writeDownstreamInputArtifact = async (input: {
	toTaskDir: string;
	toRelativePath: string;
	value: unknown;
}) =>
	await writeTaskJsonArtifact({
		taskDir: input.toTaskDir,
		relativePath: input.toRelativePath,
		value: input.value,
	});

const copyAnalysisBaseInputArtifacts = async (input: {
	fromTaskDir: string;
	toTaskDir: string;
	stageInput: CandidateAnalysisStageInput;
}): Promise<CandidateAnalysisStageInput> => {
	const base: CandidateAnalysisStageInput = {
		scanJob: input.stageInput.scanJob,
		repositoryPath: await copyArtifactToDownstreamInput({
			fromTaskDir: input.fromTaskDir,
			fromPath: input.stageInput.repositoryPath,
			toTaskDir: input.toTaskDir,
			toRelativePath: "inputs/repository.json",
		}),
		modulePath: await copyArtifactToDownstreamInput({
			fromTaskDir: input.fromTaskDir,
			fromPath: input.stageInput.modulePath,
			toTaskDir: input.toTaskDir,
			toRelativePath: "inputs/module.json",
		}),
		functionPath: await copyArtifactToDownstreamInput({
			fromTaskDir: input.fromTaskDir,
			fromPath: input.stageInput.functionPath,
			toTaskDir: input.toTaskDir,
			toRelativePath: "inputs/target.json",
		}),
		candidatePath: await copyArtifactToDownstreamInput({
			fromTaskDir: input.fromTaskDir,
			fromPath: input.stageInput.candidatePath,
			toTaskDir: input.toTaskDir,
			toRelativePath: "inputs/candidate.json",
		}),
	};
	if (input.stageInput.analysisReportTemplatePath) {
		base.analysisReportTemplatePath = await copyArtifactToDownstreamInput({
			fromTaskDir: input.fromTaskDir,
			fromPath: input.stageInput.analysisReportTemplatePath,
			toTaskDir: input.toTaskDir,
			toRelativePath: "inputs/analysis-report-template.md",
		});
	}
	if (input.stageInput.feedbackPath) {
		base.feedbackPath = await copyArtifactToDownstreamInput({
			fromTaskDir: input.fromTaskDir,
			fromPath: input.stageInput.feedbackPath,
			toTaskDir: input.toTaskDir,
			toRelativePath: "inputs/feedback.json",
		});
	}
	return base;
};

const writeAnalysisReportTemplateInput = async (input: {
	scanJob: ScanJob;
	toTaskDir: string;
}) => {
	if (!input.scanJob.applicationId || input.scanJob.composeId) {
		return null;
	}
	const application = await findApplicationById(input.scanJob.applicationId);
	const template = application.analysisReportTemplate?.trim();
	if (!template) {
		return null;
	}
	return await writeTaskTextArtifact({
		taskDir: input.toTaskDir,
		relativePath: "inputs/analysis-report-template.md",
		value: template,
	});
};

const buildFullScanPipeline = (context: FullScanPipelineContext) => {
	const { scanJob } = context;
	const repositoryScanQueue = getRepositoryScanQueue(scanJob.scanJobId);
	const attackSurfaceModelQueue = getAttackSurfaceModelQueue(scanJob.scanJobId);
	const moduleScanQueue = getModuleScanQueue(scanJob.scanJobId);
	const functionScanQueue = getFunctionScanQueue(scanJob.scanJobId);
	const analysisQueue = getAnalysisQueue(scanJob.scanJobId);
	const analysisCriticQueue = getAnalysisCriticQueue(scanJob.scanJobId);
	const verificationQueue = getVerificationQueue(scanJob.scanJobId);
	const triageQueue = getTriageQueue(scanJob.scanJobId);
	const pipelineDefinitions = resolveScanJobPipelineDefinitions(scanJob);
	const repositoryStage =
		createRepositoryScanningStageDefinition<FullScanPipelineContext>({
			id: SCAN_STAGE_METADATA.repositoryScan.id,
			name: SCAN_STAGE_METADATA.repositoryScan.name,
			persistent: false,
			reuseContainer: true,
			outputSchema: getDefinitionsStageOutputSchema(
				pipelineDefinitions,
				SCAN_STAGE_IDS.repositoryScan,
			),
			queue: createStageQueueBinding({
				queue: repositoryScanQueue,
				getGroupQueue: (groupInstanceId) =>
					getScanStageGroupQueue(
						scanJob.scanJobId,
						groupInstanceId,
						"repository",
					),
				obliterateGroupQueue: (groupInstanceId) =>
					obliterateScanStageGroupQueue(
						scanJob.scanJobId,
						groupInstanceId,
						"repository",
					),
				ownsInputId: async (ctx, inputId, _jobData, _jobId, scope) => {
					const task = await findTaskByIdRepo(inputId).catch(() => null);
					return Boolean(
						task &&
							task.scanJobId === ctx.scanJob.scanJobId &&
							task.stageName === SCAN_STAGE_IDS.repositoryScan &&
							(await taskMatchesStageQueueScope(task, scope?.groupInstanceId)),
					);
				},
				loadInput: async (ctx, inputId) => {
					const task = await findTaskByIdRepo(inputId).catch(() => null);
					if (
						!task ||
						task.scanJobId !== ctx.scanJob.scanJobId ||
						task.stageName !== SCAN_STAGE_IDS.repositoryScan ||
						task.status !== "pending"
					) {
						return undefined;
					}
					return null;
				},
			}),
		});

	const attackSurfaceModelStage =
		createAttackSurfaceModelStageDefinition<FullScanPipelineContext>({
			id: SCAN_STAGE_METADATA.attackSurfaceModel.id,
			name: SCAN_STAGE_METADATA.attackSurfaceModel.name,
			persistent: false,
			reuseContainer: true,
			outputSchema: getDefinitionsStageOutputSchema(
				pipelineDefinitions,
				SCAN_STAGE_IDS.attackSurfaceModel,
			),
			queue: createStageQueueBinding({
				queue: attackSurfaceModelQueue,
				getGroupQueue: (groupInstanceId) =>
					getScanStageGroupQueue(
						scanJob.scanJobId,
						groupInstanceId,
						"attack-surface-model",
					),
				obliterateGroupQueue: (groupInstanceId) =>
					obliterateScanStageGroupQueue(
						scanJob.scanJobId,
						groupInstanceId,
						"attack-surface-model",
					),
				ownsInputId: async (ctx, inputId, _jobData, _jobId, scope) => {
					const task = await findTaskByIdRepo(inputId).catch(() => null);
					return Boolean(
						task &&
							task.scanJobId === ctx.scanJob.scanJobId &&
							task.stageName === SCAN_STAGE_IDS.attackSurfaceModel &&
							(await taskMatchesStageQueueScope(task, scope?.groupInstanceId)),
					);
				},
				loadInput: async (ctx, inputId) => {
					const task = await findTaskByIdRepo(inputId).catch(() => null);
					if (
						!task ||
						task.scanJobId !== ctx.scanJob.scanJobId ||
						task.stageName !== SCAN_STAGE_IDS.attackSurfaceModel ||
						task.status !== "pending" ||
						!task.input
					) {
						return undefined;
					}
					return task.input as AttackSurfaceModelStageInput;
				},
			}),
		});

	const moduleStage =
		createIdentifyTargetStageDefinition<FullScanPipelineContext>({
			id: SCAN_STAGE_METADATA.moduleScan.id,
			name: SCAN_STAGE_METADATA.moduleScan.name,
			persistent: false,
			reuseContainer: true,
			outputSchema: getDefinitionsStageOutputSchema(
				pipelineDefinitions,
				SCAN_STAGE_IDS.moduleScan,
			),
			queue: createStageQueueBinding({
				queue: moduleScanQueue,
				getGroupQueue: (groupInstanceId) =>
					getScanStageGroupQueue(scanJob.scanJobId, groupInstanceId, "module"),
				obliterateGroupQueue: (groupInstanceId) =>
					obliterateScanStageGroupQueue(
						scanJob.scanJobId,
						groupInstanceId,
						"module",
					),
				ownsInputId: async (ctx, inputId, _jobData, _jobId, scope) => {
					const task = await findTaskByIdRepo(inputId).catch(() => null);
					return Boolean(
						task &&
							task.scanJobId === ctx.scanJob.scanJobId &&
							task.stageName === SCAN_STAGE_IDS.moduleScan &&
							(await taskMatchesStageQueueScope(task, scope?.groupInstanceId)),
					);
				},
				loadInput: async (ctx, inputId) => {
					const task = await findTaskByIdRepo(inputId).catch(() => null);
					if (
						!task ||
						task.scanJobId !== ctx.scanJob.scanJobId ||
						task.stageName !== SCAN_STAGE_IDS.moduleScan ||
						task.status !== "pending" ||
						!task.input
					) {
						return undefined;
					}
					return task.input as IdentifyTargetStageInput;
				},
			}),
		});

	const functionStage =
		createScanTargetStageDefinition<FullScanPipelineContext>({
			id: SCAN_STAGE_METADATA.functionScan.id,
			name: SCAN_STAGE_METADATA.functionScan.name,
			persistent: true,
			reuseContainer: true,
			outputSchema: getDefinitionsStageOutputSchema(
				pipelineDefinitions,
				SCAN_STAGE_IDS.functionScan,
			),
			queue: createStageQueueBinding({
				queue: functionScanQueue,
				getGroupQueue: (groupInstanceId) =>
					getScanStageGroupQueue(
						scanJob.scanJobId,
						groupInstanceId,
						"function",
					),
				obliterateGroupQueue: (groupInstanceId) =>
					obliterateScanStageGroupQueue(
						scanJob.scanJobId,
						groupInstanceId,
						"function",
					),
				ownsInputId: async (ctx, inputId, _jobData, _jobId, scope) => {
					const task = await findTaskByIdRepo(inputId).catch(() => null);
					return Boolean(
						task &&
							task.scanJobId === ctx.scanJob.scanJobId &&
							task.stageName === SCAN_STAGE_IDS.functionScan &&
							(await taskMatchesStageQueueScope(task, scope?.groupInstanceId)),
					);
				},
				loadInput: async (ctx, inputId) => {
					const task = await findTaskByIdRepo(inputId).catch(() => null);
					if (
						!task ||
						task.scanJobId !== ctx.scanJob.scanJobId ||
						task.stageName !== SCAN_STAGE_IDS.functionScan ||
						task.status !== "pending" ||
						!task.input
					) {
						return undefined;
					}
					return task.input as ScanTargetStageInput;
				},
			}),
		});
	const analysisStage = createAnalysisStageDefinition<FullScanPipelineContext>({
		id: SCAN_STAGE_METADATA.analysis.id,
		name: SCAN_STAGE_METADATA.analysis.name,
		persistent: false,
		reuseContainer: true,
		outputSchema: getDefinitionsStageOutputSchema(
			pipelineDefinitions,
			SCAN_STAGE_IDS.analysis,
		),
		queue: createStageQueueBinding({
			queue: analysisQueue,
			getGroupQueue: (groupInstanceId) =>
				getScanStageGroupQueue(scanJob.scanJobId, groupInstanceId, "analysis"),
			obliterateGroupQueue: (groupInstanceId) =>
				obliterateScanStageGroupQueue(
					scanJob.scanJobId,
					groupInstanceId,
					"analysis",
				),
			ownsInputId: async (ctx, inputId, _jobData, _jobId, scope) => {
				const task = await findTaskByIdRepo(inputId).catch(() => null);
				return Boolean(
					task &&
						task.scanJobId === ctx.scanJob.scanJobId &&
						task.stageName === SCAN_STAGE_IDS.analysis &&
						(await taskMatchesStageQueueScope(task, scope?.groupInstanceId)),
				);
			},
			loadInput: async (ctx, inputId) => {
				const task = await findTaskByIdRepo(inputId).catch(() => null);
				if (
					!task ||
					task.scanJobId !== ctx.scanJob.scanJobId ||
					task.stageName !== SCAN_STAGE_IDS.analysis ||
					task.status !== "pending" ||
					!task.input
				) {
					return undefined;
				}
				return task.input as CandidateAnalysisStageInput;
			},
		}),
	});
	const analysisCriticStage =
		createAnalysisCriticStageDefinition<FullScanPipelineContext>({
			id: SCAN_STAGE_METADATA.analysisCritic.id,
			name: SCAN_STAGE_METADATA.analysisCritic.name,
			persistent: false,
			reuseContainer: true,
			outputSchema: getDefinitionsStageOutputSchema(
				pipelineDefinitions,
				SCAN_STAGE_IDS.analysisCritic,
			),
			queue: createStageQueueBinding({
				queue: analysisCriticQueue,
				getGroupQueue: (groupInstanceId) =>
					getScanStageGroupQueue(
						scanJob.scanJobId,
						groupInstanceId,
						"analysis-critic",
					),
				obliterateGroupQueue: (groupInstanceId) =>
					obliterateScanStageGroupQueue(
						scanJob.scanJobId,
						groupInstanceId,
						"analysis-critic",
					),
				ownsInputId: async (ctx, inputId, _jobData, _jobId, scope) => {
					const task = await findTaskByIdRepo(inputId).catch(() => null);
					return Boolean(
						task &&
							task.scanJobId === ctx.scanJob.scanJobId &&
							task.stageName === SCAN_STAGE_IDS.analysisCritic &&
							(await taskMatchesStageQueueScope(task, scope?.groupInstanceId)),
					);
				},
				loadInput: async (ctx, inputId) => {
					const task = await findTaskByIdRepo(inputId).catch(() => null);
					if (
						!task ||
						task.scanJobId !== ctx.scanJob.scanJobId ||
						task.stageName !== SCAN_STAGE_IDS.analysisCritic ||
						task.status !== "pending" ||
						!task.input
					) {
						return undefined;
					}
					return task.input as AnalysisCriticStageInput;
				},
			}),
		});
	const verifyingStage =
		createVerifyingStageDefinition<FullScanPipelineContext>({
			id: SCAN_STAGE_METADATA.verification.id,
			name: SCAN_STAGE_METADATA.verification.name,
			persistent: true,
			reuseContainer: true,
			outputSchema: getDefinitionsStageOutputSchema(
				pipelineDefinitions,
				SCAN_STAGE_IDS.verification,
			),
			queue: createStageQueueBinding({
				queue: verificationQueue,
				getGroupQueue: (groupInstanceId) =>
					getScanStageGroupQueue(
						scanJob.scanJobId,
						groupInstanceId,
						"verification",
					),
				obliterateGroupQueue: (groupInstanceId) =>
					obliterateScanStageGroupQueue(
						scanJob.scanJobId,
						groupInstanceId,
						"verification",
					),
				ownsInputId: async (ctx, inputId, _jobData, _jobId, scope) => {
					const task = await findTaskByIdRepo(inputId).catch(() => null);
					return Boolean(
						task &&
							task.scanJobId === ctx.scanJob.scanJobId &&
							task.stageName === SCAN_STAGE_IDS.verification &&
							(await taskMatchesStageQueueScope(task, scope?.groupInstanceId)),
					);
				},
				loadInput: async (ctx, inputId) => {
					const task = await findTaskByIdRepo(inputId).catch(() => null);
					if (
						!task ||
						task.scanJobId !== ctx.scanJob.scanJobId ||
						task.stageName !== SCAN_STAGE_IDS.verification ||
						task.status !== "pending" ||
						!task.input
					) {
						return undefined;
					}
					return task.input as CandidateVerificationStageInput;
				},
			}),
		});
	const triageStage = createTriageStageDefinition<FullScanPipelineContext>({
		id: SCAN_STAGE_METADATA.triage.id,
		name: SCAN_STAGE_METADATA.triage.name,
		persistent: true,
		reuseContainer: true,
		outputSchema: getDefinitionsStageOutputSchema(
			pipelineDefinitions,
			SCAN_STAGE_IDS.triage,
		),
		queue: createStageQueueBinding({
			queue: triageQueue,
			getGroupQueue: (groupInstanceId) =>
				getScanStageGroupQueue(scanJob.scanJobId, groupInstanceId, "triage"),
			obliterateGroupQueue: (groupInstanceId) =>
				obliterateScanStageGroupQueue(
					scanJob.scanJobId,
					groupInstanceId,
					"triage",
				),
			ownsInputId: async (ctx, inputId, _jobData, _jobId, scope) => {
				const task = await findTaskByIdRepo(inputId).catch(() => null);
				return Boolean(
					task &&
						task.scanJobId === ctx.scanJob.scanJobId &&
						task.stageName === SCAN_STAGE_IDS.triage &&
						(await taskMatchesStageQueueScope(task, scope?.groupInstanceId)),
				);
			},
			loadInput: async (ctx, inputId) => {
				const task = await findTaskByIdRepo(inputId).catch(() => null);
				if (
					!task ||
					task.scanJobId !== ctx.scanJob.scanJobId ||
					task.stageName !== SCAN_STAGE_IDS.triage ||
					task.status !== "pending" ||
					!task.input
				) {
					return undefined;
				}
				return task.input as CandidateTriageStageInput;
			},
		}),
	});

	const stages = [
		repositoryStage,
		attackSurfaceModelStage,
		moduleStage,
		functionStage,
		analysisStage,
		analysisCriticStage,
		verifyingStage,
		triageStage,
	] as const;
	const runtimeStages = attachStageRuntimeConfigs(scanJob.scanJobId, stages);
	const edges = [
		createPipelineEdge<
			FullScanPipelineContext,
			typeof repositoryStage,
			AttackSurfaceModelStageInput,
			typeof attackSurfaceModelStage
		>({
			name: "repository-profile-to-attack-surface-model",
			from: repositoryStage,
			to: attackSurfaceModelStage,
			fork: false,
			transformOutput: async ({ ctx, stageOutput }) =>
				stageOutput.modules.map((modulePath) => ({
					scanJob: ctx.scanJob,
					repositoryPath: stageOutput.repository,
					modulePath,
					moduleId: "",
					moduleName: "",
					priority: null,
				})),
			createTasks: async ({ fromTaskId, nextInputObjects }) => {
				const fromTask = await findTaskByIdRepo(fromTaskId);
				const fromTaskDir = await resolveExistingFullScanTaskRuntimeDir(
					context,
					fromTask,
				);
				const taskIds: string[] = [];
				for (const manifestInput of nextInputObjects) {
					const module = await readTaskJsonArtifact<CanonicalRepositoryModule>({
						taskDir: fromTaskDir,
						containerPath: manifestInput.modulePath,
					});
					const taskId = createShortTaskId();
					const taskName = module.name;
					const toTaskDir = await resolveFullScanTaskRuntimeDir(context, {
						taskId,
						stageName: SCAN_STAGE_IDS.attackSurfaceModel,
						taskName,
					});
					const repositoryPath = await copyArtifactToDownstreamInput({
						fromTaskDir,
						fromPath: manifestInput.repositoryPath,
						toTaskDir,
						toRelativePath: "inputs/repository.json",
					});
					const modulePath = await copyArtifactToDownstreamInput({
						fromTaskDir,
						fromPath: manifestInput.modulePath,
						toTaskDir,
						toRelativePath: "inputs/module.json",
					});
					const downstreamInput: AttackSurfaceModelStageInput = {
						scanJob: context.scanJob,
						repositoryPath,
						modulePath,
						moduleId: module.moduleId,
						moduleName: module.name,
						priority: module.priority,
					};
					const task = await createTaskRepo({
						taskId,
						scanJobId: context.scanJob.scanJobId,
						parentTaskId: fromTaskId,
						name: taskName,
						stageName: SCAN_STAGE_IDS.attackSurfaceModel,
						priority: module.priority,
						input: downstreamInput,
					});
					taskIds.push(task.taskId);
				}
				return taskIds;
			},
		}),
		createPipelineEdge<
			FullScanPipelineContext,
			typeof attackSurfaceModelStage,
			IdentifyTargetStageInput,
			typeof moduleStage
		>({
			name: "attack-surface-model-to-identify-target",
			from: attackSurfaceModelStage,
			to: moduleStage,
			fork: false,
				transformOutput: async ({ stageInput, stageOutput }) => [
				{
					scanJob: stageInput.scanJob,
					repositoryPath: stageInput.repositoryPath,
					modulePath: stageOutput.module,
					threatModelPath: stageOutput.threatModel,
					moduleId: stageInput.moduleId,
					moduleName: stageInput.moduleName,
					priority: stageInput.priority,
				},
			],
			createTasks: async ({ fromTaskId, nextInputObjects }) => {
				const fromTask = await findTaskByIdRepo(fromTaskId);
				const fromTaskDir = await resolveExistingFullScanTaskRuntimeDir(
					context,
					fromTask,
				);
				const taskIds: string[] = [];
				for (const manifestInput of nextInputObjects) {
					const module = await readTaskJsonArtifact<CanonicalRepositoryModule>({
						taskDir: fromTaskDir,
						containerPath: manifestInput.modulePath,
					});
					const taskId = createShortTaskId();
					const taskName = module.name;
					const toTaskDir = await resolveFullScanTaskRuntimeDir(context, {
						taskId,
						stageName: SCAN_STAGE_IDS.moduleScan,
						taskName,
					});
					const repositoryPath = await copyArtifactToDownstreamInput({
						fromTaskDir,
						fromPath: manifestInput.repositoryPath,
						toTaskDir,
						toRelativePath: "inputs/repository.json",
					});
					const modulePath = await copyArtifactToDownstreamInput({
						fromTaskDir,
						fromPath: manifestInput.modulePath,
						toTaskDir,
						toRelativePath: "inputs/module.json",
					});
					const threatModelPath = await copyArtifactToDownstreamInput({
						fromTaskDir,
						fromPath: manifestInput.threatModelPath,
						toTaskDir,
						toRelativePath: "inputs/module-threat-model.json",
					});
					const downstreamInput: IdentifyTargetStageInput = {
						scanJob: manifestInput.scanJob,
						repositoryPath,
						modulePath,
						threatModelPath,
						moduleId: module.moduleId,
						moduleName: module.name,
						priority: module.priority,
					};
					const task = await createTaskRepo({
						taskId,
						scanJobId: context.scanJob.scanJobId,
						parentTaskId: fromTaskId,
						name: taskName,
						stageName: SCAN_STAGE_IDS.moduleScan,
						priority: module.priority,
						input: downstreamInput,
					});
					taskIds.push(task.taskId);
				}
				return taskIds;
			},
		}),
		createPipelineEdge<
			FullScanPipelineContext,
			typeof moduleStage,
			ScanTargetStageInput,
			typeof functionStage
		>({
			name: "identify-target-to-scan-target",
			from: moduleStage,
			to: functionStage,
			fork: false,
			transformOutput: async ({ stageInput, stageOutput }) =>
				(stageOutput.targets || []).map((targetPath) => ({
					scanJob: stageInput.scanJob,
					repositoryPath: stageInput.repositoryPath,
					modulePath: stageOutput.module,
					threatModelPath: stageOutput.threatModel,
					targetPath,
					moduleId: stageInput.moduleId,
					moduleName: stageInput.moduleName,
					targetId: "",
					targetName: "",
					targetKind: "unknown",
					priority: null,
				})),
			createTasks: async ({ fromTaskId, nextInputObjects }) => {
				const fromTask = await findTaskByIdRepo(fromTaskId);
				const fromTaskDir = await resolveExistingFullScanTaskRuntimeDir(
					context,
					fromTask,
				);
				const taskIds: string[] = [];
				for (const manifestInput of nextInputObjects) {
					const target = await readTaskJsonArtifact<CanonicalTarget>({
						taskDir: fromTaskDir,
						containerPath: manifestInput.targetPath,
					});
					const taskId = createShortTaskId();
					const taskName = target.targetName;
					const toTaskDir = await resolveFullScanTaskRuntimeDir(context, {
						taskId,
						stageName: SCAN_STAGE_IDS.functionScan,
						taskName,
					});
					const repositoryPath = await copyArtifactToDownstreamInput({
						fromTaskDir,
						fromPath: manifestInput.repositoryPath,
						toTaskDir,
						toRelativePath: "inputs/repository.json",
					});
					const modulePath = await copyArtifactToDownstreamInput({
						fromTaskDir,
						fromPath: manifestInput.modulePath,
						toTaskDir,
						toRelativePath: "inputs/module.json",
					});
					const threatModelPath = await copyArtifactToDownstreamInput({
						fromTaskDir,
						fromPath: manifestInput.threatModelPath,
						toTaskDir,
						toRelativePath: "inputs/module-threat-model.json",
					});
					const targetPath = await copyArtifactToDownstreamInput({
						fromTaskDir,
						fromPath: manifestInput.targetPath,
						toTaskDir,
						toRelativePath: "inputs/target.json",
					});
					const downstreamInput: ScanTargetStageInput = {
						scanJob: manifestInput.scanJob,
						repositoryPath,
						modulePath,
						threatModelPath,
						targetPath,
						moduleId: target.moduleId,
						moduleName: target.moduleName,
						targetId: target.targetId,
						targetName: target.targetName,
						targetKind: target.targetKind,
						filePath: target.filePath,
						line: target.line,
						summary: target.summary,
						priority: target.priority,
					};
					const task = await createTaskRepo({
						taskId,
						scanJobId: context.scanJob.scanJobId,
						parentTaskId: fromTaskId,
						name: taskName,
						stageName: SCAN_STAGE_IDS.functionScan,
						priority: target.priority,
						input: downstreamInput,
					});
					taskIds.push(task.taskId);
				}
				return taskIds;
			},
		}),
		createPipelineEdge<
			FullScanPipelineContext,
			typeof functionStage,
			CandidateAnalysisStageInput,
			typeof analysisStage
		>({
			name: "scan-target-to-analyze-finding",
			from: functionStage,
			to: analysisStage,
			fork: false,
			transformOutput: async ({ stageInput, stageOutput }) =>
				(stageOutput?.candidates ?? []).map((candidatePath) => ({
					scanJob: stageInput.scanJob,
					repositoryPath: stageInput.repositoryPath,
					modulePath: stageInput.modulePath,
					functionPath: stageInput.targetPath,
					candidatePath,
				})),
			createTasks: async ({ fromTaskId, nextInputObjects }) => {
				const fromTask = await findTaskByIdRepo(fromTaskId);
				const fromTaskDir = await resolveExistingFullScanTaskRuntimeDir(
					context,
					fromTask,
				);
				const taskIds: string[] = [];
				for (const manifestInput of nextInputObjects) {
					const candidate = await readTaskJsonArtifact<CanonicalCandidate>({
						taskDir: fromTaskDir,
						containerPath: manifestInput.candidatePath,
					});
					const taskId = createShortTaskId();
					const taskName = `Candidate Analysis: ${candidate.title}`;
					const toTaskDir = await resolveFullScanTaskRuntimeDir(context, {
						taskId,
						stageName: SCAN_STAGE_IDS.analysis,
						taskName,
					});
					const analysisInput: CandidateAnalysisStageInput = {
						scanJob: manifestInput.scanJob,
						repositoryPath: await copyArtifactToDownstreamInput({
							fromTaskDir,
							fromPath: manifestInput.repositoryPath,
							toTaskDir,
							toRelativePath: "inputs/repository.json",
						}),
						modulePath: await copyArtifactToDownstreamInput({
							fromTaskDir,
							fromPath: manifestInput.modulePath,
							toTaskDir,
							toRelativePath: "inputs/module.json",
						}),
						functionPath: await copyArtifactToDownstreamInput({
							fromTaskDir,
							fromPath: manifestInput.functionPath,
							toTaskDir,
							toRelativePath: "inputs/target.json",
						}),
						candidatePath: await copyArtifactToDownstreamInput({
							fromTaskDir,
							fromPath: manifestInput.candidatePath,
							toTaskDir,
							toRelativePath: "inputs/candidate.json",
						}),
						analysisReportTemplatePath:
							await writeAnalysisReportTemplateInput({
								scanJob: manifestInput.scanJob,
								toTaskDir,
							}),
					};
					const task = await createTaskRepo({
						taskId,
						scanJobId: context.scanJob.scanJobId,
						parentTaskId: fromTaskId,
						name: taskName,
						stageName: SCAN_STAGE_IDS.analysis,
						input: analysisInput,
					});
					taskIds.push(task.taskId);
				}
				return taskIds;
			},
		}),
		createPipelineEdge<
			FullScanPipelineContext,
			typeof analysisStage,
			AnalysisCriticStageInput,
			typeof analysisCriticStage,
			Analysis
		>({
			name: "analyze-finding-to-critique-finding",
			from: analysisStage,
			to: analysisCriticStage,
			route: { key: "critic", default: true },
			outputSchema: analysisSchema,
			outputSchemaDescription: "Draft analysisSchema result for critic review",
				fork: false,
				transformOutput: async ({ stageInput, stageOutput }) => [
				{
					...stageInput,
					draftAnalysisPath: "",
					analysisFingerprint: buildAnalysisFingerprint(stageOutput),
				},
			],
			createTasks: async ({
				fromTaskId,
				stageInput,
				stageOutput,
				nextInputObjects,
			}) => {
				const fromTask = await findTaskByIdRepo(fromTaskId);
				const fromTaskDir = await resolveExistingFullScanTaskRuntimeDir(
					context,
					fromTask,
				);
				const candidate = await readTaskJsonArtifact<CanonicalCandidate>({
					taskDir: fromTaskDir,
					containerPath: stageInput.candidatePath,
				});
				const taskIds: string[] = [];
				for (const manifestInput of nextInputObjects) {
					const taskId = createShortTaskId();
					const taskName = `Analysis Critic: ${candidate.title}`;
					const toTaskDir = await resolveFullScanTaskRuntimeDir(context, {
						taskId,
						stageName: SCAN_STAGE_IDS.analysisCritic,
						taskName,
					});
					const downstreamInput: AnalysisCriticStageInput = {
						...(await copyAnalysisBaseInputArtifacts({
							fromTaskDir,
							toTaskDir,
							stageInput,
						})),
						draftAnalysisPath: await writeDownstreamInputArtifact({
							toTaskDir,
							toRelativePath: "inputs/draft-analysis.json",
							value: stageOutput,
						}),
						analysisFingerprint: manifestInput.analysisFingerprint,
					};
					const task = await createTaskRepo({
						taskId,
						scanJobId: stageInput.scanJob.scanJobId,
						parentTaskId: fromTaskId,
						name: taskName,
						stageName: SCAN_STAGE_IDS.analysisCritic,
						input: downstreamInput,
					});
					taskIds.push(task.taskId);
				}
				return taskIds;
			},
		}),
		createPipelineEdge<
			FullScanPipelineContext,
			typeof analysisStage,
			CandidateVerificationStageInput,
			typeof verifyingStage,
			FinalAnalysis
		>({
			name: "analyze-finding-to-verify-finding",
			from: analysisStage,
			to: verifyingStage,
			fork: false,
			route: { key: "verification" },
			outputSchema: finalAnalysisSchema,
			outputSchemaDescription: "Final critic-approved analysis result",
			transformOutput: async ({ stageInput, stageOutput }) => {
				if (!shouldVerifyFromAnalysisResult(stageOutput.result)) {
					return [];
				}
				return [
					{
						scanJob: stageInput.scanJob,
						repositoryPath: stageInput.repositoryPath,
						modulePath: stageInput.modulePath,
						functionPath: stageInput.functionPath,
						candidatePath: stageInput.candidatePath,
						analysisResultPath: "",
					},
				];
			},
			createTasks: async ({
				fromTaskId,
				stageInput,
				stageOutput,
				nextInputObjects,
			}) => {
				const fromTask = await findTaskByIdRepo(fromTaskId);
				const fromTaskDir = await resolveExistingFullScanTaskRuntimeDir(
					context,
					fromTask,
				);
				const candidate = await readTaskJsonArtifact<CanonicalCandidate>({
					taskDir: fromTaskDir,
					containerPath: stageInput.candidatePath,
				});
				const feedbackEnvelope = stageInput.feedbackPath
					? analysisFeedbackEnvelopeSchema.parse(
							await readTaskJsonArtifact<unknown>({
								taskDir: fromTaskDir,
								containerPath: stageInput.feedbackPath,
							}),
						)
					: null;
				const criticFeedback =
					feedbackEnvelope?.kind === "critic" ? feedbackEnvelope.result : null;
				if (
					!criticFeedback ||
					criticFeedback.stance !== "convinced" ||
					criticFeedback.reviewedAnalysisFingerprint !==
						stageOutput.analysisFingerprint ||
					stageOutput.criticApproval.reviewedAnalysisFingerprint !==
						stageOutput.analysisFingerprint
				) {
					throw new Error(
						"Final analysis requires a critic feedback envelope with a matching convinced critic response",
					);
				}
				const taskIds: string[] = [];
				for (const _manifestInput of nextInputObjects) {
					const taskId = createShortTaskId();
					const taskName = `Candidate Verification: ${candidate.title}`;
					const toTaskDir = await resolveFullScanTaskRuntimeDir(context, {
						taskId,
						stageName: SCAN_STAGE_IDS.verification,
						taskName,
					});
					const baseInput = await copyAnalysisBaseInputArtifacts({
						fromTaskDir,
						toTaskDir,
						stageInput,
					});
					const downstreamInput: CandidateVerificationStageInput = {
						scanJob: baseInput.scanJob,
						repositoryPath: baseInput.repositoryPath,
						modulePath: baseInput.modulePath,
						functionPath: baseInput.functionPath,
						candidatePath: baseInput.candidatePath,
						analysisResultPath: await writeDownstreamInputArtifact({
							toTaskDir,
							toRelativePath: "inputs/final-analysis.json",
							value: stageOutput,
						}),
					};
					const task = await createTaskRepo({
						taskId,
						scanJobId: stageInput.scanJob.scanJobId,
						parentTaskId: fromTaskId,
						name: taskName,
						stageName: SCAN_STAGE_IDS.verification,
						input: downstreamInput,
					});
					taskIds.push(task.taskId);
				}
				return taskIds;
			},
		}),
		createPipelineEdge<
			FullScanPipelineContext,
			typeof verifyingStage,
			CandidateTriageStageInput,
			typeof triageStage,
			Verification
		>({
			name: "verify-finding-to-triage-finding",
			from: verifyingStage,
			to: triageStage,
			fork: false,
			outputSchema: verificationSchema,
			transformOutput: async ({ stageInput, stageOutput }) => {
				if (stageOutput.result !== "true" && stageOutput.result !== "likely") {
					return [];
				}
				return [
					{
						scanJob: stageInput.scanJob,
						repositoryPath: stageInput.repositoryPath,
						modulePath: stageInput.modulePath,
						functionPath: stageInput.functionPath,
						candidatePath: stageInput.candidatePath,
						analysisResultPath: stageInput.analysisResultPath,
						verifyResultPath: "",
					},
				];
			},
			createTasks: async ({
				fromTaskId,
				stageInput,
				stageOutput,
				nextInputObjects,
			}) => {
				const fromTask = await findTaskByIdRepo(fromTaskId);
				const fromTaskDir = await resolveExistingFullScanTaskRuntimeDir(
					context,
					fromTask,
				);
				const candidate = await readTaskJsonArtifact<CanonicalCandidate>({
					taskDir: fromTaskDir,
					containerPath: stageInput.candidatePath,
				});
				const taskIds: string[] = [];
				for (const _downstreamInput of nextInputObjects) {
					const taskId = createShortTaskId();
					const taskName = `Candidate Triage: ${candidate.title}`;
					const toTaskDir = await resolveFullScanTaskRuntimeDir(context, {
						taskId,
						stageName: SCAN_STAGE_IDS.triage,
						taskName,
					});
					const downstreamInput: CandidateTriageStageInput = {
						scanJob: stageInput.scanJob,
						repositoryPath: await copyArtifactToDownstreamInput({
							fromTaskDir,
							fromPath: stageInput.repositoryPath,
							toTaskDir,
							toRelativePath: "inputs/repository.json",
						}),
						modulePath: await copyArtifactToDownstreamInput({
							fromTaskDir,
							fromPath: stageInput.modulePath,
							toTaskDir,
							toRelativePath: "inputs/module.json",
						}),
						functionPath: await copyArtifactToDownstreamInput({
							fromTaskDir,
							fromPath: stageInput.functionPath,
							toTaskDir,
							toRelativePath: "inputs/target.json",
						}),
						candidatePath: await copyArtifactToDownstreamInput({
							fromTaskDir,
							fromPath: stageInput.candidatePath,
							toTaskDir,
							toRelativePath: "inputs/candidate.json",
						}),
						analysisResultPath: await copyArtifactToDownstreamInput({
							fromTaskDir,
							fromPath: stageInput.analysisResultPath,
							toTaskDir,
							toRelativePath: "inputs/final-analysis.json",
						}),
						verifyResultPath: await writeDownstreamInputArtifact({
							toTaskDir,
							toRelativePath: "inputs/verify-result.json",
							value: stageOutput,
						}),
					};
					const task = await createTaskRepo({
						taskId,
						scanJobId: stageInput.scanJob.scanJobId,
						parentTaskId: fromTaskId,
						name: taskName,
						stageName: SCAN_STAGE_IDS.triage,
						input: downstreamInput,
					});
					taskIds.push(task.taskId);
				}
				return taskIds;
			},
		}),
		createPipelineEdge<
			FullScanPipelineContext,
			typeof analysisCriticStage,
			CandidateAnalysisStageInput,
			typeof analysisStage,
			CriticResponse
		>({
			name: "critique-finding-to-analyze-finding",
			from: analysisCriticStage,
			to: analysisStage,
			route: { key: "analysis", default: true },
			outputSchema: criticResponseSchema,
			outputSchemaDescription: "CriticResponse feedback for analysis",
				transformOutput: async ({ stageInput }) => [
				{
					scanJob: stageInput.scanJob,
					repositoryPath: stageInput.repositoryPath,
					modulePath: stageInput.modulePath,
					functionPath: stageInput.functionPath,
					candidatePath: stageInput.candidatePath,
					feedbackPath: "",
				},
			],
			createTasks: async ({
				fromTaskId,
				stageInput,
				stageOutput,
				nextInputObjects,
			}) => {
				const fromTask = await findTaskByIdRepo(fromTaskId);
				const fromTaskDir = await resolveExistingFullScanTaskRuntimeDir(
					context,
					fromTask,
				);
				const candidate = await readTaskJsonArtifact<CanonicalCandidate>({
					taskDir: fromTaskDir,
					containerPath: stageInput.candidatePath,
				});
				const taskIds: string[] = [];
				for (const _manifestInput of nextInputObjects) {
					const taskId = createShortTaskId();
					const taskName = `Candidate Analysis: ${candidate.title}`;
					const toTaskDir = await resolveFullScanTaskRuntimeDir(context, {
						taskId,
						stageName: SCAN_STAGE_IDS.analysis,
						taskName,
					});
					const downstreamInput: CandidateAnalysisStageInput = {
						...(await copyAnalysisBaseInputArtifacts({
							fromTaskDir,
							toTaskDir,
							stageInput,
						})),
						feedbackPath: await writeDownstreamInputArtifact({
							toTaskDir,
							toRelativePath: "inputs/feedback.json",
							value: {
								kind: "critic",
								result: stageOutput,
							},
						}),
					};
					const task = await createTaskRepo({
						taskId,
						scanJobId: stageInput.scanJob.scanJobId,
						parentTaskId: fromTaskId,
						name: taskName,
						stageName: SCAN_STAGE_IDS.analysis,
						input: downstreamInput,
					});
					taskIds.push(task.taskId);
				}
				return taskIds;
			},
		}),
	] as const;
	const stageRegistry = new Map<string, FullScanPipelineStage>(
		runtimeStages.map((stage) => [stage.id, stage]),
	);
	const edgeRegistry = new Map<string, FullScanPipelineEdge>(
		edges.map((edge) => [edge.name, edge]),
	);
	const pipelineConfig = pipelineDefinitions.pipelines.full;
	const pipeline: PipelineDefinition<
		FullScanPipelineContext,
		FullScanPipelineStage[],
		FullScanPipelineEdge[]
	> = createPipelineDefinition({
		name: pipelineConfig.name,
		stages: buildPipelineStagesFromDefinitions(pipelineConfig, stageRegistry),
		edges: buildPipelineEdgesFromDefinitions(
			pipelineDefinitions,
			pipelineConfig,
			edgeRegistry,
		),
		groups: buildPipelineGroupsFromDefinitions(pipelineConfig, stageRegistry),
	});

	return pipeline;
};

const buildSyntheticDeltaModule = (
	functions: CanonicalFunction[],
): CanonicalModule => {
	const files = [
		...new Set(
			functions
				.map((func) => func.filePath)
				.filter((filePath): filePath is string => Boolean(filePath)),
		),
	].slice(0, 200);
	const entryPoints = [
		...new Set(
			functions
				.map((func) => func.functionName)
				.filter((functionName): functionName is string =>
					Boolean(functionName),
				),
		),
	].slice(0, 200);
	return {
		id: "delta-scope",
		moduleId: "delta-scope",
		name: "Delta Scope",
		summary:
			"Synthetic compatibility module for functions selected by delta impact scoping.",
		priority: 1,
		files,
		entryPoints,
		trustBoundaries: ["Diff-affected runtime behavior"],
		attackSurfaces: ["Functions affected by the target/base diff"],
		vulnerabilityThemes: ["Delta-scoped security review"],
		runtimeComponents: ["delta-scope"],
		notes: [
			"This module is generated internally for scan-target input shaping and is not a delta-scope output artifact.",
		],
	};
};

const buildSyntheticDeltaThreatModel = (
	module: CanonicalModule,
	functions: CanonicalFunction[],
): CanonicalModuleThreatModel => ({
	moduleId: module.moduleId,
	moduleName: module.name,
	modulePath: "/task/inputs/module.json",
	assets: ["Diff-affected runtime behavior"],
	entrypoints: functions
		.map((func) => func.functionName)
		.filter((name): name is string => Boolean(name))
		.slice(0, 200),
	trustBoundaries: module.trustBoundaries,
	attackerInputs: [
		"Inputs reaching diff-affected functions or call paths selected by delta scope",
	],
	sinkClasses: [
		"diff-affected security-sensitive sink",
		"authorization decision",
		"input validation boundary",
	],
	likelyVulnerabilityClasses: ["Delta-scoped vulnerability regression"],
	rulePriorities: [],
	securityAssumptions: [
		"Delta scan uses repository diff impact scoping and wraps selected functions as generic scan targets.",
	],
	assumptions: [
		"Only changed or diff-impacted functions are in scope for this delta scan.",
	],
	limitations: [
		"Synthetic delta threat model is narrower than a full repository attack-surface model.",
	],
	summary:
		"Synthetic attack surface model for diff-affected targets selected by delta scope.",
});

const buildTargetFromDeltaFunction = (
	func: CanonicalFunction,
): CanonicalTarget => ({
	id: func.id || func.functionId,
	moduleId: func.moduleId || "delta-scope",
	moduleName: func.moduleName || "Delta Scope",
	targetId: func.functionId,
	targetName: func.functionName,
	targetKind: "function",
	language: null,
	framework: null,
	sourceFiles: func.filePath ? [func.filePath] : ["unknown"],
	filePath: func.filePath,
	line: func.line,
	routePath: null,
	httpMethods: [],
	priority: func.priority,
	summary: func.summary,
	attackerInputs: func.attackSurface ? [func.attackSurface] : [],
	sinks: func.vulnerabilityType ? [func.vulnerabilityType] : [],
	trustBoundary: func.trustBoundary,
	likelyVulnerabilityTypes: func.likelyVulnerabilityTypes || [],
	evidence: [func.sourceToSinkHint, func.priorityReason].filter(
		(value): value is string => Boolean(value),
	),
	score: func.score,
	excludeReason: func.excludeReason,
	priorityReason: func.priorityReason,
});

const buildDeltaScanPipeline = (context: FullScanPipelineContext) => {
	const { scanJob } = context;
	const deltaScopeQueue = getDeltaScopeQueue(scanJob.scanJobId);
	const basePipeline = buildFullScanPipeline(context);
	const functionStage = basePipeline.stages.find(
		(stage) => stage.id === SCAN_STAGE_IDS.functionScan,
	) as FullScanFunctionStage | undefined;
	if (!functionStage) {
		throw new Error("Full scan pipeline did not define scan-target stage");
	}
	const deltaScopeStage =
		createDeltaScopeStageDefinition<FullScanPipelineContext>({
			id: SCAN_STAGE_METADATA.deltaScope.id,
			name: SCAN_STAGE_METADATA.deltaScope.name,
			persistent: false,
			reuseContainer: true,
			mode: "serial",
			outputSchema: getDefinitionsStageOutputSchema(
				resolveScanJobPipelineDefinitions(scanJob),
				SCAN_STAGE_IDS.deltaScope,
			),
			queue: createStageQueueBinding({
				queue: deltaScopeQueue,
				getGroupQueue: (groupInstanceId) =>
					getScanStageGroupQueue(
						scanJob.scanJobId,
						groupInstanceId,
						"delta-scope",
					),
				obliterateGroupQueue: (groupInstanceId) =>
					obliterateScanStageGroupQueue(
						scanJob.scanJobId,
						groupInstanceId,
						"delta-scope",
					),
				ownsInputId: async (ctx, inputId, _jobData, _jobId, scope) => {
					const task = await findTaskByIdRepo(inputId).catch(() => null);
					return Boolean(
						task &&
							task.scanJobId === ctx.scanJob.scanJobId &&
							task.stageName === SCAN_STAGE_IDS.deltaScope &&
							(await taskMatchesStageQueueScope(task, scope?.groupInstanceId)),
					);
				},
				loadInput: async (ctx, inputId) => {
					const task = await findTaskByIdRepo(inputId).catch(() => null);
					if (
						!task ||
						task.scanJobId !== ctx.scanJob.scanJobId ||
						task.stageName !== SCAN_STAGE_IDS.deltaScope ||
						task.status !== "pending"
					) {
						return undefined;
					}
					return null;
				},
			}),
		});
	const deltaScopeToFunctionEdge = createPipelineEdge<
		FullScanPipelineContext,
		typeof deltaScopeStage,
		DeltaScopeFunctionInput,
		FullScanFunctionStage
	>({
			name: "delta-scope-to-function",
			from: deltaScopeStage,
			to: functionStage,
			fork: false,
			transformOutput: async ({
				ctx,
				stageOutput,
			}): Promise<DeltaScopeFunctionInput[]> =>
				stageOutput.functions.map((functionPath) => ({
					scanJob: ctx.scanJob,
					repositoryPath: stageOutput.repository,
					modulePath: "",
					threatModelPath: "",
					targetPath: functionPath,
					moduleId: "delta-scope",
					moduleName: "Delta Scope",
					targetId: "",
					targetName: "",
					targetKind: "function",
					priority: null,
				})),
			createTasks: async ({ fromTaskId, stageOutput, nextInputObjects }) => {
				const fromTask = await findTaskByIdRepo(fromTaskId);
				const fromTaskDir = await resolveExistingFullScanTaskRuntimeDir(
					context,
					fromTask,
				);
				const scopedFunctions = await Promise.all(
					stageOutput.functions.map((functionPath) =>
						readTaskJsonArtifact<CanonicalFunction>({
							taskDir: fromTaskDir,
							containerPath: functionPath,
						}),
					),
				);
				const syntheticModule = buildSyntheticDeltaModule(scopedFunctions);
				const syntheticThreatModel = buildSyntheticDeltaThreatModel(
					syntheticModule,
					scopedFunctions,
				);
				const taskIds: string[] = [];
				for (const manifestInput of nextInputObjects) {
					const func = await readTaskJsonArtifact<CanonicalFunction>({
						taskDir: fromTaskDir,
						containerPath: manifestInput.targetPath,
					});
					const target = buildTargetFromDeltaFunction(func);
					const taskId = createShortTaskId();
					const taskName = func.functionName;
					const toTaskDir = await resolveFullScanTaskRuntimeDir(context, {
						taskId,
						stageName: SCAN_STAGE_IDS.functionScan,
						taskName,
					});
					const repositoryPath = await copyArtifactToDownstreamInput({
						fromTaskDir,
						fromPath: manifestInput.repositoryPath,
						toTaskDir,
						toRelativePath: "inputs/repository.json",
					});
					const modulePath = await writeDownstreamInputArtifact({
						toTaskDir,
						toRelativePath: "inputs/module.json",
						value: syntheticModule,
					});
					const threatModelPath = await writeDownstreamInputArtifact({
						toTaskDir,
						toRelativePath: "inputs/module-threat-model.json",
						value: syntheticThreatModel,
					});
					const targetPath = await writeDownstreamInputArtifact({
						toTaskDir,
						toRelativePath: "inputs/target.json",
						value: target,
					});
					const downstreamInput: ScanTargetStageInput = {
						scanJob: manifestInput.scanJob,
						repositoryPath,
						modulePath,
						threatModelPath,
						targetPath,
						moduleId: func.moduleId || "delta-scope",
						moduleName: func.moduleName || "Delta Scope",
						targetId: func.functionId,
						targetName: func.functionName,
						targetKind: "function",
						filePath: func.filePath,
						line: func.line,
						summary: func.summary,
						priority: func.priority,
					};
					const task = await createTaskRepo({
						taskId,
						scanJobId: context.scanJob.scanJobId,
						parentTaskId: fromTaskId,
						name: taskName,
						stageName: SCAN_STAGE_IDS.functionScan,
						priority: func.priority,
						input: downstreamInput,
					});
					taskIds.push(task.taskId);
				}
				return taskIds;
			},
		});
	const [runtimeDeltaScopeStage] = attachStageRuntimeConfigs(scanJob.scanJobId, [
		deltaScopeStage,
	]);
	const stageRegistry = new Map<string, FullScanPipelineStage>([
		...basePipeline.stages.map((stage) => [stage.id, stage] as const),
		[runtimeDeltaScopeStage!.id, runtimeDeltaScopeStage!],
	]);
	const edgeRegistry = new Map<string, FullScanPipelineEdge>([
		...basePipeline.edges.map((edge) => [edge.name, edge] as const),
		[deltaScopeToFunctionEdge.name, deltaScopeToFunctionEdge],
	]);
	validatePipelineRegistryCoverage(resolveScanJobPipelineDefinitions(scanJob), {
		stageIds: new Set(stageRegistry.keys()),
		edgeNames: new Set(edgeRegistry.keys()),
	});
	const pipelineDefinitions = resolveScanJobPipelineDefinitions(scanJob);
	const pipelineConfig = pipelineDefinitions.pipelines.delta;
	return createPipelineDefinition<
		FullScanPipelineContext,
		FullScanPipelineStage[],
		FullScanPipelineEdge[]
	>({
		name: pipelineConfig.name,
		stages: buildPipelineStagesFromDefinitions(pipelineConfig, stageRegistry),
		edges: buildPipelineEdgesFromDefinitions(
			pipelineDefinitions,
			pipelineConfig,
			edgeRegistry,
		),
		groups: buildPipelineGroupsFromDefinitions(pipelineConfig, stageRegistry),
	});
};

const runFullScan = async (
	scanJobId: string,
	options?: {
		enqueueInitialRepositoryTask?: boolean;
		awaitCompletion?: boolean;
	},
) => {
	const enqueueInitialRepositoryTask =
		options?.enqueueInitialRepositoryTask ?? true;
	const awaitCompletion = options?.awaitCompletion ?? true;
	await assertScanJobNotCancelled(scanJobId);
	console.log(
		"[full-scan]",
		JSON.stringify({
			event: "runFullScan.start",
			scanJobId,
		}),
	);
	const context = await buildFullScanPipelineContext(scanJobId);
	const pipeline = buildFullScanPipeline(context);

	try {
		await assertScanJobNotCancelled(scanJobId);
		await updateTaskRepo(context.scanJob.repositoryTaskId || scanJobId, {
			name: context.projectName,
		}).catch(() => {});
		if (enqueueInitialRepositoryTask) {
			await enqueueRepositoryScanTask(scanJobId);
			console.log(
				"[full-scan]",
				JSON.stringify({
					event: "runFullScan.repository.enqueued",
					scanJobId,
				}),
			);
		}
		await assertScanJobNotCancelled(scanJobId);
		if (awaitCompletion) {
			await runPipeline(pipeline, context);
		} else {
			startPipelineRuntime(pipeline, context);
		}
		console.log(
			"[full-scan]",
			JSON.stringify({
				event: awaitCompletion
					? "runFullScan.completed"
					: "runFullScan.runtime_started",
				scanJobId,
			}),
		);
	} catch (error) {
		console.log(
			"[full-scan]",
			JSON.stringify({
				event: "runFullScan.failed",
				scanJobId,
				errorMessage: error instanceof Error ? error.message : String(error),
			}),
		);
		throw error;
	}
};

const runDeltaScan = async (
	scanJobId: string,
	options?: {
		enqueueInitialDeltaScopeTask?: boolean;
		awaitCompletion?: boolean;
	},
) => {
	const enqueueInitialDeltaScopeTask =
		options?.enqueueInitialDeltaScopeTask ?? true;
	const awaitCompletion = options?.awaitCompletion ?? true;
	await assertScanJobNotCancelled(scanJobId);
	console.log(
		"[delta-scan]",
		JSON.stringify({
			event: "runDeltaScan.start",
			scanJobId,
		}),
	);
	const context = await buildFullScanPipelineContext(scanJobId);
	const pipeline = buildDeltaScanPipeline(context);

	try {
		await assertScanJobNotCancelled(scanJobId);
		await updateTaskRepo(context.scanJob.repositoryTaskId || scanJobId, {
			name: context.projectName,
		}).catch(() => {});
		if (enqueueInitialDeltaScopeTask) {
			await enqueueDeltaScopeTask(scanJobId);
			console.log(
				"[delta-scan]",
				JSON.stringify({
					event: "runDeltaScan.delta_scope.enqueued",
					scanJobId,
				}),
			);
		}
		await assertScanJobNotCancelled(scanJobId);
		if (awaitCompletion) {
			await runPipeline(pipeline, context);
		} else {
			startPipelineRuntime(pipeline, context);
		}
		console.log(
			"[delta-scan]",
			JSON.stringify({
				event: awaitCompletion
					? "runDeltaScan.completed"
					: "runDeltaScan.runtime_started",
				scanJobId,
			}),
		);
	} catch (error) {
		console.log(
			"[delta-scan]",
			JSON.stringify({
				event: "runDeltaScan.failed",
				scanJobId,
				errorMessage: error instanceof Error ? error.message : String(error),
			}),
		);
		throw error;
	}
};

const startScanPipelineRuntimeForExistingQueues = async (scanJobId: string) => {
	const scanJob = await findScanJobByIdRepo(scanJobId);
	if (scanJob.scanType === "delta") {
		await runDeltaScan(scanJobId, {
			enqueueInitialDeltaScopeTask: false,
			awaitCompletion: false,
		});
		return;
	}
	await runFullScan(scanJobId, {
		enqueueInitialRepositoryTask: false,
		awaitCompletion: false,
	});
};

export const pauseScanJob = async (scanJobId: string) => {
	const scanJob = await findScanJobByIdRepo(scanJobId);
	if (scanJob.status === "canceled" || scanJob.status === "finished") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Only pending or running scan jobs can be paused",
		});
	}
	if (scanJob.status === "paused") {
		return {
			paused: true,
			scanJobId,
			stoppedRuntimes: 0,
		};
	}

	await updateScanJobStatusRepo(scanJobId, "paused");
	const stoppedRuntimes = stopPipelineRuntimesForScanJob(scanJobId);
	return {
		paused: true,
		scanJobId,
		stoppedRuntimes,
	};
};

export const resumeScanJob = async (scanJobId: string) => {
	const scanJob = await findScanJobByIdRepo(scanJobId);
	if (scanJob.status !== "paused") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Only paused scan jobs can be resumed",
		});
	}

	await updateScanJobStatusRepo(scanJobId, "running");
	await startScanPipelineRuntimeForExistingQueues(scanJobId);
	return {
		resumed: true,
		scanJobId,
	};
};

export const runScanJobInContainer = async (
	scanJobId: string,
	options?: {
		enqueueInitialRepositoryTask?: boolean;
	},
) => {
	await assertScanJobNotCancelled(scanJobId);
	const scanJob = await findScanJobByIdRepo(scanJobId);
	if (scanJob.scanType === "full") {
		await runFullScan(scanJobId, {
			enqueueInitialRepositoryTask:
				options?.enqueueInitialRepositoryTask ?? true,
		});
		return;
	}
	await runDeltaScan(scanJobId, {
		enqueueInitialDeltaScopeTask:
			options?.enqueueInitialRepositoryTask ?? true,
	});
	return;
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
		throw new Error(
			`Path is outside project profile context root: ${hostPath}`,
		);
	}

	return path.posix.join(
		"/scan-context",
		relativePath.split(path.sep).join("/"),
	);
};

const shouldVerifyFromAnalysisResult = (result: string | null | undefined) =>
	result === "real_vulnerability" || result === "likely_vulnerability";

const readCandidateIdFromTask = (task: Task): string | null => {
	const input = asTaskRecord(task.input);
	const candidate =
		asTaskRecord(input?.candidate) ||
		asTaskRecord(asTaskRecord(input?.analysisResult)?.candidate);
	return readString(candidate, "id");
};

const findCandidateTaskByStage = async (
	scanJobId: string,
	vulnerabilityCandidateId: string,
	stageName:
		| typeof SCAN_STAGE_IDS.analysis
		| typeof SCAN_STAGE_IDS.verification,
) =>
	(
		await listTasksByScanJobAndStageRepo({
			scanJobId,
			stageName,
		})
	).find((task) => {
		return readCandidateIdFromTask(task) === vulnerabilityCandidateId;
	}) || null;

const enqueueRepositoryScanTask = async (scanJobId: string) => {
	const scanJob = await findScanJobByIdRepo(scanJobId);
	const repositoryTaskId = scanJob.repositoryTaskId || scanJobId;
	const repositoryScanQueue = getRepositoryScanQueue(scanJobId);
	await repositoryScanQueue.add("repository", repositoryTaskId, {
		jobId: buildQueueTaskJobId(repositoryScanQueue.name, repositoryTaskId),
		removeOnComplete: true,
		removeOnFail: true,
	});
};

const enqueueDeltaScopeTask = async (scanJobId: string) => {
	const scanJob = await findScanJobByIdRepo(scanJobId);
	const deltaScopeTaskId = scanJob.repositoryTaskId || scanJobId;
	const deltaScopeQueue = getDeltaScopeQueue(scanJobId);
	await deltaScopeQueue.add("delta-scope", deltaScopeTaskId, {
		jobId: buildQueueTaskJobId(deltaScopeQueue.name, deltaScopeTaskId),
		removeOnComplete: true,
		removeOnFail: true,
	});
};

const enqueueRepositoryTask = async (
	scanJobId: string,
	repositoryTaskId: string,
) => {
	const repositoryScanQueue = getRepositoryScanQueue(scanJobId);
	await repositoryScanQueue.add("repository", repositoryTaskId, {
		jobId: buildQueueTaskJobId(repositoryScanQueue.name, repositoryTaskId),
		removeOnComplete: true,
		removeOnFail: true,
	});
};

const enqueueDeltaScopeRootTask = async (
	scanJobId: string,
	deltaScopeTaskId: string,
) => {
	const deltaScopeQueue = getDeltaScopeQueue(scanJobId);
	await deltaScopeQueue.add("delta-scope", deltaScopeTaskId, {
		jobId: buildQueueTaskJobId(deltaScopeQueue.name, deltaScopeTaskId),
		removeOnComplete: true,
		removeOnFail: true,
	});
};

const enqueueAnalysisTask = async (
	scanJobId: string,
	analysisTaskId: string,
) => {
	const analysisQueue = getAnalysisQueue(scanJobId);
	await analysisQueue.add("analysis", analysisTaskId, {
		jobId: buildQueueTaskJobId(analysisQueue.name, analysisTaskId),
		removeOnComplete: true,
		removeOnFail: true,
	});
};

const enqueueModuleScanWork = async (
	scanJobId: string,
	scanModuleTaskId: string,
) => {
	const moduleScanQueue = getModuleScanQueue(scanJobId);
	await moduleScanQueue.add("module", scanModuleTaskId, {
		jobId: buildQueueTaskJobId(moduleScanQueue.name, scanModuleTaskId),
		removeOnComplete: true,
		removeOnFail: true,
	});
};

const enqueueFunctionScanWork = async (
	scanJobId: string,
	functionTaskId: string,
) => {
	const functionScanQueue = getFunctionScanQueue(scanJobId);
	await functionScanQueue.add("function", functionTaskId, {
		jobId: buildQueueTaskJobId(functionScanQueue.name, functionTaskId),
		removeOnComplete: true,
		removeOnFail: true,
	});
};

const enqueueVerificationTask = async (
	scanJobId: string,
	verificationTaskId: string,
) => {
	const verificationQueue = getVerificationQueue(scanJobId);
	await verificationQueue.add("verification", verificationTaskId, {
		jobId: buildQueueTaskJobId(verificationQueue.name, verificationTaskId),
		removeOnComplete: true,
		removeOnFail: true,
	});
};

const enqueueTriageTask = async (scanJobId: string, triageTaskId: string) => {
	const triageQueue = getTriageQueue(scanJobId);
	await triageQueue.add("triage", triageTaskId, {
		jobId: buildQueueTaskJobId(triageQueue.name, triageTaskId),
		removeOnComplete: true,
		removeOnFail: true,
	});
};

const enqueueAnalysisCriticTask = async (
	scanJobId: string,
	analysisCriticTaskId: string,
) => {
	const analysisCriticQueue = getAnalysisCriticQueue(scanJobId);
	await analysisCriticQueue.add("analysis-critic", analysisCriticTaskId, {
		jobId: buildQueueTaskJobId(analysisCriticQueue.name, analysisCriticTaskId),
		removeOnComplete: true,
		removeOnFail: true,
	});
};

const enqueueAttackSurfaceModelTask = async (
	scanJobId: string,
	taskId: string,
) => {
	const queue = getAttackSurfaceModelQueue(scanJobId);
	await queue.add("attack-surface-model", taskId, {
		jobId: buildQueueTaskJobId(queue.name, taskId),
		removeOnComplete: true,
		removeOnFail: true,
	});
};

const enqueueRetriedTask = async (scanJobId: string, task: Task) => {
	switch (task.stageName) {
		case SCAN_STAGE_IDS.deltaScope:
			await enqueueDeltaScopeRootTask(scanJobId, task.taskId);
			return;
		case SCAN_STAGE_IDS.repositoryScan:
			await enqueueRepositoryTask(scanJobId, task.taskId);
			return;
		case SCAN_STAGE_IDS.moduleScan:
			await enqueueModuleScanWork(scanJobId, task.taskId);
			return;
		case SCAN_STAGE_IDS.attackSurfaceModel:
			await enqueueAttackSurfaceModelTask(scanJobId, task.taskId);
			return;
		case SCAN_STAGE_IDS.functionScan:
			await enqueueFunctionScanWork(scanJobId, task.taskId);
			return;
		case SCAN_STAGE_IDS.analysis:
			await enqueueAnalysisTask(scanJobId, task.taskId);
			return;
		case SCAN_STAGE_IDS.analysisCritic:
			await enqueueAnalysisCriticTask(scanJobId, task.taskId);
			return;
		case SCAN_STAGE_IDS.verification:
			await enqueueVerificationTask(scanJobId, task.taskId);
			return;
		case SCAN_STAGE_IDS.triage:
			await enqueueTriageTask(scanJobId, task.taskId);
			return;
		default:
			throw new Error(`Unsupported retry stage: ${task.stageName}`);
	}
};

const forceRemoveStageQueueJob = async (
	queue: Queue<string>,
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

const removeQueuedTaskForRetry = async (scanJobId: string, task: Task) => {
	switch (task.stageName) {
		case SCAN_STAGE_IDS.deltaScope:
			await Promise.all(
				buildKnownQueueJobIdsForTask(getDeltaScopeQueue(scanJobId), task).map(
					(jobId) =>
						forceRemoveStageQueueJob(
							getDeltaScopeQueue(scanJobId),
							jobId,
						).catch(() => {}),
				),
			);
			return;
		case SCAN_STAGE_IDS.repositoryScan:
			await Promise.all(
				buildKnownQueueJobIdsForTask(
					getRepositoryScanQueue(scanJobId),
					task,
				).map((jobId) =>
					forceRemoveStageQueueJob(
						getRepositoryScanQueue(scanJobId),
						jobId,
					).catch(() => {}),
				),
			);
			return;
		case SCAN_STAGE_IDS.moduleScan:
			await Promise.all(
				buildKnownQueueJobIdsForTask(getModuleScanQueue(scanJobId), task).map(
					(jobId) =>
						forceRemoveStageQueueJob(
							getModuleScanQueue(scanJobId),
							jobId,
						).catch(() => {}),
				),
			);
			return;
		case SCAN_STAGE_IDS.attackSurfaceModel:
		{
			const queue = getAttackSurfaceModelQueue(scanJobId);
			await Promise.all(
				buildKnownQueueJobIdsForTask(queue, task).map((jobId) =>
					forceRemoveStageQueueJob(queue, jobId).catch(() => {}),
				),
			);
			return;
		}
		case SCAN_STAGE_IDS.functionScan:
			await Promise.all(
				buildKnownQueueJobIdsForTask(getFunctionScanQueue(scanJobId), task).map(
					(jobId) =>
						forceRemoveStageQueueJob(
							getFunctionScanQueue(scanJobId),
							jobId,
						).catch(() => {}),
				),
			);
			return;
		case SCAN_STAGE_IDS.analysis:
			await Promise.all(
				buildKnownQueueJobIdsForTask(getAnalysisQueue(scanJobId), task).map(
					(jobId) =>
						forceRemoveStageQueueJob(getAnalysisQueue(scanJobId), jobId).catch(
							() => {},
						),
				),
			);
			return;
		case SCAN_STAGE_IDS.analysisCritic:
			await Promise.all(
				buildKnownQueueJobIdsForTask(
					getAnalysisCriticQueue(scanJobId),
					task,
				).map((jobId) =>
					forceRemoveStageQueueJob(
						getAnalysisCriticQueue(scanJobId),
						jobId,
					).catch(() => {}),
				),
			);
			return;
		case SCAN_STAGE_IDS.verification:
			await Promise.all(
				buildKnownQueueJobIdsForTask(getVerificationQueue(scanJobId), task).map(
					(jobId) =>
						forceRemoveStageQueueJob(
							getVerificationQueue(scanJobId),
							jobId,
						).catch(() => {}),
				),
			);
			return;
		case SCAN_STAGE_IDS.triage:
			await Promise.all(
				buildKnownQueueJobIdsForTask(getTriageQueue(scanJobId), task).map(
					(jobId) =>
						forceRemoveStageQueueJob(getTriageQueue(scanJobId), jobId).catch(
							() => {},
						),
				),
			);
			return;
		default:
			return;
	}
};

const clearTaskArtifactsForRetry = async (scanJobId: string, task: Task) => {
	if (!isRetryableTaskStageName(task.stageName)) {
		return;
	}

	await stopScanContainer(task.containerName).catch(() => false);
	const taskDirPath = await resolveTaskArtifactsDir({
		scanJobId,
		stageName: task.stageName,
		taskName: task.name,
	});
	await fs.rm(taskDirPath, { recursive: true, force: true }).catch(() => {});
};

const removeQueuedAnalysisTask = async (
	scanJobId: string,
	analysisTaskId: string,
) => {
	const analysisQueue = getAnalysisQueue(scanJobId);
	await Promise.all(
		buildKnownQueueJobIdsForTask(analysisQueue, {
			stageName: SCAN_STAGE_IDS.analysis,
			taskId: analysisTaskId,
			scanJobId,
		} as Task).map((jobId) =>
			forceRemoveStageQueueJob(analysisQueue, jobId).catch(() => {}),
		),
	);
};

const removeQueuedVerificationTask = async (
	scanJobId: string,
	verificationTaskId: string,
) => {
	const verificationQueue = getVerificationQueue(scanJobId);
	await Promise.all(
		buildKnownQueueJobIdsForTask(verificationQueue, {
			stageName: SCAN_STAGE_IDS.verification,
			taskId: verificationTaskId,
			scanJobId,
		} as Task).map((jobId) =>
			forceRemoveStageQueueJob(verificationQueue, jobId).catch(() => {}),
		),
	);
};

const MANUAL_STOP_MESSAGE = "Stopped manually";

const isManuallyCancelledScanJob = (
	scanJob: Pick<ScanJob, "status" | "errorMessage"> | null | undefined,
) => Boolean(scanJob && scanJob.status === "canceled");

const isOpenScanTaskStatus = (status: Task["status"]) =>
	status === "pending" ||
	status === "launching" ||
	status === "launched" ||
	status === "starting" ||
	status === "running";

const assertScanJobNotCancelled = async (scanJobId: string) => {
	const scanJob = await findScanJobByIdRepo(scanJobId).catch(() => null);
	if (isManuallyCancelledScanJob(scanJob)) {
		const error = new Error(`Scan job ${scanJobId} was cancelled`);
		error.name = "ScanJobCancelledError";
		throw error;
	}
};

export const cancelScanJob = async (scanJobId: string) => {
	const stopMessage = MANUAL_STOP_MESSAGE;
	const scanJob = await findScanJobByIdRepo(scanJobId);

	await updateScanJobStatusRepo(scanJobId, "canceled", stopMessage).catch(
		() => {},
	);

	const [
		repositoryTask,
		allTasks,
		candidates,
		stageGroups,
		laneRuntimes,
		dockerScanContainers,
	] = await Promise.all([
		scanJob.repositoryTaskId
			? findTaskByIdRepo(scanJob.repositoryTaskId).catch(() => null)
			: null,
		listTasksByScanJobIdRepo(scanJobId),
		findVulnerabilityCandidatesByScanJobIdRepo(scanJobId),
		listStageGroupInstancesByScanJobIdRepo(scanJobId),
		listStageLaneRuntimesByScanJobIdRepo(scanJobId).catch(() => []),
		listDockerContainersForScanJob(scanJobId),
	]);
	const openTasks = allTasks.filter((task) =>
		isOpenScanTaskStatus(task.status),
	);
	const moduleTasks = openTasks.filter(
		(task) => task.stageName === SCAN_STAGE_IDS.moduleScan,
	);
	const functionTasks = openTasks.filter(
		(task) => task.stageName === SCAN_STAGE_IDS.functionScan,
	);
	const tasksToCancelById = new Map<string, Task>();
	for (const task of openTasks) {
		tasksToCancelById.set(task.taskId, task);
	}
	if (repositoryTask && isOpenScanTaskStatus(repositoryTask.status)) {
		tasksToCancelById.set(repositoryTask.taskId, repositoryTask);
	}
	const tasksToCancel = [...tasksToCancelById.values()];
	const repositoryScanQueue = getRepositoryScanQueue(scanJobId);
	const rootStageName =
		scanJob.scanType === "delta"
			? SCAN_STAGE_IDS.deltaScope
			: SCAN_STAGE_IDS.repositoryScan;

	const containerNames = new Set<string>();

	for (const task of allTasks) {
		if (task.containerName) {
			containerNames.add(task.containerName);
		}
	}
	for (const task of tasksToCancel) {
		if (task.containerName) {
			containerNames.add(task.containerName);
		}
	}
	for (const lane of laneRuntimes) {
		if (lane.containerName) {
			containerNames.add(lane.containerName);
		}
	}
	for (const containerName of dockerScanContainers) {
		containerNames.add(containerName);
	}

	await Promise.all([
		...buildKnownQueueJobIdsForTask(repositoryScanQueue, {
			stageName: rootStageName,
			taskId: scanJob.repositoryTaskId || scanJobId,
			scanJobId,
		} as Task).map((jobId) =>
			forceRemoveStageQueueJob(repositoryScanQueue, jobId).catch(() => {}),
		),
		...tasksToCancel.map((task) =>
			removeQueuedTaskForRetry(scanJobId, task).catch(() => {}),
		),
		...stageGroups
			.filter((group) => group.status === "active")
			.map((group) =>
				obliterateScanStageGroupQueues(scanJobId, group.groupInstanceId).catch(
					() => {},
				),
			),
	]);

	const stoppedContainers = (
		await Promise.all(
			[...containerNames].map((name) => stopScanContainer(name)),
		)
	).filter(Boolean).length;

	await Promise.all([
		...tasksToCancel.map((task) =>
			updateTaskStatusRepo({
				taskId: task.taskId,
				status: "canceled",
				errorMessage: stopMessage,
			}).catch(() => null),
		),
	]);

	await resetStageLaneRuntimesByScanJobIdRepo(scanJobId).catch(() => []);
	await recalculateScanTaskCountsRepo(scanJobId).catch(() => {});
	await updateScanJobStatusRepo(scanJobId, "canceled", stopMessage);

	return {
		cancelled: true,
		scanJobId: scanJob.scanJobId,
		stoppedContainers,
		clearedTasks: tasksToCancel.length,
		clearedModuleTasks: moduleTasks.length,
		clearedFunctionTasks: functionTasks.length,
		clearedCandidates: candidates.filter((candidate) =>
			["pending", "launching", "launched", "starting", "running"].includes(
				candidate.status,
			),
		).length,
	};
};

const getPendingAnalysisCandidates = async (scanJobId: string) => {
	const [candidates, analysisResultsList] = await Promise.all([
		findVulnerabilityCandidatesByScanJobIdRepo(scanJobId),
		listAnalysisResultsByScanJobIdRepo(scanJobId),
	]);
	return getPendingAnalysisCandidateState({
		candidates,
		analysisResults: analysisResultsList,
	});
};

const getPendingVerificationCandidates = async (scanJobId: string) => {
	const [candidates, analysisResultsList, verificationResultsList] =
		await Promise.all([
			findVulnerabilityCandidatesByScanJobIdRepo(scanJobId),
			listAnalysisResultsByScanJobIdRepo(scanJobId),
			listVerificationResultsByScanJobIdRepo(scanJobId),
		]);
	return getPendingVerificationCandidateState({
		candidates,
		analysisResults: analysisResultsList,
		verificationResults: verificationResultsList,
		shouldVerifyFromAnalysisResult,
	});
};

const getPendingTriageTaskState = async (scanJobId: string) => {
	const triageTasks = await listTasksByScanJobAndStageRepo({
		scanJobId,
		stageName: SCAN_STAGE_IDS.triage,
	});
	return {
		pendingCount: triageTasks.filter((task) =>
			["pending", "launching", "launched", "starting", "running"].includes(
				task.status,
			),
		).length,
		failed: triageTasks.filter((task) => task.status === "failed").length,
	};
};

const getPendingScanTaskState = async (scanJobId: string) => {
	const [scanJob, moduleTasks, functionTasks] = await Promise.all([
		findScanJobByIdRepo(scanJobId),
		listUnifiedModuleTaskViewsByScanJobId(scanJobId),
		listUnifiedFunctionTaskViewsByScanJobId(scanJobId),
	]);

	return getPendingScanTaskStateView({
		scanJob,
		moduleTasks,
		functionTasks,
	});
};

export const reconcileScanJobCandidatePipelineStatus = async (
	scanJobId: string,
) => {
	const [
		scanState,
		analysisState,
		verificationState,
		triageState,
		taskStatusCounts,
	] =
		await Promise.all([
			getPendingScanTaskState(scanJobId),
			getPendingAnalysisCandidates(scanJobId),
			getPendingVerificationCandidates(scanJobId),
			getPendingTriageTaskState(scanJobId),
			listTaskStatusCountsByScanJobIdRepo(scanJobId),
		]);
	const openTaskCount = taskStatusCounts
		.filter((item) =>
			["pending", "launching", "launched", "starting", "running"].includes(
				item.status,
			),
		)
		.reduce((sum, item) => sum + Number(item.count), 0);

	if (scanState.scanJob.status === "canceled") {
		return {
			status: "canceled" as const,
			analysisFailed: analysisState.failed,
			verificationFailed: verificationState.failed,
			triageFailed: triageState.failed,
			moduleFailed: scanState.moduleFailed,
			functionFailed: scanState.functionFailed,
		};
	}

	if (scanState.scanJob.status === "paused") {
		return {
			status: "paused" as const,
			analysisFailed: analysisState.failed,
			verificationFailed: verificationState.failed,
			triageFailed: triageState.failed,
			moduleFailed: scanState.moduleFailed,
			functionFailed: scanState.functionFailed,
		};
	}

	const nextState = resolveNextScanPipelineState({
		scanJobStatus: scanState.scanJob.status,
		repositoryTaskStatus: scanState.scanJob.repositoryTaskStatus,
		modulePendingCount: scanState.modulePending.length,
		functionPendingCount: scanState.functionPending.length,
		openTaskCount,
		moduleFailed: scanState.moduleFailed,
		functionFailed: scanState.functionFailed,
		analysisPendingCount: analysisState.pendingCandidates.length,
		analysisFailed: analysisState.failed,
		verificationPendingCount: verificationState.pendingCandidates.length,
		verificationFailed: verificationState.failed,
		triagePendingCount: triageState.pendingCount,
		triageFailed: triageState.failed,
	});

	if (nextState.status !== scanState.scanJob.status || nextState.errorMessage) {
		await updateScanJobStatusRepo(
			scanJobId,
			nextState.status,
			nextState.errorMessage,
		);
	}

	return {
		status: nextState.status,
		analysisFailed: analysisState.failed,
		verificationFailed: verificationState.failed,
		triageFailed: triageState.failed,
		moduleFailed: scanState.moduleFailed,
		functionFailed: scanState.functionFailed,
	};
};

const buildJoinedCandidateInput = async (vulnerabilityCandidateId: string) => {
	const candidate = await findVulnerabilityCandidateByIdRepo(
		vulnerabilityCandidateId,
	);
	if (!candidate.producerTaskId) {
		throw new Error(
			`Candidate ${vulnerabilityCandidateId} is missing producerTaskId; cannot build joined candidate input`,
		);
	}
	const [scanJob, producerTask] = await Promise.all([
		findScanJobByIdRepo(candidate.scanJobId),
		findTaskByIdRepo(candidate.producerTaskId),
	]);
	if (
		producerTask.scanJobId !== candidate.scanJobId ||
		producerTask.stageName !== SCAN_STAGE_IDS.functionScan
	) {
		throw new Error(
			`Candidate ${vulnerabilityCandidateId} references non-candidate-producing task ${candidate.producerTaskId}`,
		);
	}
	const functionInput = asTaskRecord(producerTask.input);
	let moduleObject = asTaskRecord(
		functionInput?.module,
	) as CanonicalModule | null;
	let functionObject = asTaskRecord(
		functionInput?.function,
	) as CanonicalFunction | null;
	const modulePath = readString(functionInput, "modulePath");
	if (!moduleObject && modulePath) {
		moduleObject = await readTaskJsonArtifactForTask<CanonicalModule>(
			producerTask,
			modulePath,
		).catch(() => null);
	}
	const functionPath = readString(functionInput, "functionPath");
	if (!functionObject && functionPath) {
		functionObject = await readTaskJsonArtifactForTask<CanonicalFunction>(
			producerTask,
			functionPath,
		).catch(() => null);
	}
	if (!moduleObject || !functionObject) {
		throw new Error(
			`Candidate-producing task ${producerTask.taskId} is missing module/function input metadata`,
		);
	}
	const joinedModule = {
		...moduleObject,
		scanJob,
	};
	return {
		producerTaskId: candidate.producerTaskId,
		candidate: {
			...buildCandidateObject(candidate),
			scanJob,
			module: joinedModule,
			function: {
				...functionObject,
				scanJob,
				module: joinedModule,
			},
		},
	};
};

const buildJoinedAnalysisResultInput = async (
	vulnerabilityCandidateId: string,
): Promise<CandidateVerificationStageInput> => {
	const candidateInput = await buildJoinedCandidateInput(
		vulnerabilityCandidateId,
	);
	const analysisResult = await findLatestAnalysisResultByCandidateIdRepo({
		scanJobId: candidateInput.candidate.scanJob.scanJobId,
		vulnerabilityCandidateId,
		producerTaskId: candidateInput.producerTaskId,
	});
	if (!analysisResult) {
		throw new Error(
			`Candidate ${vulnerabilityCandidateId} has no persisted analysis result`,
		);
	}
	if (!analysisResult.result) {
		throw new Error(
			`Candidate ${vulnerabilityCandidateId} has analysis task without result`,
		);
	}
	return {
		analysisResult: {
			id: analysisResult.taskId,
			result: analysisResult.result,
			summary: analysisResult.summary || "",
			confidence: analysisResult.confidence,
			score: analysisResult.score,
			reportPath: analysisResult.reportPath,
			runtimeSeconds: analysisResult.runtimeSeconds,
			hypothesis: analysisResult.summary || "",
			evidenceTable: [],
			attackPath: [],
			blockers: [],
			rulingRationale:
				"Manual verification requested from an existing analysis result.",
			missingEvidenceRequest: [],
			feedbackHistory: [],
			status: analysisResult.status,
			analysisFingerprint: buildAnalysisFingerprint({
				id: analysisResult.taskId,
				result: analysisResult.result,
				summary: analysisResult.summary || "",
				confidence: analysisResult.confidence,
				score: analysisResult.score,
				reportPath: analysisResult.reportPath,
				runtimeSeconds: analysisResult.runtimeSeconds,
				hypothesis: analysisResult.summary || "",
				evidenceTable: [],
				attackPath: [],
				blockers: [],
				rulingRationale:
					"Manual verification requested from an existing analysis result.",
				missingEvidenceRequest: [],
				feedbackHistory: [],
				status: analysisResult.status,
			}),
			criticApproval: {
				criticTaskId: "manual-verification",
				reviewedAnalysisFingerprint: buildAnalysisFingerprint({
					id: analysisResult.taskId,
					result: analysisResult.result,
					summary: analysisResult.summary || "",
					confidence: analysisResult.confidence,
					score: analysisResult.score,
					reportPath: analysisResult.reportPath,
					runtimeSeconds: analysisResult.runtimeSeconds,
					hypothesis: analysisResult.summary || "",
					evidenceTable: [],
					attackPath: [],
					blockers: [],
					rulingRationale:
						"Manual verification requested from an existing analysis result.",
					missingEvidenceRequest: [],
					feedbackHistory: [],
					status: analysisResult.status,
				}),
				stance: "convinced",
				summary: "Manual verification requested for existing analysis result.",
			},
			evidenceBundle: [],
			fuzzEvidence: [],
			scanJob: candidateInput.candidate.scanJob,
			module: candidateInput.candidate.module,
			function: candidateInput.candidate.function,
			candidate: candidateInput.candidate,
		},
	} as unknown as CandidateVerificationStageInput;
};

export const recoverPendingScanCandidateQueues = async () => ({
	scanJobs: 0,
	analysisCandidates: 0,
	verificationCandidates: 0,
	mergedIntoFullScanQueues: true,
});

export const recoverPendingFullScanQueues = async (input?: {
	shouldRecoverScanJob?: (scanJobId: string) => Promise<boolean>;
}) => {
	const jobs = await listUnfinishedScanJobsRepo();
	let startedPipelines = 0;

	for (const job of jobs) {
		if (job.status !== "running" && job.status !== "pending") {
			continue;
		}

		if (input?.shouldRecoverScanJob) {
			const shouldRecover = await input.shouldRecoverScanJob(job.scanJobId);
			if (!shouldRecover) {
				continue;
			}
		}

		if (job.status === "pending") {
			await updateScanJobStatusRepo(job.scanJobId, "running").catch(() => {});
		}

		await startScanPipelineRuntimeForExistingQueues(job.scanJobId);
		startedPipelines += 1;
	}

	return {
		scanJobs: jobs.length,
		startedPipelines,
	};
};

export const syncFullScanTasksFromArtifacts = async (scanJobId: string) => {
	await recalculateScanTaskCountsRepo(scanJobId).catch(() => {});
	const pipelineState = await reconcileScanJobCandidatePipelineStatus(
		scanJobId,
	).catch(() => null);
	return {
		synced: true,
		scanJobId,
		pipelineState,
	};
};

export const startCandidateVerification = async (
	vulnerabilityCandidateId: string,
) => {
	const candidate = await findVulnerabilityCandidateByIdRepo(
		vulnerabilityCandidateId,
	);
	const scanJob = await findScanJobByIdRepo(candidate.scanJobId);
	const [latestAnalysisResult, existingVerificationTask] = await Promise.all([
		findLatestAnalysisResultByCandidateIdRepo({
			scanJobId: scanJob.scanJobId,
			vulnerabilityCandidateId,
			producerTaskId: candidate.producerTaskId,
		}),
		findCandidateTaskByStage(
			scanJob.scanJobId,
			vulnerabilityCandidateId,
			SCAN_STAGE_IDS.verification,
		),
	]);

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

	const hasPreviousVerification = Boolean(
		existingVerificationTask?.output || existingVerificationTask?.threadId,
	);
	if (
		candidate.currentStage === "verifying" &&
		["pending", "launching", "launched", "starting", "running"].includes(
			candidate.status,
		)
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Candidate verification is already queued or running",
		});
	}

	if (hasPreviousVerification || candidate.status === "failed") {
		if (existingVerificationTask) {
			await removeQueuedVerificationTask(
				scanJob.scanJobId,
				existingVerificationTask.taskId,
			).catch(() => {});
		}
	}

	const context = await buildFullScanPipelineContext(scanJob.scanJobId);
	const latestAnalysisTask = await findTaskByIdRepo(
		latestAnalysisResult.taskId,
	);
	const latestAnalysisTaskDir = await resolveExistingFullScanTaskRuntimeDir(
		context,
		latestAnalysisTask,
	);
	const analysisStageInput =
		latestAnalysisTask.input as CandidateAnalysisStageInput | null;
	const finalAnalysis = finalAnalysisSchema.safeParse(
		latestAnalysisTask.output,
	);
	if (!analysisStageInput || !finalAnalysis.success) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"Verification requires a critic-approved final analysis task with artifact paths",
		});
	}
	const verificationTaskId =
		existingVerificationTask?.taskId || createShortTaskId();
	const verificationTaskName = existingVerificationTask?.name
		? existingVerificationTask.name
		: `Candidate Verification: ${candidate.title}`;
	const verificationTaskDir = await resolveFullScanTaskRuntimeDir(context, {
		taskId: verificationTaskId,
		stageName: SCAN_STAGE_IDS.verification,
		taskName: verificationTaskName,
	});
	const baseInput = await copyAnalysisBaseInputArtifacts({
		fromTaskDir: latestAnalysisTaskDir,
		toTaskDir: verificationTaskDir,
		stageInput: analysisStageInput,
	});
	const verificationInput: CandidateVerificationStageInput = {
		scanJob: baseInput.scanJob,
		repositoryPath: baseInput.repositoryPath,
		modulePath: baseInput.modulePath,
		functionPath: baseInput.functionPath,
		candidatePath: baseInput.candidatePath,
		analysisResultPath: await writeDownstreamInputArtifact({
			toTaskDir: verificationTaskDir,
			toRelativePath: "inputs/final-analysis.json",
			value: finalAnalysis.data,
		}),
	};
	const verificationTask =
		existingVerificationTask ||
		(await createTaskRepo({
			taskId: verificationTaskId,
			scanJobId: scanJob.scanJobId,
			parentTaskId: latestAnalysisResult.taskId,
			name: verificationTaskName,
			stageName: SCAN_STAGE_IDS.verification,
			runtimeMode: latestAnalysisResult.threadId
				? "fork_session"
				: "new_session",
			forkedFromTaskId: latestAnalysisResult.threadId
				? latestAnalysisResult.taskId
				: null,
			forkedFromThreadId: latestAnalysisResult.threadId,
			input: verificationInput,
		}));

	if (
		verificationTask &&
		(hasPreviousVerification || candidate.status === "failed")
	) {
		await stopScanContainer(verificationTask.containerName).catch(() => false);
		await updateTaskRepo(verificationTask.taskId, {
			runtimeMode: latestAnalysisResult.threadId
				? "fork_session"
				: "new_session",
			forkedFromTaskId: latestAnalysisResult.threadId
				? latestAnalysisResult.taskId
				: null,
			forkedFromThreadId: latestAnalysisResult.threadId,
			input: verificationInput,
		});
		await requeueTaskRepo(verificationTask.taskId);
	}
	await enqueueVerificationTask(scanJob.scanJobId, verificationTask.taskId);
	if (scanJob.status === "finished") {
		await updateScanJobStatusRepo(scanJob.scanJobId, "running").catch(() => {});
	}
	await startScanPipelineRuntimeForExistingQueues(scanJob.scanJobId);

	return {
		started: true,
		reverify: hasPreviousVerification,
	};
};

export const startCandidateAnalysis = async (input: {
	vulnerabilityCandidateId: string;
	scanJobId: string;
	producerTaskId?: string;
}) => {
	const scanJob = await findScanJobByIdRepo(input.scanJobId);
	if (scanJob.status === "canceled") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Canceled scan jobs cannot re-run candidate analysis",
		});
	}
	if (scanJob.status === "paused") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Resume the scan job before re-running candidate analysis",
		});
	}
	const candidate = await findVulnerabilityCandidateByIdAndScanJobIdRepo({
		vulnerabilityCandidateId: input.vulnerabilityCandidateId,
		scanJobId: input.scanJobId,
		producerTaskId: input.producerTaskId,
	});
	if (!["completed", "failed", "exited"].includes(candidate.status)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"Candidate analysis can only be requeued after the candidate reaches a terminal state",
		});
	}
	if (!candidate.producerTaskId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Candidate does not have a producer task",
		});
	}

	const producerTask = await findTaskByIdRepo(candidate.producerTaskId);
	if (
		producerTask.scanJobId !== scanJob.scanJobId ||
		producerTask.stageName !== SCAN_STAGE_IDS.functionScan ||
		!producerTask.input
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Candidate producer task is not available",
		});
	}

	const context = await buildFullScanPipelineContext(scanJob.scanJobId);
	const producerTaskDir = await resolveExistingFullScanTaskRuntimeDir(
		context,
		producerTask,
	);
	const producerInput = asTaskRecord(producerTask.input);
	const repositorySourcePath = readString(producerInput, "repositoryPath");
	const moduleSourcePath = readString(producerInput, "modulePath");
	let functionSourcePath =
		readString(producerInput, "targetPath") ||
		readString(producerInput, "functionPath");
	if (!repositorySourcePath || !moduleSourcePath || !functionSourcePath) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Candidate producer task is missing analysis input artifacts",
		});
	}

	const existingActiveAnalysisTask = (
		await listCandidateDescendantTasksByProducerTaskIdRepo({
			producerTaskId: producerTask.taskId,
			vulnerabilityCandidateId: input.vulnerabilityCandidateId,
		})
	).find(
		(task) =>
			task.stageName === SCAN_STAGE_IDS.analysis &&
			["pending", "launching", "launched", "starting", "running"].includes(
				task.status,
			),
	);
	if (existingActiveAnalysisTask) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Candidate analysis is already queued or running",
		});
	}

	const analysisTaskId = createShortTaskId();
	const sourceCandidate = buildCandidateObject(candidate);
	const analysisTaskName = `Candidate Analysis: ${sourceCandidate.title}`;
	const analysisTaskDir = await resolveFullScanTaskRuntimeDir(context, {
		taskId: analysisTaskId,
		stageName: SCAN_STAGE_IDS.analysis,
		taskName: analysisTaskName,
	});
	const analysisInput: CandidateAnalysisStageInput = {
		scanJob,
		repositoryPath: await copyArtifactToDownstreamInput({
			fromTaskDir: producerTaskDir,
			fromPath: repositorySourcePath,
			toTaskDir: analysisTaskDir,
			toRelativePath: "inputs/repository.json",
		}),
		modulePath: await copyArtifactToDownstreamInput({
			fromTaskDir: producerTaskDir,
			fromPath: moduleSourcePath,
			toTaskDir: analysisTaskDir,
			toRelativePath: "inputs/module.json",
		}),
		functionPath: await copyArtifactToDownstreamInput({
			fromTaskDir: producerTaskDir,
			fromPath: functionSourcePath,
			toTaskDir: analysisTaskDir,
			toRelativePath: "inputs/target.json",
		}),
		candidatePath: await writeDownstreamInputArtifact({
			toTaskDir: analysisTaskDir,
			toRelativePath: "inputs/candidate.json",
			value: sourceCandidate,
		}),
		analysisReportTemplatePath: await writeAnalysisReportTemplateInput({
			scanJob,
			toTaskDir: analysisTaskDir,
		}),
	};
	const analysisTask = await createTaskRepo({
		taskId: analysisTaskId,
		scanJobId: scanJob.scanJobId,
		parentTaskId: producerTask.taskId,
		name: analysisTaskName,
		stageName: SCAN_STAGE_IDS.analysis,
		runtimeMode: "new_session",
		input: analysisInput,
	});

	if (scanJob.status !== "running") {
		await resetScanJobForRetryRepo(scanJob.scanJobId, {
			status: "running",
			errorMessage: null,
		}).catch(() => {});
		await updateScanJobStatusRepo(scanJob.scanJobId, "running").catch(() => {});
	}
	await enqueueAnalysisTask(scanJob.scanJobId, analysisTask.taskId);
	await recalculateScanTaskCountsRepo(scanJob.scanJobId).catch(() => {});
	await reconcileScanJobCandidatePipelineStatus(scanJob.scanJobId).catch(
		() => null,
	);

	return {
		started: true,
		taskId: analysisTask.taskId,
		scanJobId: scanJob.scanJobId,
	};
};

export const startCandidateReviewContainer = async (input: {
	scanJobId: string;
	candidateIds: string[];
}) => {
	const scanJob = await findScanJobByIdRepo(input.scanJobId);
	if (input.candidateIds.length === 0) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Select at least one candidate",
		});
	}

	const executionContext = await resolveScanExecutionContext(scanJob);
	const repositoryProfile = await resolveStageAgentProfile(
		scanJob,
		"scan",
		SCAN_STAGE_IDS.repositoryScan,
	);
	if (!repositoryProfile || repositoryProfile.provider !== "codex") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"Repository profile stage must use a Codex agent profile before launching a review container",
		});
	}

	const configuredHostRoot = resolveConfiguredScanContextHostPath();
	if (!configuredHostRoot) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"Scan context host path is not configured. Restart vulseek-dev from dev.sh.",
		});
	}

	const hostProfileDir = buildHostProjectProfileContextRoot(
		configuredHostRoot,
		executionContext.projectName,
		executionContext.serviceName,
	);
	await fs.mkdir(hostProfileDir, { recursive: true });

	const uniqueCandidateIds = Array.from(
		new Set(
			input.candidateIds
				.map((candidateId) => candidateId.trim())
				.filter(Boolean),
		),
	);
	const lineageByCandidate = await Promise.all(
		uniqueCandidateIds.map(async (candidateId) => {
			const candidate = await findVulnerabilityCandidateByIdAndScanJobIdRepo({
				vulnerabilityCandidateId: candidateId,
				scanJobId: input.scanJobId,
			});
			const lineage = await findCandidateTaskLineage({
				vulnerabilityCandidateId: candidate.vulnerabilityCandidateId,
				scanJobId: input.scanJobId,
				producerTaskId: candidate.producerTaskId || undefined,
			});
			return { candidate, lineage };
		}),
	);

	const taskMounts = new Map<
		string,
		{
			taskId: string;
			stageName: string;
			taskName: string;
			hostPath: string;
			containerPath: string;
		}
	>();
	for (const { lineage } of lineageByCandidate) {
		for (const task of lineage.tasks) {
			if (taskMounts.has(task.taskId)) {
				continue;
			}
			taskMounts.set(task.taskId, {
				taskId: task.taskId,
				stageName: task.stageName,
				taskName: task.name,
				hostPath: buildTaskHostRootForScanJob({
					hostProfileDir,
					scanJobId: task.scanJobId,
					stageName: task.stageName,
					taskName: task.name,
					taskId: task.taskId,
				}),
				containerPath: buildTaskMountPathForReview({
					scanJobId: task.scanJobId,
					stageName: task.stageName,
					taskName: task.name,
					taskId: task.taskId,
				}),
			});
		}
	}
	if (taskMounts.size === 0) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Selected candidates do not have any task context to mount",
		});
	}

	const reviewId = nanoid(10).toLowerCase();
	const containerName = `scan-candidate-review-${scanJob.scanJobId.toLowerCase()}-${reviewId}`;
	const reviewHostDir = path.join(
		os.tmpdir(),
		"vulseek-candidate-review",
		containerName,
	);
	const reviewContainerDir = "/workspace/review";
	const reviewManifest = {
		scanJobId: scanJob.scanJobId,
		containerName,
		candidates: lineageByCandidate.map(({ candidate, lineage }) => ({
			candidateId: candidate.vulnerabilityCandidateId,
			title: candidate.title,
			status: candidate.status,
			producerTaskId: candidate.producerTaskId,
			tasks: lineage.tasks.map((task) => ({
				taskId: task.taskId,
				stageName: task.stageName,
				name: task.name,
				relation: task.relation,
				mountedPath: taskMounts.get(task.taskId)?.containerPath || null,
			})),
		})),
		tasks: Array.from(taskMounts.values()).map((task) => ({
			taskId: task.taskId,
			stageName: task.stageName,
			name: task.taskName,
			hostPath: task.hostPath,
			containerPath: task.containerPath,
		})),
	};
	const readme = [
		"# Candidate Review Workspace",
		"",
		"Open the terminal in Codex mode to start the CLI inside this workspace.",
		`Task directories are mounted under ${CONTAINER_TASK_RUNTIME_ROOT}/jobs/${scanJob.scanJobId}/...`,
		"",
		"Open candidate-review.json for the mounted task manifest.",
	].join("\n");
	await fs.mkdir(reviewHostDir, { recursive: true });
	await fs.writeFile(
		path.join(reviewHostDir, "candidate-review.json"),
		JSON.stringify(reviewManifest, null, 2),
		"utf-8",
	);
	await fs.writeFile(path.join(reviewHostDir, "README.md"), readme, "utf-8");

	const allEnvPairs = [
		...getGlobalContainerEnvironmentPairs(),
		...parseAgentProfileEnvPairs(repositoryProfile),
	];
	const dockerEnvArgs = allEnvPairs
		.map((pair) => {
			const separatorIndex = pair.indexOf("=");
			const key = separatorIndex === -1 ? pair : pair.slice(0, separatorIndex);
			const value =
				separatorIndex === -1 ? "" : pair.slice(separatorIndex + 1);
			return `-e '${escapeSingleQuotes(key)}=${escapeSingleQuotes(value)}'`;
		})
		.join(" ");
	const mountArgs = [
		`-v '${escapeSingleQuotes(hostProfileDir)}:${CONTAINER_SCAN_CONTEXT_ROOT}:ro'`,
		`-v '${escapeSingleQuotes(reviewHostDir)}:${reviewContainerDir}'`,
		...Array.from(taskMounts.values()).map(
			(task) =>
				`-v '${escapeSingleQuotes(task.hostPath)}:${task.containerPath}:ro'`,
		),
	]
		.filter(Boolean)
		.join(" ");
	const containerNetworkArg = await resolveCurrentDockerNetworkArg();
	const codexHomeMountArg =
		buildReviewContainerCodexHomeMountArg(repositoryProfile);
	const agentsDir = await resolveAgentsDirectory();

	try {
		await execAsync(`docker rm -f ${containerName}`).catch(() => {});
		await execAsync(
			`docker run -d -i -t --init --name ${containerName} ${containerNetworkArg} ${buildNamespaceEnabledContainerArgs()} ${mountArgs} ${codexHomeMountArg} ${dockerEnvArgs} ${executionContext.imageTag} bash -lc "mkdir -p /root/.codex '${reviewContainerDir}' && sleep infinity"`,
		);
		await copyCodexAssetsToContainerHome(
			containerName,
			"/root/.codex",
			agentsDir,
			repositoryProfile,
		);
		const { stdout: containerId } = await execAsync(
			`docker inspect --format '{{.Id}}' ${containerName}`,
		);
		return {
			containerId: containerId.trim(),
			containerName,
			terminalUrl: `/dashboard/scan-review-terminal?containerId=${encodeURIComponent(
				containerId.trim(),
			)}`,
		};
	} catch (error) {
		await execAsync(`docker rm -f ${containerName}`).catch(() => {});
		throw error;
	}
};
