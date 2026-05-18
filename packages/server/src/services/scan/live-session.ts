import { promises as fs } from "node:fs";
import path from "node:path";
import { db } from "@dokploy/server/db";
import {
	applications,
	compose,
	environments,
	projects,
	scanJobs,
} from "@dokploy/server/db/schema";
import { eq } from "drizzle-orm";
import { findApplicationById } from "../application";
import { findComposeById } from "../compose";
import { execAsync } from "../../utils/process/execAsync";
import { findScanJobByIdRepo } from "./persistence/scan-job.repo";
import { findVulnerabilityCandidateByIdRepo } from "./persistence/candidate.repo";
import {
	findTaskByIdRepo,
	listTasksByScanJobIdRepo,
	listTasksByScanJobAndStageRepo,
} from "./persistence/task.repo";
import { SANDBOX_AGENT_RUNTIME_FILE_NAMES } from "./runtime/sandbox-agent-shared";
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
		process.env.DOKPLOY_SCAN_CONTEXT_HOST_PATH?.trim() || "",
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

const resolveTaskRuntimeName = (
	stageName: string,
	taskName: string,
	taskInput: unknown,
): string => {
	const inputRecord = getTaskInputRecord(taskInput);
	switch (stageName) {
		case "RepositoryScanningStage":
			return "repository-scanning";
		case "ModuleScanningStage":
			return getNestedString(getNestedRecord(inputRecord, "module"), ["name"]) || taskName;
		case "FunctionScanningStage":
			return (
				getNestedString(getNestedRecord(inputRecord, "function"), ["functionName"]) ||
				taskName
			);
		case "AnalysisStage":
		case "FuzzBuildStage":
		case "FuzzRunStage":
		case "AnalysisCriticStage":
			return (
				getNestedString(getNestedRecord(inputRecord, "candidate"), ["title"]) ||
				(stageName === "AnalysisStage" ? taskName : stageName)
			);
		case "VerifyingStage":
			return (
				getNestedString(
					getNestedRecord(
						getNestedRecord(inputRecord, "analysisResult"),
						"candidate",
					),
					["title"],
				) || taskName
			);
		default:
			return taskName;
	}
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
	taskKind:
		| "repository_scanning"
		| "module_scanning"
		| "function_scanning"
		| "analyzing"
		| "fuzz_building"
		| "fuzzing"
		| "criticizing"
		| "verifying";
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
	stage: "repository_scanning" | "module_scanning" | "function_scanning";
	taskId: string;
}) => {
	const task = await findTaskByIdRepo(input.taskId).catch(() => null);
	if (!task) {
		if (input.stage !== "repository_scanning") {
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
		};
	}
	return {
		scanJobId: task.scanJobId,
		threadId: task.threadId,
		containerName: task.containerName,
		agentProfile: task.agentProfile,
	};
};

export const findScanJobSandboxAgentSession = async (input: {
	stage: "repository_scanning" | "module_scanning" | "function_scanning";
	taskId: string;
}): Promise<SandboxAgentLiveSession | null> => {
	const task = await resolveScannerTaskSession(input);
	if (!task?.threadId || !task.containerName) {
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

export const findSandboxAgentTaskRuntimeByTaskId = async (
	taskId: string,
): Promise<SandboxAgentTaskRuntime | null> => {
	const task = await findTaskByIdRepo(taskId).catch(() => null);
	if (task) {
		return buildSandboxAgentTaskRuntime(task);
	}
	return null;
};

const buildSandboxAgentTaskRuntime = async (
	task: Task,
): Promise<SandboxAgentTaskRuntime> => {
	const baseDir = await resolveScanJobBaseDir(task.scanJobId);
	const runtimeTaskName = resolveTaskRuntimeName(
		task.stageName,
		task.name,
		task.input,
	);
	let runtimeDir = path.join(baseDir, sanitizePathPart(runtimeTaskName));
	let taskKind: SandboxAgentTaskRuntime["taskKind"] = "repository_scanning";

	switch (task.stageName) {
		case "RepositoryScanningStage":
			taskKind = "repository_scanning";
			runtimeDir = resolveScanStageTaskRuntimeDir(
				baseDir,
				task.stageName,
				runtimeTaskName,
				task.taskId,
			);
			break;
		case "ModuleScanningStage":
			taskKind = "module_scanning";
			runtimeDir = resolveScanStageTaskRuntimeDir(
				baseDir,
				task.stageName,
				runtimeTaskName,
				task.taskId,
			);
			break;
		case "FunctionScanningStage":
			taskKind = "function_scanning";
			runtimeDir = resolveScanStageTaskRuntimeDir(
				baseDir,
				task.stageName,
				runtimeTaskName,
				task.taskId,
			);
			break;
		case "AnalysisStage":
			taskKind = "analyzing";
			runtimeDir = resolveScanStageTaskRuntimeDir(
				baseDir,
				task.stageName,
				runtimeTaskName,
				task.taskId,
			);
			break;
		case "FuzzBuildStage":
			taskKind = "fuzz_building";
			runtimeDir = resolveScanStageTaskRuntimeDir(
				baseDir,
				task.stageName,
				runtimeTaskName,
				task.taskId,
			);
			break;
		case "FuzzRunStage":
			taskKind = "fuzzing";
			runtimeDir = resolveScanStageTaskRuntimeDir(
				baseDir,
				task.stageName,
				runtimeTaskName,
				task.taskId,
			);
			break;
		case "AnalysisCriticStage":
			taskKind = "criticizing";
			runtimeDir = resolveScanStageTaskRuntimeDir(
				baseDir,
				task.stageName,
				runtimeTaskName,
				task.taskId,
			);
			break;
		case "VerifyingStage":
			taskKind = "verifying";
			runtimeDir = resolveScanStageTaskRuntimeDir(
				baseDir,
				task.stageName,
				runtimeTaskName,
				task.taskId,
			);
			break;
	}

	return {
		taskId: task.taskId,
		scanJobId: task.scanJobId,
		taskKind,
		status: task.status,
		containerName: task.containerName,
		sessionId: task.threadId,
		baseUrl: toPublicBaseUrl(task.containerName),
		provider: resolveTaskSandboxAgentProvider(task.agentProfile),
		...buildSandboxAgentRuntimeFiles(runtimeDir),
		updatedAt: task.updatedAt || null,
	};
};

export const findRunningSandboxAgentTaskRuntimesByScanJobId = async (
	scanJobId: string,
): Promise<SandboxAgentTaskRuntime[]> => {
	const tasks = await listTasksByScanJobIdRepo(scanJobId);
	const runningTasks = tasks.filter((task) => task.status === "running");
	return await Promise.all(runningTasks.map(buildSandboxAgentTaskRuntime));
};

export const findCandidateSandboxAgentSession = async (input: {
	candidateId: string;
	stage: "analyzing" | "verifying";
}): Promise<SandboxAgentLiveSession | null> => {
	const candidate = await findVulnerabilityCandidateByIdRepo(input.candidateId);
	const stageName =
		input.stage === "verifying" ? "VerifyingStage" : "AnalysisStage";
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
	if (!task?.threadId || !task.containerName) {
		return null;
	}
	const baseDir = await resolveScanJobBaseDir(candidate.scanJobId);
	const runtimeTaskName = resolveTaskRuntimeName(
		stageName,
		task.name,
		task.input,
	);
	const runtimeDir = resolveScanStageTaskRuntimeDir(
		baseDir,
		stageName,
		runtimeTaskName,
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
