import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
	type apiCheckoutScanEnvironment,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { Queue } from "bullmq";
import { nanoid } from "nanoid";
import { SandboxAgent } from "sandbox-agent";
import { Agent, type Dispatcher } from "undici";
import { execAsync } from "../utils/process/execAsync";
import { getGlobalContainerEnvironmentPairs } from "../utils/docker/utils";
import {
	type AnalysisResultPayload,
	validateAnalysisResultFile,
} from "./scan/artifacts/contracts/analysis-result.contract";
import {
	validateFunctionResultFile,
} from "./scan/artifacts/contracts/function-result.contract";
import {
	type VerificationResultPayload,
	validateVerificationResultFile,
} from "./scan/artifacts/contracts/verification-result.contract";
import {
	createAnalysisResultRepo,
	deleteAnalysisResultsByCandidateIdRepo,
	ensureCandidateAnalysisTaskRepo,
	findCandidateAnalysisTaskByCandidateIdRepo,
	findLatestAnalysisResultByCandidateIdRepo,
	listAnalysisResultsByScanJobIdRepo,
} from "./scan/persistence/analysis-result.repo";
import {
	createVulnerabilityCandidateRepo,
	findVulnerabilityCandidateByIdRepo,
	findVulnerabilityCandidatesByScanJobIdRepo,
	resetFailedAnalysisCandidateForRetryRepo,
	resetFailedVerificationCandidateForRetryRepo,
	updateVulnerabilityCandidateAnalysisThreadIdRepo,
	updateVulnerabilityCandidateCurrentStageRepo,
	updateVulnerabilityCandidateRiskMetricsRepo,
	updateVulnerabilityCandidateStatusRepo,
	updateVulnerabilityCandidateVerifierThreadIdRepo,
} from "./scan/persistence/candidate.repo";
import {
	createScanFunctionTaskRepo,
	findScanFunctionTaskByIdRepo,
	listScanFunctionTasksByModuleTaskIdRepo,
	listScanFunctionTasksByScanJobIdRepo,
	resetFailedScanFunctionTaskForRetryRepo,
	updateScanFunctionTaskRepo,
	updateScanFunctionTaskStatusRepo,
	upsertFunctionTaskFromPlanRepo,
} from "./scan/persistence/scan-function-task.repo";
import {
	findScanJobByIdRepo,
	listUnfinishedScanJobsRepo,
	recalculateScanTaskCountsRepo,
	resetScanJobForCandidateRetryRepo,
	resetScanJobForRetryRepo,
	updateScanJobPhaseRepo,
	updateScanJobScanningThreadIdRepo,
	updateScanJobStatusRepo,
	updateScanJobTargetContextRepo,
} from "./scan/persistence/scan-job.repo";
import {
	updateScanRepositoryTaskRepo,
} from "./scan/persistence/scan-repository-task.repo";
import {
	findScanModuleTaskByIdRepo,
	listScanModuleTasksByScanJobIdRepo,
	resetFailedScanModuleTaskForRetryRepo,
	upsertModuleTaskFromPlanRepo,
	updateScanModuleTaskStatusRepo,
} from "./scan/persistence/scan-module-task.repo";
import type {
	PipelineDefinition,
	WithoutTaskId,
} from "./scan/pipeline/pipeline-definition";
import {
	createPipelineDefinition,
	createPipelineEdge,
} from "./scan/pipeline/pipeline-definition";
import {
	createStageQueueBinding,
} from "./scan/pipeline/stage-definition";
import {
	recoverCandidateQueuesPipeline,
} from "./scan/pipeline/recover-candidate-queues.pipeline";
import {
	recoverFullScanQueuesPipeline,
} from "./scan/pipeline/recover-full-scan-queues.pipeline";
import {
	createFunctionScanningStageDefinition,
	type FunctionScanningStageInput,
} from "./scan/stages/function-scan.stage";
import {
	createModuleScanningStageDefinition,
	type ModuleScanningStageInput,
} from "./scan/stages/module-scan.stage";
import {
	createRepositoryScanningStageDefinition,
	type RepositoryScanningStageInput,
} from "./scan/stages/repository-scan.stage";
import {
	createAnalysisStageDefinition,
	type CandidateAnalysisStageInput,
} from "./scan/stages/candidate-analysis.stage";
import {
	createVerifyingStageDefinition,
	type CandidateVerificationStageInput,
} from "./scan/stages/candidate-verification.stage";
import {
	runPipeline,
} from "./scan/pipeline/pipeline-runner";
import {
	normalizeCandidateStatuses,
} from "./scan/state/normalize-candidate-statuses";
import {
	syncResolvedCandidateRiskMetrics,
} from "./scan/state/candidate-risk-metrics";
import {
	getPendingAnalysisCandidateState,
	getPendingVerificationCandidateState,
} from "./scan/state/pending-candidate-state";
import {
	getPendingScanTaskStateView,
} from "./scan/state/scan-pipeline-read-model";
import type {
	AgentProfileLike,
	Analysis as CanonicalAnalysis,
	AnalysisResult,
	Candidate as CanonicalCandidate,
	Function as CanonicalFunction,
	Module as CanonicalModule,
	Repository as CanonicalRepository,
	ScanFunctionTask,
	ScanJob,
	ScanModuleTask,
	VerificationResult,
	VulnerabilityCandidate,
	VulnerabilityCandidateStage,
} from "./scan/types";
import {
	createVerificationResultRepo,
	deleteVerificationResultsByCandidateIdRepo,
	ensureCandidateVerificationTaskRepo,
	findCandidateVerificationTaskByCandidateIdRepo,
	findLatestVerificationResultByCandidateIdRepo,
	listVerificationResultsByScanJobIdRepo,
} from "./scan/persistence/verification-result.repo";
import {
	resolveNextScanPipelineState,
} from "./scan/state/scan-state-machine";
import { DEFAULT_DELTA_COMMIT_WINDOW } from "./scan/constants";
import {
	prepareSandboxAgentRuntime,
} from "./sandbox-agent/runtime";
import { findApplicationById } from "./application";
import { findComposeById } from "./compose";

