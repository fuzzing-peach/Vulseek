import { promises as fs } from "node:fs";
import path from "node:path";
import { findApplicationById } from "../application";
import { findComposeById } from "../compose";
import { execAsync } from "../../utils/process/execAsync";
import { findScanJobByIdRepo } from "./persistence/scan-job.repo";
import {
	findScanRepositoryTaskByIdRepo,
	findScanRepositoryTaskByScanJobIdRepo,
} from "./persistence/scan-repository-task.repo";
import { findScanModuleTaskByIdRepo } from "./persistence/scan-module-task.repo";
import { findScanFunctionTaskByIdRepo } from "./persistence/scan-function-task.repo";
import { findVulnerabilityCandidateByIdRepo } from "./persistence/candidate.repo";
import {
	findCandidateAnalysisTaskByCandidateIdRepo,
	findCandidateAnalysisTaskByIdRepo,
} from "./persistence/analysis-result.repo";
import {
	findCandidateVerificationTaskByCandidateIdRepo,
	findCandidateVerificationTaskByIdRepo,
} from "./persistence/verification-result.repo";

const sanitizePathPart = (value: string) =>
	value
		.replace(/[\\/]+/g, "-")
		.replace(/[^a-zA-Z0-9._-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "") || "unknown";

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

const resolveScanJobBaseDir = async (scanJobId: string) => {
	const scanJob = await findScanJobByIdRepo(scanJobId);
	const target = scanJob.applicationId
		? await findApplicationById(scanJob.applicationId)
		: await findComposeById(scanJob.composeId as string);
	const projectName = target.environment.project.name;
	const serviceName = target.name || target.appName;
	return path.join(
		await resolveScanContextRoot(),
		"projects",
		sanitizePathPart(projectName),
		"profiles",
		sanitizePathPart(serviceName),
		"jobs",
		scanJobId,
	);
};

type SandboxAgentRuntimeMetadata = {
	runtime?: string;
	provider?: "codex" | "claude";
	server?: {
		baseUrl?: string;
		publicBaseUrl?: string;
		host?: string;
		port?: number;
	};
	updatedAt?: string;
};

const readSandboxAgentRuntimeMetadata = async (runtimeDir: string) => {
	const metadataPath = path.join(runtimeDir, "sandbox-agent-runtime.json");
	try {
		const raw = await fs.readFile(metadataPath, "utf-8");
		const parsed = JSON.parse(raw) as SandboxAgentRuntimeMetadata;
		const baseUrl = parsed.server?.publicBaseUrl || parsed.server?.baseUrl;
		if (!baseUrl || !parsed.provider) {
			return null;
		}
		return {
			baseUrl,
			provider: parsed.provider,
			metadataPath,
			updatedAt: parsed.updatedAt || null,
		};
	} catch {
		return null;
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
	if (input.stage === "repository_scanning") {
		const task = await findScanRepositoryTaskByIdRepo(input.taskId).catch(() => null);
		if (task) {
			return {
				scanJobId: task.scanJobId,
				threadId: task.threadId,
				containerName: task.containerName,
			};
		}

		const scanJob = await findScanJobByIdRepo(input.taskId).catch(() => null);
		if (!scanJob?.repositoryTaskId) {
			return null;
		}
		const repositoryTask = await findScanRepositoryTaskByScanJobIdRepo(
			scanJob.scanJobId,
		).catch(() => null);
		if (!repositoryTask) {
			return null;
		}
		return {
			scanJobId: repositoryTask.scanJobId,
			threadId: repositoryTask.threadId,
			containerName: repositoryTask.containerName,
		};
	}

	if (input.stage === "module_scanning") {
		const task = await findScanModuleTaskByIdRepo(input.taskId).catch(() => null);
		if (!task) {
			return null;
		}
		return {
			scanJobId: task.scanJobId,
			threadId: task.threadId,
			containerName: task.containerName,
		};
	}

	const task = await findScanFunctionTaskByIdRepo(input.taskId).catch(() => null);
	if (!task) {
		return null;
	}
	return {
		scanJobId: task.scanJobId,
		threadId: task.threadId,
		containerName: task.containerName,
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
		provider: "codex",
		baseUrl: publicBaseUrl,
		containerName: task.containerName,
		metadataPath: internalBaseUrl,
		updatedAt: null,
	};
};

const resolveCandidateSessionBaseUrl = async (containerName: string | null) => {
	if (!containerName) {
		return null;
	}
	try {
		await inspectContainerIpAddress(containerName);
		return `/sandbox-agent/${containerName}`;
	} catch {
		return null;
	}
};

const buildSandboxAgentRuntimeFiles = (runtimeDir: string) => ({
	jsonlPath: path.join(runtimeDir, "sandbox-agent-event.jsonl"),
	textPath: path.join(runtimeDir, "sandbox-agent-text.txt"),
	stderrPath: path.join(runtimeDir, "app-server-stderr.log"),
	metadataPath: path.join(runtimeDir, "sandbox-agent-runtime.json"),
});

const toPublicBaseUrl = (containerName: string | null) =>
	containerName ? `/sandbox-agent/${containerName}` : null;

const readSandboxAgentProvider = async (runtimeDir: string) => {
	const runtime = await readSandboxAgentRuntimeMetadata(runtimeDir);
	return runtime?.provider || "codex";
};

export const findSandboxAgentTaskRuntimeByTaskId = async (
	taskId: string,
): Promise<SandboxAgentTaskRuntime | null> => {
	const repositoryTask = await findScanRepositoryTaskByIdRepo(taskId).catch(() => null);
	if (repositoryTask) {
		const baseDir = await resolveScanJobBaseDir(repositoryTask.scanJobId);
		const runtimeDir = path.join(baseDir, "scanning");
		return {
			taskId,
			scanJobId: repositoryTask.scanJobId,
			taskKind: "repository_scanning",
			status: repositoryTask.status,
			containerName: repositoryTask.containerName,
			sessionId: repositoryTask.threadId,
			baseUrl: toPublicBaseUrl(repositoryTask.containerName),
			provider: await readSandboxAgentProvider(runtimeDir),
			...buildSandboxAgentRuntimeFiles(runtimeDir),
			updatedAt: repositoryTask.updatedAt || null,
		};
	}

	const moduleTask = await findScanModuleTaskByIdRepo(taskId).catch(() => null);
	if (moduleTask) {
		const baseDir = await resolveScanJobBaseDir(moduleTask.scanJobId);
		const runtimeDir = path.join(
			baseDir,
			"scanning",
			"full_scan",
			"modules",
			sanitizePathPart(moduleTask.moduleId),
		);
		return {
			taskId,
			scanJobId: moduleTask.scanJobId,
			taskKind: "module_scanning",
			status: moduleTask.status,
			containerName: moduleTask.containerName,
			sessionId: moduleTask.threadId,
			baseUrl: toPublicBaseUrl(moduleTask.containerName),
			provider: await readSandboxAgentProvider(runtimeDir),
			...buildSandboxAgentRuntimeFiles(runtimeDir),
			updatedAt: moduleTask.updatedAt || null,
		};
	}

	const functionTask = await findScanFunctionTaskByIdRepo(taskId).catch(() => null);
	if (functionTask) {
		const baseDir = await resolveScanJobBaseDir(functionTask.scanJobId);
		const runtimeDir = path.join(
			baseDir,
			"scanning",
			"full_scan",
			"modules",
			sanitizePathPart(functionTask.moduleId),
			"functions",
			sanitizePathPart(functionTask.functionId),
		);
		return {
			taskId,
			scanJobId: functionTask.scanJobId,
			taskKind: "function_scanning",
			status: functionTask.status,
			containerName: functionTask.containerName,
			sessionId: functionTask.threadId,
			baseUrl: toPublicBaseUrl(functionTask.containerName),
			provider: await readSandboxAgentProvider(runtimeDir),
			...buildSandboxAgentRuntimeFiles(runtimeDir),
			updatedAt: functionTask.updatedAt || null,
		};
	}

	const analysisTask = await findCandidateAnalysisTaskByIdRepo(taskId).catch(() => null);
	if (analysisTask) {
		const baseDir = await resolveScanJobBaseDir(analysisTask.scanJobId);
		const runtimeDir = path.join(
			baseDir,
			"candidates",
			analysisTask.vulnerabilityCandidateId,
		);
		return {
			taskId,
			scanJobId: analysisTask.scanJobId,
			taskKind: "analyzing",
			status: analysisTask.status,
			containerName: analysisTask.containerName,
			sessionId: analysisTask.threadId,
			baseUrl: toPublicBaseUrl(analysisTask.containerName),
			provider: await readSandboxAgentProvider(runtimeDir),
			...buildSandboxAgentRuntimeFiles(runtimeDir),
			updatedAt: analysisTask.updatedAt || null,
		};
	}

	const verificationTask = await findCandidateVerificationTaskByIdRepo(taskId).catch(
		() => null,
	);
	if (!verificationTask) {
		return null;
	}
	const baseDir = await resolveScanJobBaseDir(verificationTask.scanJobId);
	const runtimeDir = path.join(
		baseDir,
		"candidates",
		verificationTask.vulnerabilityCandidateId,
	);
	return {
		taskId,
		scanJobId: verificationTask.scanJobId,
		taskKind: "verifying",
		status: verificationTask.status,
		containerName: verificationTask.containerName,
		sessionId: verificationTask.threadId,
		baseUrl: toPublicBaseUrl(verificationTask.containerName),
		provider: await readSandboxAgentProvider(runtimeDir),
		...buildSandboxAgentRuntimeFiles(runtimeDir),
		updatedAt: verificationTask.updatedAt || null,
	};
};

export const findCandidateSandboxAgentSession = async (input: {
	candidateId: string;
	stage: "analyzing" | "verifying";
}): Promise<SandboxAgentLiveSession | null> => {
	const candidate = await findVulnerabilityCandidateByIdRepo(input.candidateId);
	const baseDir = await resolveScanJobBaseDir(candidate.scanJobId);
	const runtime = await readSandboxAgentRuntimeMetadata(
		path.join(baseDir, "candidates", candidate.vulnerabilityCandidateId),
	);
	if (!runtime) {
		return null;
	}
	const task =
		input.stage === "verifying"
			? await findCandidateVerificationTaskByCandidateIdRepo(input.candidateId)
			: await findCandidateAnalysisTaskByCandidateIdRepo(input.candidateId);
	if (!task?.threadId) {
		return null;
	}
	const liveBaseUrl =
		(await resolveCandidateSessionBaseUrl(task.containerName || null)) ||
		runtime.baseUrl;
	return {
		scanJobId: candidate.scanJobId,
		sessionId: task.threadId,
		provider: runtime.provider,
		baseUrl: liveBaseUrl,
		containerName: task.containerName,
		metadataPath: runtime.metadataPath,
		updatedAt: runtime.updatedAt,
	};
};
