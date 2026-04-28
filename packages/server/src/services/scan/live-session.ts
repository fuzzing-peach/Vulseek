import { promises as fs } from "node:fs";
import path from "node:path";
import { findApplicationById } from "../application";
import { findComposeById } from "../compose";
import { findScanJobByIdRepo } from "./persistence/scan-job.repo";
import { findScanRepositoryTaskByScanJobIdRepo } from "./persistence/scan-repository-task.repo";
import { findScanModuleTaskByIdRepo } from "./persistence/scan-module-task.repo";
import { findScanFunctionTaskByIdRepo } from "./persistence/scan-function-task.repo";
import { findVulnerabilityCandidateByIdRepo } from "./persistence/candidate.repo";
import { findCandidateAnalysisTaskByCandidateIdRepo } from "./persistence/analysis-result.repo";
import { findCandidateVerificationTaskByCandidateIdRepo } from "./persistence/verification-result.repo";

const sanitizePathPart = (value: string) =>
	value
		.replace(/[\\/]+/g, "-")
		.replace(/[^a-zA-Z0-9._-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "") || "unknown";

const resolveScanContextRoot = () =>
	process.env.DOKPLOY_SCAN_CONTEXT_HOST_PATH?.trim() || "/scan-context";

const resolveScanJobBaseDir = async (scanJobId: string) => {
	const scanJob = await findScanJobByIdRepo(scanJobId);
	const target = scanJob.applicationId
		? await findApplicationById(scanJob.applicationId)
		: await findComposeById(scanJob.composeId as string);
	const projectName = target.environment.project.name;
	const serviceName = target.name || target.appName;
	return path.join(
		resolveScanContextRoot(),
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
	sessionId: string;
	provider: "codex" | "claude";
	baseUrl: string;
	containerName: string | null;
	metadataPath: string;
	updatedAt: string | null;
};

export const findScanJobSandboxAgentSession = async (input: {
	scanJobId: string;
	stage: "repository_scanning" | "module_scanning" | "function_scanning";
	scanModuleTaskId?: string;
	scanFunctionTaskId?: string;
}): Promise<SandboxAgentLiveSession | null> => {
	const baseDir = await resolveScanJobBaseDir(input.scanJobId);

	if (input.stage === "repository_scanning") {
		const task = await findScanRepositoryTaskByScanJobIdRepo(input.scanJobId);
		if (!task.threadId) {
			return null;
		}
		const runtime = await readSandboxAgentRuntimeMetadata(
			path.join(baseDir, "scanning"),
		);
		if (!runtime) {
			return null;
		}
		return {
			sessionId: task.threadId,
			provider: runtime.provider,
			baseUrl: runtime.baseUrl,
			containerName: task.containerName,
			metadataPath: runtime.metadataPath,
			updatedAt: runtime.updatedAt,
		};
	}

	if (input.stage === "module_scanning") {
		if (!input.scanModuleTaskId) {
			return null;
		}
		const task = await findScanModuleTaskByIdRepo(input.scanModuleTaskId);
		if (!task.threadId || task.scanJobId !== input.scanJobId) {
			return null;
		}
		const runtime = await readSandboxAgentRuntimeMetadata(
			path.join(
				baseDir,
				"scanning",
				"full_scan",
				"modules",
				sanitizePathPart(task.moduleId),
			),
		);
		if (!runtime) {
			return null;
		}
		return {
			sessionId: task.threadId,
			provider: runtime.provider,
			baseUrl: runtime.baseUrl,
			containerName: task.containerName,
			metadataPath: runtime.metadataPath,
			updatedAt: runtime.updatedAt,
		};
	}

	if (!input.scanFunctionTaskId) {
		return null;
	}
	const task = await findScanFunctionTaskByIdRepo(input.scanFunctionTaskId);
	if (!task.threadId || task.scanJobId !== input.scanJobId) {
		return null;
	}
	const runtime = await readSandboxAgentRuntimeMetadata(
		path.join(
			baseDir,
			"scanning",
			"full_scan",
			"modules",
			sanitizePathPart(task.moduleId),
			"functions",
			sanitizePathPart(task.functionId),
		),
	);
	if (!runtime) {
		return null;
	}
	return {
		sessionId: task.threadId,
		provider: runtime.provider,
		baseUrl: runtime.baseUrl,
		containerName: task.containerName,
		metadataPath: runtime.metadataPath,
		updatedAt: runtime.updatedAt,
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
	return {
		sessionId: task.threadId,
		provider: runtime.provider,
		baseUrl: runtime.baseUrl,
		containerName: task.containerName,
		metadataPath: runtime.metadataPath,
		updatedAt: runtime.updatedAt,
	};
};