const DEFAULT_FULL_SCAN_MODULE_CONCURRENCY = 4;
const DEFAULT_FULL_SCAN_FUNCTION_CONCURRENCY = 4;
const DEFAULT_ANALYSIS_CONCURRENCY = 2;
const DEFAULT_VERIFY_CONCURRENCY = 1;
const ACP_HTTP_TIMEOUT_MS = 15 * 60 * 1000;
const PREINSTALLED_TOOL_SKILLS = [] as const;
const RUNTIME_CUSTOM_SKILLS = [
	"codeql",
	"semgrep",
	"delta-scan",
	"full-scan",
	"full-scan-subagent",
	"repository-scanner",
	"module-scanner",
	"function-scanner",
	"deep-analysis",
	"verify",
	"search-registries",
	"tree-sitter",
	"serena",
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

export const MAX_CANDIDATE_ANALYSIS_WORKER_CONCURRENCY = 16;
export const MAX_CANDIDATE_VERIFICATION_WORKER_CONCURRENCY = 16;
export const MAX_SCAN_MODULE_WORKER_CONCURRENCY = 32;
export const MAX_SCAN_FUNCTION_WORKER_CONCURRENCY = 32;

export const SCAN_MODULE_QUEUE_NAME = "scan-module";
export const SCAN_FUNCTION_QUEUE_NAME = "scan-function";
export const SCAN_REPOSITORY_QUEUE_NAME = "scan-repository";
export const SCAN_CANDIDATE_ANALYSIS_QUEUE_NAME = "scan-candidate-analysis";
export const SCAN_CANDIDATE_VERIFICATION_QUEUE_NAME =
	"scan-candidate-verification";

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

const moduleScanQueue = new Queue<string>(SCAN_MODULE_QUEUE_NAME, {
	connection: bullRedisConnection,
});

const repositoryScanQueue = new Queue<string>(
	SCAN_REPOSITORY_QUEUE_NAME,
	{
		connection: bullRedisConnection,
	},
);

const functionScanQueue = new Queue<string>(
	SCAN_FUNCTION_QUEUE_NAME,
	{
		connection: bullRedisConnection,
	},
);

const candidateAnalysisQueue = new Queue<string>(
	SCAN_CANDIDATE_ANALYSIS_QUEUE_NAME,
	{
		connection: bullRedisConnection,
	},
);

const candidateVerificationQueue = new Queue<string>(
	SCAN_CANDIDATE_VERIFICATION_QUEUE_NAME,
	{
		connection: bullRedisConnection,
	},
);

const sleep = async (ms: number) =>
	await new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});

const SANDBOX_AGENT_PROMPT_TIMEOUT_MS = 15 * 60 * 1000;

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

export const retryFailedFullScanTasks = async (scanJobId: string) => {
	const scanJob = await findScanJobByIdRepo(scanJobId);
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
		listScanModuleTasksByScanJobIdRepo(scanJobId),
		listScanFunctionTasksByScanJobIdRepo(scanJobId),
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

	for (const task of failedModuleTasks) {
		await resetFailedScanModuleTaskForRetryRepo(task.scanModuleTaskId);
	}

	for (const task of failedFunctionTasks) {
		await resetFailedScanFunctionTaskForRetryRepo(task.scanFunctionTaskId);
	}

	await recalculateScanTaskCountsRepo(scanJobId);
	const nextPhase =
		failedModuleTasks.length > 0 ? "module_scanning" : "function_scanning";
	await resetScanJobForRetryRepo(scanJobId, {
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

export const retryFailedAnalysisTasks = async (scanJobId: string) => {
	await findScanJobByIdRepo(scanJobId);

	const candidates = await findVulnerabilityCandidatesByScanJobIdRepo(scanJobId);
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
			await deleteAnalysisResultsByCandidateIdRepo(
				candidate.vulnerabilityCandidateId,
			);
			await resetCandidateAnalysisRuntimeFiles(
				scanJobId,
				candidate.vulnerabilityCandidateId,
			).catch(() => {});
			await updateVulnerabilityCandidateAnalysisThreadIdRepo(
				candidate.vulnerabilityCandidateId,
				"",
			).catch(() => {});
			await syncVulnerabilityCandidateResolvedRiskMetrics(
				candidate.vulnerabilityCandidateId,
			).catch(() => {});
			await resetFailedAnalysisCandidateForRetryRepo(
				candidate.vulnerabilityCandidateId,
			);
			await enqueueCandidateAnalysisWork(
				scanJobId,
				candidate.vulnerabilityCandidateId,
			);
		}),
	);

	await resetScanJobForCandidateRetryRepo(scanJobId, "analyzing");

	return {
		scanJobId,
		retriedCandidates: failedAnalysisCandidates.length,
	};
};

