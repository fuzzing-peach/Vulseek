import { promises as fs } from "node:fs";
import path from "node:path";
import { db } from "@vulseek/server/db";
import {
	applications,
	compose,
	environments,
	projects,
	scanJobs,
} from "@vulseek/server/db/schema";
import { and, eq, or } from "drizzle-orm";
import { findApplicationById } from "../application";
import { findComposeById } from "../compose";
import { execAsync } from "../../utils/process/execAsync";
import { findScanJobByIdRepo } from "./persistence/scan-job.repo";
import { findVulnerabilityCandidateByIdRepo } from "./persistence/candidate.repo";
import {
	findTaskByIdRepo,
	listRunningTaskRuntimeMetadataRepo,
	listTasksByScanJobAndStatusesRepo,
	listTasksByScanJobAndStageRepo,
} from "./persistence/task.repo";
import {
	SANDBOX_AGENT_RUNTIME_FILE_NAMES,
	getEventUpdate,
	getUsageUpdateCumulativeTokens,
	summarizeSandboxAgentTokenUsage,
} from "./runtime/sandbox-agent-shared";
import type { Task } from "./types";

const sanitizePathPart = (value: string) =>
	value
		.replace(/[\\/]+/g, "-")
		.replace(/[^a-zA-Z0-9._-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "") || "unknown";

const resolveScanStageTaskRuntimeDir = (
	baseDir: string,
	stageName: string,
	taskName: string,
	taskId?: string,
) =>
	path.join(
		baseDir,
		"scanning",
		"full_scan",
		"stages",
		sanitizePathPart(stageName),
		"tasks",
		taskId
			? `${sanitizePathPart(taskName)}-${sanitizePathPart(taskId).slice(0, 6)}`
			: sanitizePathPart(taskName),
	);

const resolveScanContextRoot = async () => {
	const candidates = [
		"/scan-context",
		process.env.VULSEEK_SCAN_CONTEXT_HOST_PATH?.trim() || "",
	].filter(Boolean);
	for (const candidate of candidates) {
		try {
			const stat = await fs.stat(candidate);
			if (stat.isDirectory()) {
				return candidate;
			}
		} catch {}
	}
	return "/scan-context";
};

const findScanJobTargetSummary = async (scanJobId: string) => {
	const applicationTarget = await db
		.select({
			projectName: projects.name,
			serviceName: applications.name,
			appName: applications.appName,
			organizationId: projects.organizationId,
		})
		.from(scanJobs)
		.innerJoin(
			applications,
			eq(scanJobs.applicationId, applications.applicationId),
		)
		.innerJoin(
			environments,
			eq(applications.environmentId, environments.environmentId),
		)
		.innerJoin(projects, eq(environments.projectId, projects.projectId))
		.where(eq(scanJobs.scanJobId, scanJobId))
		.limit(1)
		.then((rows) => rows[0] || null);

	if (applicationTarget) {
		return {
			projectName: applicationTarget.projectName,
			serviceName:
				applicationTarget.serviceName || applicationTarget.appName || "application",
			organizationId: applicationTarget.organizationId,
		};
	}

	const composeTarget = await db
		.select({
			projectName: projects.name,
			serviceName: compose.name,
			appName: compose.appName,
			organizationId: projects.organizationId,
		})
		.from(scanJobs)
		.innerJoin(compose, eq(scanJobs.composeId, compose.composeId))
		.innerJoin(environments, eq(compose.environmentId, environments.environmentId))
		.innerJoin(projects, eq(environments.projectId, projects.projectId))
		.where(eq(scanJobs.scanJobId, scanJobId))
		.limit(1)
		.then((rows) => rows[0] || null);

	if (composeTarget) {
		return {
			projectName: composeTarget.projectName,
			serviceName: composeTarget.serviceName || composeTarget.appName || "compose",
			organizationId: composeTarget.organizationId,
		};
	}

	return null;
};

export const findScanJobOrganizationId = async (scanJobId: string) =>
	(await findScanJobTargetSummary(scanJobId))?.organizationId || null;

export const findScanJobStatusById = async (scanJobId: string) =>
	await db
		.select({ status: scanJobs.status })
		.from(scanJobs)
		.where(eq(scanJobs.scanJobId, scanJobId))
		.limit(1)
		.then((rows) => rows[0]?.status || null);

const resolveScanJobBaseDir = async (scanJobId: string) => {
	const target = await findScanJobTargetSummary(scanJobId);
	if (!target) {
		const scanJob = await findScanJobByIdRepo(scanJobId);
		const fullTarget = scanJob.applicationId
			? await findApplicationById(scanJob.applicationId)
			: await findComposeById(scanJob.composeId as string);
		const projectName = fullTarget.environment.project.name;
		const serviceName = fullTarget.name || fullTarget.appName;
		return path.join(
			await resolveScanContextRoot(),
			"projects",
			sanitizePathPart(projectName),
			"profiles",
			sanitizePathPart(serviceName),
			"jobs",
			scanJobId,
		);
	}
	return path.join(
		await resolveScanContextRoot(),
		"projects",
		sanitizePathPart(target.projectName),
		"profiles",
		sanitizePathPart(target.serviceName),
		"jobs",
		scanJobId,
	);
};

const toSandboxAgentProvider = (
	provider?: string | null,
): "codex" | "claude" => (provider === "claude_code" ? "claude" : "codex");

const resolveTaskSandboxAgentProvider = (
	agentProfile?: { provider?: string | null } | null,
) => toSandboxAgentProvider(agentProfile?.provider);

const getTaskInputRecord = (value: unknown): Record<string, unknown> | null =>
	value && typeof value === "object" ? (value as Record<string, unknown>) : null;

const getNestedRecord = (
	record: Record<string, unknown> | null,
	key: string,
): Record<string, unknown> | null => {
	const value = record?.[key];
	return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
};

const getNestedString = (
	record: Record<string, unknown> | null,
	keys: string[],
): string | null => {
	for (const key of keys) {
		const value = record?.[key];
		if (typeof value === "string" && value.length > 0) {
			return value;
		}
	}
	return null;
};

export type SandboxAgentLiveSession = {
	scanJobId: string;
	sessionId: string;
	provider: "codex" | "claude";
	baseUrl: string;
	containerName: string | null;
	metadataPath: string;
	updatedAt: string | null;
};

export type SandboxAgentTaskRuntime = {
	taskId: string;
	scanJobId: string;
	stageName: string;
	taskKind:
		| "delta-scope"
		| "repository-profile"
		| "identify-target"
		| "scan-target"
		| "analyze-finding"
		| "critique-finding"
		| "verify-finding"
		| "triage-finding";
	status: string;
	containerName: string | null;
	sessionId: string | null;
	baseUrl: string | null;
	provider: "codex" | "claude";
	jsonlPath: string;
	textPath: string;
	stderrPath: string;
	metadataPath: string;
	updatedAt: string | null;
};

const inspectContainerIpAddress = async (containerName: string) => {
	const { stdout } = await execAsync(
		`docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${containerName}`,
	);
	const value = stdout.trim();
	if (!value) {
		throw new Error(`Unable to resolve container IP for ${containerName}`);
	}
	return value;
};

const resolveScannerTaskSession = async (input: {
	stage:
		| "delta-scope"
		| "repository-profile"
		| "identify-target"
		| "scan-target";
	taskId: string;
}) => {
	const task = await findTaskByIdRepo(input.taskId).catch(() => null);
	if (!task) {
		if (
			input.stage !== "repository-profile" &&
			input.stage !== "delta-scope"
		) {
			return null;
		}
		const scanJob = await findScanJobByIdRepo(input.taskId).catch(() => null);
		if (!scanJob?.repositoryTaskId) {
			return null;
		}
		const repositoryTask = await findTaskByIdRepo(scanJob.repositoryTaskId).catch(
			() => null,
		);
		if (!repositoryTask) {
			return null;
		}
		return {
			scanJobId: repositoryTask.scanJobId,
			threadId: repositoryTask.threadId,
			containerName: repositoryTask.containerName,
			agentProfile: repositoryTask.agentProfile,
			status: repositoryTask.status,
		};
	}
	return {
		scanJobId: task.scanJobId,
		threadId: task.threadId,
		containerName: task.containerName,
		agentProfile: task.agentProfile,
		status: task.status,
	};
};

export const findScanJobSandboxAgentSession = async (input: {
	stage:
		| "delta-scope"
		| "repository-profile"
		| "identify-target"
		| "scan-target";
	taskId: string;
}): Promise<SandboxAgentLiveSession | null> => {
	const task = await resolveScannerTaskSession(input);
	if (!task?.threadId || !task.containerName || !isLiveTaskStatus(task.status)) {
		return null;
	}

	const publicBaseUrl = `/sandbox-agent/${task.containerName}`;
	let internalBaseUrl = "";
	try {
		const containerIp = await inspectContainerIpAddress(task.containerName);
		internalBaseUrl = `http://${containerIp}:2468`;
	} catch {
		internalBaseUrl = "";
	}

	return {
		scanJobId: task.scanJobId,
		sessionId: task.threadId,
		provider: resolveTaskSandboxAgentProvider(task.agentProfile),
		baseUrl: publicBaseUrl,
		containerName: task.containerName,
		metadataPath: internalBaseUrl,
		updatedAt: null,
	};
};

const resolveCandidateSessionBaseUrl = (containerName: string | null) => {
	if (!containerName) {
		return null;
	}
	return `/sandbox-agent/${containerName}`;
};

const buildSandboxAgentRuntimeFiles = (runtimeDir: string) => ({
	jsonlPath: path.join(runtimeDir, SANDBOX_AGENT_RUNTIME_FILE_NAMES.jsonl),
	textPath: path.join(runtimeDir, SANDBOX_AGENT_RUNTIME_FILE_NAMES.text),
	stderrPath: path.join(runtimeDir, SANDBOX_AGENT_RUNTIME_FILE_NAMES.stderr),
	metadataPath: path.join(runtimeDir, "sandbox-agent-runtime.json"),
});

const toPublicBaseUrl = (containerName: string | null) =>
	containerName ? `/sandbox-agent/${containerName}` : null;

const isLiveTaskStatus = (status: string | null | undefined) =>
	status === "launching" ||
	status === "launched" ||
	status === "starting" ||
	status === "running";

export const findSandboxAgentTaskRuntimeByTaskId = async (
	taskId: string,
): Promise<SandboxAgentTaskRuntime | null> => {
	const task = await findTaskByIdRepo(taskId).catch(() => null);
	if (task) {
		return buildSandboxAgentTaskRuntime(task);
	}
	return null;
};

type SandboxAgentTaskRuntimeSource = Pick<
	Task,
	| "taskId"
	| "scanJobId"
	| "stageName"
	| "name"
	| "status"
	| "containerName"
	| "threadId"
	| "agentProfile"
	| "updatedAt"
>;

const buildSandboxAgentTaskRuntime = async (
	task: SandboxAgentTaskRuntimeSource,
): Promise<SandboxAgentTaskRuntime> => {
	const baseDir = await resolveScanJobBaseDir(task.scanJobId);
	const runtimeDir = resolveScanStageTaskRuntimeDir(
		baseDir,
		task.stageName,
		task.name,
		task.taskId,
	);
	let taskKind: SandboxAgentTaskRuntime["taskKind"] = "repository-profile";

	switch (task.stageName) {
		case "delta-scope":
			taskKind = "delta-scope";
			break;
		case "repository-profile":
			taskKind = "repository-profile";
			break;
		case "identify-target":
			taskKind = "identify-target";
			break;
		case "scan-target":
			taskKind = "scan-target";
			break;
		case "analyze-finding":
			taskKind = "analyze-finding";
			break;
		case "critique-finding":
			taskKind = "critique-finding";
			break;
		case "verify-finding":
			taskKind = "verify-finding";
			break;
		case "triage-finding":
			taskKind = "triage-finding";
			break;
	}

	return {
		taskId: task.taskId,
		scanJobId: task.scanJobId,
		stageName: task.stageName,
		taskKind,
		status: task.status,
		containerName: task.containerName,
		sessionId: task.threadId,
		baseUrl: isLiveTaskStatus(task.status) ? toPublicBaseUrl(task.containerName) : null,
		provider: resolveTaskSandboxAgentProvider(task.agentProfile),
		...buildSandboxAgentRuntimeFiles(runtimeDir),
		updatedAt: task.updatedAt || null,
	};
};

export const findRunningSandboxAgentTaskRuntimesByScanJobId = async (
	scanJobId: string,
): Promise<SandboxAgentTaskRuntime[]> => {
	const runningTasks = await listRunningTaskRuntimeMetadataRepo(scanJobId);
	return await Promise.all(runningTasks.map(buildSandboxAgentTaskRuntime));
};

export const listRunningScanJobsByOrganizationId = async (
	organizationId: string,
): Promise<{ scanJobId: string }[]> => {
	const statusFilter = or(
		eq(scanJobs.status, "pending"),
		eq(scanJobs.status, "running"),
	);
	const [appJobs, composeJobs] = await Promise.all([
		db
			.select({ scanJobId: scanJobs.scanJobId })
			.from(scanJobs)
			.innerJoin(
				applications,
				eq(scanJobs.applicationId, applications.applicationId),
			)
			.innerJoin(
				environments,
				eq(applications.environmentId, environments.environmentId),
			)
			.innerJoin(projects, eq(environments.projectId, projects.projectId))
			.where(and(eq(projects.organizationId, organizationId), statusFilter)),
		db
			.select({ scanJobId: scanJobs.scanJobId })
			.from(scanJobs)
			.innerJoin(compose, eq(scanJobs.composeId, compose.composeId))
			.innerJoin(
				environments,
				eq(compose.environmentId, environments.environmentId),
			)
			.innerJoin(projects, eq(environments.projectId, projects.projectId))
			.where(and(eq(projects.organizationId, organizationId), statusFilter)),
	]);
	return [...appJobs, ...composeJobs];
};

export const readTaskCurrentTokenUsage = async (
	jsonlPath: string,
): Promise<{ totalTokens: number; cachedReadTokens: number }> => {
	try {
		const content = await fs.readFile(jsonlPath, "utf-8");
		let totalTokens = 0;
		let cachedReadTokens = 0;
		for (const rawLine of content.split("\n")) {
			const trimmed = rawLine.trim();
			if (!trimmed) continue;
			try {
				const parsed = JSON.parse(trimmed);
				const usage = getUsageUpdateCumulativeTokens(getEventUpdate(parsed));
				if (!usage) continue;
				totalTokens = usage.used;
				if (usage.cachedReadTokens !== null) {
					cachedReadTokens = usage.cachedReadTokens;
				}
			} catch {}
		}
		return { totalTokens, cachedReadTokens };
	} catch {
		return { totalTokens: 0, cachedReadTokens: 0 };
	}
};

type IncrementalTokenUsageState = {
	offset: number;
	carry: string;
	totalTokens: number;
	cachedReadTokens: number;
};

export const createIncrementalTaskTokenUsageReader = () => {
	const states = new Map<string, IncrementalTokenUsageState>();

	const read = async (jsonlPath: string) => {
		const previous = states.get(jsonlPath) || {
			offset: 0,
			carry: "",
			totalTokens: 0,
			cachedReadTokens: 0,
		};
		try {
			const handle = await fs.open(jsonlPath, "r");
			try {
				const stat = await handle.stat();
				if (stat.size < previous.offset) {
					previous.offset = 0;
					previous.carry = "";
					previous.totalTokens = 0;
					previous.cachedReadTokens = 0;
				}
				const bytesToRead = stat.size - previous.offset;
				if (bytesToRead > 0) {
					const buffer = Buffer.alloc(bytesToRead);
					await handle.read(buffer, 0, bytesToRead, previous.offset);
					previous.offset = stat.size;
					const lines = `${previous.carry}${buffer.toString("utf8")}`.split("\n");
					previous.carry = lines.pop() || "";
					for (const rawLine of lines) {
						const trimmed = rawLine.trim();
						if (!trimmed) continue;
						try {
							const usage = getUsageUpdateCumulativeTokens(
								getEventUpdate(JSON.parse(trimmed)),
							);
							if (!usage) continue;
							previous.totalTokens = usage.used;
							if (usage.cachedReadTokens !== null) {
								previous.cachedReadTokens = usage.cachedReadTokens;
							}
						} catch {}
					}
				}
			} finally {
				await handle.close();
			}
		} catch {}
		states.set(jsonlPath, previous);
		return {
			totalTokens: previous.totalTokens,
			cachedReadTokens: previous.cachedReadTokens,
		};
	};

	const clear = (jsonlPath?: string) => {
		if (jsonlPath) {
			states.delete(jsonlPath);
		} else {
			states.clear();
		}
	};

	return { read, clear };
};

export const findCandidateSandboxAgentSession = async (input: {
	candidateId: string;
	stage: "analyze-finding" | "verify-finding";
}): Promise<SandboxAgentLiveSession | null> => {
	const candidate = await findVulnerabilityCandidateByIdRepo(input.candidateId);
	const stageName = input.stage;
	const task = (
		await listTasksByScanJobAndStageRepo({
			scanJobId: candidate.scanJobId,
			stageName,
		})
	).find((item) => {
		const inputRecord = getTaskInputRecord(item.input);
		const candidateRecord =
			getNestedRecord(inputRecord, "candidate") ||
			getNestedRecord(getNestedRecord(inputRecord, "analysisResult"), "candidate");
		return getNestedString(candidateRecord, ["id"]) === input.candidateId;
	});
	if (!task?.threadId || !task.containerName || !isLiveTaskStatus(task.status)) {
		return null;
	}
	const baseDir = await resolveScanJobBaseDir(candidate.scanJobId);
	const runtimeDir = resolveScanStageTaskRuntimeDir(
		baseDir,
		stageName,
		task.name,
		task.taskId,
	);
	const liveBaseUrl = resolveCandidateSessionBaseUrl(task.containerName);
	if (!liveBaseUrl) {
		return null;
	}
	return {
		scanJobId: candidate.scanJobId,
		sessionId: task.threadId,
		provider: resolveTaskSandboxAgentProvider(task.agentProfile),
		baseUrl: liveBaseUrl,
		containerName: task.containerName,
		metadataPath: path.join(runtimeDir, "sandbox-agent-runtime.json"),
		updatedAt: task.updatedAt || null,
	};
};