export const retryFailedVerificationTasks = async (scanJobId: string) => {
	await findScanJobByIdRepo(scanJobId);

	const candidates = await findVulnerabilityCandidatesByScanJobIdRepo(scanJobId);
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

	await Promise.all(
		failedVerificationCandidates.map(async (candidate) => {
			await removeQueuedCandidateVerificationWork(
				candidate.vulnerabilityCandidateId,
			).catch(() => {});
			await deleteVerificationResultsByCandidateIdRepo(
				candidate.vulnerabilityCandidateId,
			);
			await resetCandidateVerifierRuntimeFiles(
				scanJobId,
				candidate.vulnerabilityCandidateId,
			).catch(() => {});
			await updateVulnerabilityCandidateVerifierThreadIdRepo(
				candidate.vulnerabilityCandidateId,
				"",
			).catch(() => {});
			await syncVulnerabilityCandidateResolvedRiskMetrics(
				candidate.vulnerabilityCandidateId,
			).catch(() => {});
			await resetFailedVerificationCandidateForRetryRepo(
				candidate.vulnerabilityCandidateId,
			);
			await enqueueCandidateVerificationWork(
				scanJobId,
				candidate.vulnerabilityCandidateId,
			);
		}),
	);

	await resetScanJobForCandidateRetryRepo(scanJobId, "verifying");

	return {
		scanJobId,
		retriedCandidates: failedVerificationCandidates.length,
	};
};

const syncVulnerabilityCandidateResolvedRiskMetrics = async (
	vulnerabilityCandidateId: string,
) => {
	const [candidate, latestAnalysisResult, latestVerificationResult] =
		await Promise.all([
			findVulnerabilityCandidateByIdRepo(vulnerabilityCandidateId),
			findLatestAnalysisResultByCandidateIdRepo(vulnerabilityCandidateId),
			findLatestVerificationResultByCandidateIdRepo(vulnerabilityCandidateId),
		]);

	return await syncResolvedCandidateRiskMetrics({
		vulnerabilityCandidateId,
		candidate,
		latestAnalysisResult,
		latestVerificationResult,
		updateRiskMetrics: updateVulnerabilityCandidateRiskMetricsRepo,
	});
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

const resolveScanDockerfileTemplatePath = async () => {
	const candidates = [
		path.resolve(process.cwd(), "packages/server/src/services/dockerfiles/Dockerfile.scan.template"),
		path.resolve(process.cwd(), "../../packages/server/src/services/dockerfiles/Dockerfile.scan.template"),
		"/app/packages/server/src/services/dockerfiles/Dockerfile.scan.template",
		"/data/exp/dkzou/dokploy/packages/server/src/services/dockerfiles/Dockerfile.scan.template",
	];

	for (const candidate of candidates) {
		try {
			const stat = await fs.stat(candidate);
			if (stat.isFile()) {
				return candidate;
			}
		} catch {}
	}

	throw new Error("Unable to locate Dockerfile.scan.template");
};

const buildScanDockerfileTemplate = async () => {
	const templatePath = await resolveScanDockerfileTemplatePath();
	return await fs.readFile(templatePath, "utf-8");
};

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
	const dockerfileTemplate = await buildScanDockerfileTemplate();
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
	const tempAgentsPath = path.join(tempDir, "agents");
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
		const agentsDir = await resolveAgentsDirectory();
		await fs.mkdir(tempAgentsPath, { recursive: true });
		if (agentsDir) {
			await fs.cp(agentsDir, tempAgentsPath, { recursive: true });
		}
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
	const scanJob = await findScanJobByIdRepo(scanJobId);
	const projectProfileHostContextRoot =
		await resolveRequiredProjectProfileHostContextRootByScanJob(scanJob);
	return path.join(projectProfileHostContextRoot, "jobs", scanJobId, "scanning");
};

const resolveCandidateArtifactsDir = async (
	scanJobId: string,
	candidateId: string,
) => {
	const scanJob = await findScanJobByIdRepo(scanJobId);
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
	const scanJob = await findScanJobByIdRepo(scanJobId);
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

const installRuntimeSkillsInContainer = async (
	containerName: string,
	agentsDir: string | null,
) => {
	if (!agentsDir) {
		return [] as string[];
	}

	const hostTempDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "dokploy-runtime-skills-"),
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
			await fs.cp(cacheSchemaSourceDir, path.join(hostRepoRoot, "cache-schema"), {
				recursive: true,
			});
		} catch {}

		if (copiedSkills.length === 0) {
			return [];
		}

		const containerRepoRoot = "/tmp/dokploy-runtime-skills";
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
			`docker exec ${containerName} bash -lc "mkdir -p /workspace/repo/.agents && cd /workspace/repo && npx -y skills add '${containerRepoRoot}' ${skillFlags} -a claude-code -a codex --copy -y"`,
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
										(typeof payloadRecord?.toolCallId === "string"
											? payloadRecord.toolCallId
											: typeof payloadRecord?.itemId === "string"
												? payloadRecord.itemId
												: "sandbox-agent"),
									type: "dynamicToolCall",
									tool:
										(typeof payloadRecord?.title === "string"
											? payloadRecord.title
											: typeof payloadRecord?.tool === "string"
												? payloadRecord.tool
												: "tool"),
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
			actionText: formatActionText(
				prompt ? `${tool}: ${prompt}` : tool,
				tool,
			),
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
			findScanJobByIdRepo(scanJobId),
			findVulnerabilityCandidatesByScanJobIdRepo(scanJobId),
			listAnalysisResultsByScanJobIdRepo(scanJobId),
			listVerificationResultsByScanJobIdRepo(scanJobId),
			listScanModuleTasksByScanJobIdRepo(scanJobId),
			listScanFunctionTasksByScanJobIdRepo(scanJobId),
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
			const taskId =
				candidateStage === "verifying"
					? latestVerificationResultByCandidateId.get(
							candidate.vulnerabilityCandidateId,
						)?.candidateVerificationTaskId || ""
					: latestAnalysisResultByCandidateId.get(
							candidate.vulnerabilityCandidateId,
						)?.candidateAnalysisTaskId || "";

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
		taskId: string;
		title: string;
		subtitle?: string;
		stage: "repository_scanning" | "module_scanning" | "function_scanning";
		moduleId?: string;
		functionId?: string;
	}> = [];

	if (scanJob.repositoryTaskStatus === "running") {
		inProgressScannerAgents.push({
			id: `repository-${scanJob.scanJobId}`,
			taskId: scanJob.repositoryTaskId || scanJob.scanJobId,
			title: "Repository Scanner",
			subtitle: "Repository-wide planner and module partitioning",
			stage: "repository_scanning",
		});
	}

	inProgressScannerAgents.push(
		...(
			await Promise.all(
				moduleTasks
					.filter((task) => task.status === "running")
					.map(async (task) => ({
						id: `module-${task.scanModuleTaskId}`,
						taskId: task.scanModuleTaskId,
						title: task.moduleName || task.moduleId,
						subtitle: task.moduleId,
						stage: "module_scanning" as const,
						moduleId: task.moduleId,
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
						taskId: task.scanFunctionTaskId,
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
						moduleId: task.moduleId,
						functionId: task.functionId,
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


type FunctionResultCandidatePayload = {
	title: string;
	description?: string;
	filePath?: string;
	line?: number;
	confidence?: number;
	score?: number;
};

const persistFunctionResultCandidates = async (input: {
	scanJobId: string;
	scanFunctionTaskId?: string;
	candidates: FunctionResultCandidatePayload[];
}) => {
	let createdCandidates = 0;
	for (const candidate of input.candidates) {
		if (!candidate.title) continue;
		const createdCandidate = await createVulnerabilityCandidateRepo({
			scanJobId: input.scanJobId,
			scanFunctionTaskId: input.scanFunctionTaskId,
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
		effort: input.thinkingLevel || undefined,
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

type FullScanExecutionContext = Awaited<
	ReturnType<typeof resolveScanExecutionContext>
>;

type FullScanPipelineContext = {
	scanJob: ScanJob;
	executionContext: FullScanExecutionContext;
	projectName: string;
	serviceName: string;
	refreshPipelineState: () => Promise<void>;
};

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
	attackSurfaces: [],
	publicApis: [],
	vulnerabilityThemes: [],
	notes: [],
	targetRef: scanJob.targetRef,
	targetTag: scanJob.targetTag,
	commitSha: scanJob.commitSha,
	baseSha: scanJob.baseSha,
	commitWindow: scanJob.commitWindow || DEFAULT_DELTA_COMMIT_WINDOW,
});

const buildModuleObject = (
	scanModuleTask: ScanModuleTask,
	moduleRuntimeDir: string,
	pathListFile: string,
): CanonicalModule => ({
	id: scanModuleTask.scanModuleTaskId,
	moduleId: scanModuleTask.moduleId,
	name: scanModuleTask.moduleName,
	summary: "",
	artifactDir: moduleRuntimeDir,
	pathListFile,
	priority: scanModuleTask.priority || 0,
	importantFiles: [],
	entryPoints: [],
	trustBoundaries: [],
	attackSurfaces: [],
	vulnerabilityThemes: [],
	notes: [],
});

const buildFunctionObject = (
	scanFunctionTask: ScanFunctionTask,
): CanonicalFunction => ({
	id: scanFunctionTask.scanFunctionTaskId,
	moduleId: scanFunctionTask.moduleId,
	moduleName: scanFunctionTask.moduleName,
	functionId: scanFunctionTask.functionId,
	functionName: scanFunctionTask.functionName,
	filePath: scanFunctionTask.filePath,
	line: scanFunctionTask.line,
	priority: scanFunctionTask.priority || 0,
	summary: scanFunctionTask.summary,
	riskType: scanFunctionTask.riskType,
	score: scanFunctionTask.score,
});

const buildCandidateObject = (
	candidate: VulnerabilityCandidate,
): CanonicalCandidate => ({
	id: candidate.vulnerabilityCandidateId,
	functionId: candidate.scanFunctionTaskId,
	title: candidate.title,
	description: candidate.description || "",
	filePath: candidate.filePath,
	line: candidate.line,
	confidence: candidate.confidence,
	score: candidate.score,
	status: candidate.status,
	currentStage:
		candidate.currentStage === "verifying" ||
		candidate.currentStage === "fuzzing"
			? candidate.currentStage
			: "analyzing",
});

const buildCandidateAnalysisStageInput = (input: {
	scanJob: ScanJob;
	module: CanonicalModule;
	function: CanonicalFunction;
	candidate: CanonicalCandidate;
}): WithoutTaskId<CandidateAnalysisStageInput> => ({
	candidate: {
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
});

const buildRepositoryStageInput = async (
	scanJob: ScanJob,
	executionContext: FullScanExecutionContext,
): Promise<RepositoryScanningStageInput> => ({
	taskId: scanJob.repositoryTaskId || scanJob.scanJobId,
	scanJob,
	repository: buildRepositoryObject(scanJob, executionContext.serviceName),
});

const buildModuleStageInput = async (
	scanJob: ScanJob,
	scanModuleTask: ScanModuleTask,
	repositoryName: string,
): Promise<ModuleScanningStageInput> => {
	const moduleRuntimeDir = path.join(
		await resolveScanJobArtifactsDir(scanJob.scanJobId),
		"full_scan",
		"modules",
		sanitizeContextPathPart(scanModuleTask.moduleId),
	);
	const pathListHostPath = path.join(moduleRuntimeDir, "file_list.txt");
	const pathListFileInContainer =
		await resolveHostPathToScanContextContainerPath(scanJob, pathListHostPath);

	return {
		taskId: scanModuleTask.scanModuleTaskId,
		scanJob,
		repository: buildRepositoryObject(scanJob, repositoryName),
		module: buildModuleObject(
			scanModuleTask,
			moduleRuntimeDir,
			pathListFileInContainer,
		),
	};
};

const buildFunctionStageInput = async (
	scanJob: ScanJob,
	scanFunctionTask: ScanFunctionTask,
	repositoryName: string,
): Promise<FunctionScanningStageInput> => {
	const scanModuleTask = await findScanModuleTaskByIdRepo(
		scanFunctionTask.scanModuleTaskId,
	);
	const moduleRuntimeDir = path.join(
		await resolveScanJobArtifactsDir(scanJob.scanJobId),
		"full_scan",
		"modules",
		sanitizeContextPathPart(scanModuleTask.moduleId),
	);
	return {
		taskId: scanFunctionTask.scanFunctionTaskId,
		scanJob,
		repository: buildRepositoryObject(scanJob, repositoryName),
		module: buildModuleObject(
			scanModuleTask,
			moduleRuntimeDir,
			path.join(moduleRuntimeDir, "file_list.txt"),
		),
		function: buildFunctionObject(scanFunctionTask),
	};
};
const runFullScan = async (scanJobId: string) => {
	const scanJob = await findScanJobByIdRepo(scanJobId);
	const executionContext = await resolveScanExecutionContext(scanJob);
	const context: FullScanPipelineContext = {
		scanJob,
		executionContext,
		projectName: executionContext.projectName,
		serviceName: executionContext.serviceName,
		refreshPipelineState: async () => {
			await recalculateScanTaskCountsRepo(scanJobId).catch(() => {});
			await reconcileScanJobCandidatePipelineStatus(scanJobId).catch(
				() => {},
			);
		},
	};
	const repositoryStage =
		createRepositoryScanningStageDefinition<FullScanPipelineContext>({
			queue: createStageQueueBinding({
				queue: repositoryScanQueue,
				loadInput: async (ctx, inputId) =>
					inputId === ctx.scanJob.scanJobId
						? await buildRepositoryStageInput(
								ctx.scanJob,
								ctx.executionContext,
						  )
						: null,
			}),
		});

	const moduleStage =
		createModuleScanningStageDefinition<FullScanPipelineContext>({
			queue: createStageQueueBinding({
				queue: moduleScanQueue,
				loadInput: async (ctx, inputId) => {
					const scanModuleTask = await findScanModuleTaskByIdRepo(inputId);
					if (
						scanModuleTask.scanJobId !== ctx.scanJob.scanJobId ||
						scanModuleTask.status === "completed" ||
						scanModuleTask.status === "failed"
					) {
					return null;
					}
					return await buildModuleStageInput(
						ctx.scanJob,
						scanModuleTask,
						ctx.executionContext.serviceName,
					);
				},
			}),
		});
		
	const functionStage =
		createFunctionScanningStageDefinition<FullScanPipelineContext>({
			queue: createStageQueueBinding({
				queue: functionScanQueue,
				loadInput: async (ctx, inputId) => {
					const scanFunctionTask = await findScanFunctionTaskByIdRepo(inputId);
					if (
						scanFunctionTask.scanJobId !== ctx.scanJob.scanJobId ||
						scanFunctionTask.status === "completed" ||
						scanFunctionTask.status === "failed"
					) {
						return null;
					}
					return await buildFunctionStageInput(
						ctx.scanJob,
						scanFunctionTask,
						ctx.executionContext.serviceName,
					);
				},
			}),
		});
	const analysisStage = createAnalysisStageDefinition<FullScanPipelineContext>({
		queue: createStageQueueBinding({
			queue: candidateAnalysisQueue,
			loadInput: async (ctx, inputId) => {
				const candidate = await findVulnerabilityCandidateByIdRepo(inputId);
				if (
					candidate.scanJobId !== ctx.scanJob.scanJobId ||
					candidate.status === "completed" ||
					candidate.status === "failed" ||
					candidate.currentStage === "verifying"
				) {
					return null;
				}
				return await buildJoinedCandidateInput(inputId);
			},
		}),
	});
	const verifyingStage =
		createVerifyingStageDefinition<FullScanPipelineContext>({
			queue: createStageQueueBinding({
				queue: candidateVerificationQueue,
				loadInput: async (ctx, inputId) => {
					const candidate = await findVulnerabilityCandidateByIdRepo(inputId);
					if (
						candidate.scanJobId !== ctx.scanJob.scanJobId ||
						candidate.status === "completed" ||
						candidate.status === "failed"
					) {
						return null;
					}
					return await buildJoinedAnalysisResultInput(inputId);
				},
			}),
		});

	const pipeline: PipelineDefinition<FullScanPipelineContext> = createPipelineDefinition({
		name: "full-scan-programmatic",
		stages: [repositoryStage, moduleStage, functionStage, analysisStage, verifyingStage],
		edges: [
			createPipelineEdge<
				FullScanPipelineContext,
				typeof repositoryStage,
				WithoutTaskId<ModuleScanningStageInput>,
				typeof moduleStage
			>({
				from: repositoryStage,
				to: moduleStage,
				transformOutput: async ({ stageInput, stageOutput }) =>
					stageOutput.modules.filter(
						(module) => module.moduleId.length > 0 && stageInput.scanJob.scanJobId.length > 0,
					).map((module) => ({
						scanJob: stageInput.scanJob,
						repository: stageInput.repository,
						module,
					})),
				createTasks: async ({ nextInputObjects }) => {
					const taskIds: string[] = [];
					for (const downstreamInput of nextInputObjects) {
						const moduleTask = await upsertModuleTaskFromPlanRepo({
							scanJobId: context.scanJob.scanJobId,
							moduleId: downstreamInput.module.moduleId,
							moduleName: downstreamInput.module.name,
							priority: downstreamInput.module.priority,
							moduleScanMdPath: path.join(
								downstreamInput.module.artifactDir,
								"module_scan.md",
							),
							moduleScanJsonPath: path.join(
								downstreamInput.module.artifactDir,
								"module_scan.json",
							),
							functionPlanJsonPath: downstreamInput.module.pathListFile,
							errorMessage: undefined,
						});
						taskIds.push(moduleTask.scanModuleTaskId);
					}
					return taskIds;
				},
			}),
			createPipelineEdge<
				FullScanPipelineContext,
				typeof moduleStage,
				WithoutTaskId<FunctionScanningStageInput>,
				typeof functionStage
			>({
				from: moduleStage,
				to: functionStage,
				transformOutput: async ({ stageInput: {scanJob, repository, module}, stageOutput: { functions } }) =>
					functions.map((func) => ({
						scanJob,
						repository,
						module,
						function: func,
					})),
				createTasks: async ({ stageInput, nextInputObjects }) => {
					const taskIds: string[] = [];
					for (const downstreamInput of nextInputObjects) {
						const functionTask = await upsertFunctionTaskFromPlanRepo({
							scanJobId: context.scanJob.scanJobId,
							scanModuleTaskId: stageInput.taskId,
							moduleId: downstreamInput.function.moduleId,
							moduleName: downstreamInput.function.moduleName,
							functionId: downstreamInput.function.functionId,
							functionName: downstreamInput.function.functionName,
							filePath: downstreamInput.function.filePath || undefined,
							line: downstreamInput.function.line ?? undefined,
							priority: downstreamInput.function.priority,
							score: downstreamInput.function.score ?? undefined,
							riskType: downstreamInput.function.riskType || undefined,
							summary: downstreamInput.function.summary || undefined,
						});
						taskIds.push(functionTask.scanFunctionTaskId);
					}
					return taskIds;
				},
			}),
			createPipelineEdge<
				FullScanPipelineContext,
				typeof functionStage,
				WithoutTaskId<CandidateAnalysisStageInput>,
				typeof analysisStage
			>({
				from: functionStage,
				to: analysisStage,
				transformOutput: async ({ stageInput, stageOutput }) =>
					stageOutput.candidates.map((candidate) =>
						buildCandidateAnalysisStageInput({
							scanJob: stageInput.scanJob,
							module: stageInput.module,
							function: stageInput.function,
							candidate,
						}),
					),
				createTasks: async ({ stageInput, nextInputObjects }) => {
					const taskIds: string[] = [];
					for (const downstreamInput of nextInputObjects) {
						const candidate = await createVulnerabilityCandidateRepo({
							scanJobId: context.scanJob.scanJobId,
							scanFunctionTaskId: stageInput.taskId,
							title: downstreamInput.candidate.title,
							description:
								downstreamInput.candidate.description || undefined,
							filePath: downstreamInput.candidate.filePath || undefined,
							line: downstreamInput.candidate.line ?? undefined,
							confidence: downstreamInput.candidate.confidence ?? undefined,
							score: downstreamInput.candidate.score ?? undefined,
							status: downstreamInput.candidate.status,
							currentStage: downstreamInput.candidate.currentStage,
						});
						const analysisTask = await ensureCandidateAnalysisTaskRepo({
							scanJobId: context.scanJob.scanJobId,
							vulnerabilityCandidateId:
								candidate.vulnerabilityCandidateId,
						});
						taskIds.push(analysisTask.candidateAnalysisTaskId);
					}
					return taskIds;
				},
			}),
			createPipelineEdge<
				FullScanPipelineContext,
				typeof analysisStage,
				WithoutTaskId<CandidateVerificationStageInput>,
				typeof verifyingStage
			>({
				from: analysisStage,
				to: verifyingStage,
				transformOutput: async ({ stageInput, stageOutput }) => {
					if (!shouldVerifyFromAnalysisResult(stageOutput.analysis.result)) {
						return [];
					}
					return [
						{
							analysisResult: {
								id: stageOutput.analysis.id,
								result: stageOutput.analysis.result,
								confidence: stageOutput.analysis.confidence,
								score: stageOutput.analysis.score,
								reportPath: stageOutput.analysis.reportPath,
								runtimeSeconds: stageOutput.analysis.runtimeSeconds,
								summary: stageOutput.analysis.summary,
								status: stageOutput.analysis.status,
								scanJob: stageInput.candidate.scanJob,
								module: stageInput.candidate.module,
								function: stageInput.candidate.function,
								candidate: stageInput.candidate,
							},
						},
					];
				},
				createTasks: async ({ stageInput, nextInputObjects }) => {
					const taskIds: string[] = [];
					for (const _downstreamInput of nextInputObjects) {
						const verificationTask = await ensureCandidateVerificationTaskRepo({
								scanJobId: stageInput.candidate.scanJob.scanJobId,
								vulnerabilityCandidateId: stageInput.candidate.id,
							});
						taskIds.push(verificationTask.candidateVerificationTaskId);
					}
					return taskIds;
				},
			}),
		],
	});

	await enqueueRepositoryScanTask(scanJobId);
	await runPipeline(pipeline, context);
};
export const runScanJobInContainer = async (scanJobId: string) => {
	const scanJob = await findScanJobByIdRepo(scanJobId);
	if (scanJob.scanType === "full") {
		await runFullScan(scanJobId);
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
		stageSummary.push(
			`- preinstalled_tool_skills: ${PREINSTALLED_TOOL_SKILLS.join(", ")}`,
		);
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
			stageSummary.push(`- image_preinstalled_skills_source: ${agentsDir}`);

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

			stageSummary.push("- runtime_installed_custom_skills: delegated_to_runSingleTurnAgentInContainer");
		} else {
			stageSummary.push("- image_preinstalled_skills_source: none");
			stageSummary.push("- runtime_installed_custom_skills: none");
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
		await updateScanJobTargetContextRepo(scanJob.scanJobId, {
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
					await updateScanJobScanningThreadIdRepo(scanJob.scanJobId, nextSessionId);
				},
			});
			const candidateResult = await validateFunctionResultFile(
				path.join(scanRuntimeDir, "scan_candidates.json"),
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

const shouldVerifyFromAnalysisResult = (
	result: string | null | undefined,
) =>
	result === "real_vulnerability" || result === "likely_vulnerability";

const enqueueCandidateAnalysisWork = async (
	scanJobId: string,
	vulnerabilityCandidateId: string,
) => {
	await candidateAnalysisQueue.add(
		"analysis",
		vulnerabilityCandidateId,
		{
			jobId: `analysis:${vulnerabilityCandidateId}`,
			removeOnComplete: true,
			removeOnFail: true,
		},
	);
};

const enqueueRepositoryScanTask = async (scanJobId: string) => {
	await repositoryScanQueue.add(
		"repository",
		scanJobId,
		{
			jobId: `repository:${scanJobId}`,
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
		scanModuleTaskId,
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
		scanFunctionTaskId,
		{
			jobId: `function:${scanFunctionTaskId}`,
			removeOnComplete: true,
			removeOnFail: true,
		},
	);
};

const enqueueCandidateVerificationWork = async (
	scanJobId: string,
	vulnerabilityCandidateId: string,
) => {
	await candidateVerificationQueue.add(
		"verification",
		vulnerabilityCandidateId,
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
		analysisResults: analysisResultsList as AnalysisResult[],
		verificationResults: verificationResultsList as VerificationResult[],
		shouldVerifyFromAnalysisResult,
	});
};

const getPendingScanTaskState = async (scanJobId: string) => {
	const [scanJob, moduleTasks, functionTasks] = await Promise.all([
		findScanJobByIdRepo(scanJobId),
		listScanModuleTasksByScanJobIdRepo(scanJobId),
		listScanFunctionTasksByScanJobIdRepo(scanJobId),
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
	const [scanState, analysisState, verificationState] = await Promise.all([
		getPendingScanTaskState(scanJobId),
		getPendingAnalysisCandidates(scanJobId),
		getPendingVerificationCandidates(scanJobId),
	]);

	const nextState = resolveNextScanPipelineState({
		scanJobStatus: scanState.scanJob.status,
		repositoryTaskStatus: scanState.scanJob.repositoryTaskStatus,
		modulePendingCount: scanState.modulePending.length,
		functionPendingCount: scanState.functionPending.length,
		moduleFailed: scanState.moduleFailed,
		functionFailed: scanState.functionFailed,
		analysisPendingCount: analysisState.pendingCandidates.length,
		analysisFailed: analysisState.failed,
		verificationPendingCount: verificationState.pendingCandidates.length,
		verificationFailed: verificationState.failed,
	});

	if (nextState.status !== scanState.scanJob.status || nextState.errorMessage) {
		await updateScanJobStatusRepo(
			scanJobId,
			nextState.status,
			nextState.errorMessage,
		).catch(() => {});
	}

	if (
		nextState.scanPhase !== "analyzing" &&
		nextState.scanPhase !== "verifying" &&
		nextState.scanPhase !== "completed" &&
		nextState.scanPhase !== "failed"
	) {
		await updateScanJobPhaseRepo(scanJobId, nextState.scanPhase).catch(() => {});
	}

	return {
		status: nextState.status,
		scanPhase: nextState.scanPhase,
		analysisFailed: analysisState.failed,
		verificationFailed: verificationState.failed,
		moduleFailed: scanState.moduleFailed,
		functionFailed: scanState.functionFailed,
	};
};

const normalizeCandidateStatusesForScanJob = async (scanJobId: string) => {
	const [candidates, analysisResultsList, verificationResultsList] =
		await Promise.all([
			findVulnerabilityCandidatesByScanJobIdRepo(scanJobId),
			listAnalysisResultsByScanJobIdRepo(scanJobId),
			listVerificationResultsByScanJobIdRepo(scanJobId),
		]);
	await normalizeCandidateStatuses({
		candidates,
		analysisResults: analysisResultsList as AnalysisResult[],
		verificationResults: verificationResultsList as VerificationResult[],
		shouldVerifyFromAnalysisResult,
		updateCandidateCurrentStage: updateVulnerabilityCandidateCurrentStageRepo,
		updateCandidateStatus: updateVulnerabilityCandidateStatusRepo,
	});
};

const buildJoinedModuleInput = (
	scanJob: ScanJob,
	moduleTask: ScanModuleTask,
) => ({
	module: {
		...moduleTask,
		scanJob,
	},
});

const buildJoinedFunctionInput = (
	scanJob: ScanJob,
	moduleTask: ScanModuleTask,
	functionTask: ScanFunctionTask,
) => ({
	function: {
		...functionTask,
		scanJob,
		module: buildJoinedModuleInput(scanJob, moduleTask).module,
	},
});

const buildJoinedCandidateInput = async (
	vulnerabilityCandidateId: string,
) => {
	const candidate = await findVulnerabilityCandidateByIdRepo(
		vulnerabilityCandidateId,
	);
	if (!candidate.scanFunctionTaskId) {
		throw new Error(
			`Candidate ${vulnerabilityCandidateId} is missing scanFunctionTaskId; cannot build joined candidate input`,
		);
	}
	const [scanJob, functionTask, candidateAnalysisTask] = await Promise.all([
		findScanJobByIdRepo(candidate.scanJobId),
		findScanFunctionTaskByIdRepo(candidate.scanFunctionTaskId),
		findCandidateAnalysisTaskByCandidateIdRepo(vulnerabilityCandidateId),
	]);
	const moduleTask = await findScanModuleTaskByIdRepo(
		functionTask.scanModuleTaskId,
	);
	const moduleArtifactDir = path.join(
		await resolveScanJobArtifactsDir(scanJob.scanJobId),
		"full_scan",
		"modules",
		sanitizeContextPathPart(moduleTask.moduleId),
	);
	const joinedModule = {
		...buildModuleObject(
			moduleTask,
			moduleArtifactDir,
			path.join(moduleArtifactDir, "file_list.txt"),
		),
		scanJob,
	};
	return {
		taskId:
			candidateAnalysisTask?.candidateAnalysisTaskId ||
			candidate.vulnerabilityCandidateId,
		candidate: {
			...buildCandidateObject(candidate),
			scanJob,
			module: joinedModule,
			function: {
				...buildFunctionObject(functionTask),
				scanJob,
				module: joinedModule,
			},
		},
	};
};

const buildJoinedAnalysisResultInput = async (
	vulnerabilityCandidateId: string,
): Promise<CandidateVerificationStageInput> => {
	const [candidateInput, analysisResult, verificationTask] = await Promise.all([
		buildJoinedCandidateInput(vulnerabilityCandidateId),
		findLatestAnalysisResultByCandidateIdRepo(vulnerabilityCandidateId),
		findCandidateVerificationTaskByCandidateIdRepo(vulnerabilityCandidateId),
	]);
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
		taskId:
			verificationTask?.candidateVerificationTaskId ||
			vulnerabilityCandidateId,
		analysisResult: {
			id: analysisResult.analysisResultId,
			result:
				analysisResult.result === "real_vulnerability" ||
				analysisResult.result === "likely_vulnerability" ||
				analysisResult.result === "plausible_but_unproven" ||
				analysisResult.result === "false_positive"
					? analysisResult.result
					: "plausible_but_unproven",
			summary: analysisResult.summary || "",
			confidence: analysisResult.confidence,
			score: analysisResult.score,
			reportPath: analysisResult.reportPath,
			runtimeSeconds: analysisResult.runtimeSeconds,
			status: analysisResult.status,
			scanJob: candidateInput.candidate.scanJob,
			module: candidateInput.candidate.module,
			function: candidateInput.candidate.function,
			candidate: candidateInput.candidate,
		},
	};
};

export const recoverPendingScanCandidateQueues = async () => {
	return await recoverCandidateQueuesPipeline({
		loadJobs: listUnfinishedScanJobsRepo,
		normalizeCandidateStatusesForScanJob,
		loadAnalysisState: getPendingAnalysisCandidates,
		loadVerificationState: getPendingVerificationCandidates,
		updateCandidateStatus: updateVulnerabilityCandidateStatusRepo,
		updateCandidateCurrentStage: updateVulnerabilityCandidateCurrentStageRepo,
		enqueueAnalysisWork: enqueueCandidateAnalysisWork,
		enqueueVerificationWork: enqueueCandidateVerificationWork,
		updateScanJobStatus: async (scanJobId, status) =>
			await updateScanJobStatusRepo(scanJobId, status),
		reconcilePipelineStatus: reconcileScanJobCandidatePipelineStatus,
	});
};

export const recoverPendingFullScanQueues = async () => {
	return await recoverFullScanQueuesPipeline({
		loadJobs: listUnfinishedScanJobsRepo,
		loadScanJob: findScanJobByIdRepo,
		loadModuleTasks: listScanModuleTasksByScanJobIdRepo,
		loadFunctionTasksByModuleTaskId: listScanFunctionTasksByModuleTaskIdRepo,
		enqueueModuleScanWork,
		enqueueFunctionScanWork,
		recalculateScanTaskCounts: recalculateScanTaskCountsRepo,
		reconcilePipelineStatus: reconcileScanJobCandidatePipelineStatus,
	});
};

export const syncFullScanTasksFromArtifacts = async (scanJobId: string) => {
	await recalculateScanTaskCountsRepo(scanJobId).catch(() => {});
	const pipelineState =
		await reconcileScanJobCandidatePipelineStatus(scanJobId).catch(() => null);
	return {
		synced: true,
		scanJobId,
		pipelineState,
	};
};

export const startCandidateVerification = async (
	vulnerabilityCandidateId: string,
) => {
	const candidate = await findVulnerabilityCandidateByIdRepo(vulnerabilityCandidateId);
	const scanJob = await findScanJobByIdRepo(candidate.scanJobId);
	const latestAnalysisResult = await findLatestAnalysisResultByCandidateIdRepo(
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

	await updateVulnerabilityCandidateStatusRepo(vulnerabilityCandidateId, "queued");
	await updateVulnerabilityCandidateCurrentStageRepo(
		vulnerabilityCandidateId,
		"verifying",
	);

	if (hasPreviousVerification) {
		await deleteVerificationResultsByCandidateIdRepo(vulnerabilityCandidateId);
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
