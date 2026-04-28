import { promises as fs } from "node:fs";
import path from "node:path";
import { findApplicationById } from "../../application";
import { findComposeById } from "../../compose";
import type { AgentProfileLike, ScanJob } from "../types";

const CONTAINER_SCAN_CONTEXT_ROOT = "/scan-context";

export type StageRuntimeTarget = {
	projectName: string;
	serviceName: string;
};

export type StageAgentKind = "scan" | "analysis" | "verification";

const resolveScanContextMount = async (input: StageRuntimeTarget) => {
	const configuredHostRoot =
		process.env.DOKPLOY_SCAN_CONTEXT_HOST_PATH?.trim() || "";
	if (!configuredHostRoot) {
		throw new Error(
			"Scan context host path is not configured in process env DOKPLOY_SCAN_CONTEXT_HOST_PATH",
		);
	}

	const hostProfileDir = path.join(
		configuredHostRoot,
		"projects",
		input.projectName
			.replace(/[\\/]+/g, "-")
			.replace(/[^a-zA-Z0-9._-]/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "") || "unknown",
		"profiles",
		input.serviceName
			.replace(/[\\/]+/g, "-")
			.replace(/[^a-zA-Z0-9._-]/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "") || "unknown",
	);
	await fs.mkdir(hostProfileDir, { recursive: true });
	return {
		mountSource: hostProfileDir,
		mountDescription: `host_path:${hostProfileDir}`,
		dockerMountArg: `-v '${hostProfileDir.replace(/'/g, `'"'"'`)}':${CONTAINER_SCAN_CONTEXT_ROOT}`,
	};
};

export const resolveStageAgentProfile = async (
	scanJob: ScanJob,
	kind: StageAgentKind,
): Promise<AgentProfileLike | null> => {
	const target = scanJob.applicationId
		? await findApplicationById(scanJob.applicationId)
		: await findComposeById(scanJob.composeId as string);
	const targetDefaultAgentProfile =
		("agentProfile" in target && target.agentProfile) || null;

	switch (kind) {
		case "scan":
			return (
				("scanAgentProfile" in target && target.scanAgentProfile) ||
				targetDefaultAgentProfile ||
				null
			);
		case "analysis":
			return (
				("analysisAgentProfile" in target && target.analysisAgentProfile) ||
				targetDefaultAgentProfile ||
				null
			);
		case "verification":
			return (
				("verifierAgentProfile" in target && target.verifierAgentProfile) ||
				targetDefaultAgentProfile ||
				null
			);
	}
};

export const resolveRepositoryArtifactsDir = async (input: {
	scanJobId: string;
	projectName: string;
	serviceName: string;
}) =>
	path.join(
		CONTAINER_SCAN_CONTEXT_ROOT,
		"projects",
		input.projectName
			.replace(/[\\/]+/g, "-")
			.replace(/[^a-zA-Z0-9._-]/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "") || "unknown",
		"profiles",
		input.serviceName
			.replace(/[\\/]+/g, "-")
			.replace(/[^a-zA-Z0-9._-]/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "") || "unknown",
		"jobs",
		input.scanJobId,
		"scanning",
		"full_scan",
		"repository",
	);

export const resolveRepositoryStageRuntime = async (input: {
	scanJobId: string;
	projectName: string;
	serviceName: string;
}) => {
	await resolveScanContextMount({
		projectName: input.projectName,
		serviceName: input.serviceName,
	});

	const runtimeDirHost = path.join(
		CONTAINER_SCAN_CONTEXT_ROOT,
		"projects",
		input.projectName
			.replace(/[\\/]+/g, "-")
			.replace(/[^a-zA-Z0-9._-]/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "") || "unknown",
		"profiles",
		input.serviceName
			.replace(/[\\/]+/g, "-")
			.replace(/[^a-zA-Z0-9._-]/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "") || "unknown",
		"jobs",
		input.scanJobId,
		"scanning",
	);
	await fs.mkdir(runtimeDirHost, { recursive: true });

	return {
		runtimeDirHost,
		runtimeRootInContainer: path.posix.join(
			CONTAINER_SCAN_CONTEXT_ROOT,
			"jobs",
			input.scanJobId,
			"scanning",
		),
		setupMarkdownPathInContainer: path.posix.join(
			CONTAINER_SCAN_CONTEXT_ROOT,
			"jobs",
			input.scanJobId,
			"scanning",
			"full_scan",
			"repository",
			"00_setup.md",
		),
	};
};

export const resolveModuleStageRuntime = async (input: {
	scanJobId: string;
	moduleId: string;
	artifactDir: string;
}) => {
	await fs.mkdir(input.artifactDir, { recursive: true });
	const sanitizedModuleId =
		input.moduleId
			.replace(/[\\/]+/g, "-")
			.replace(/[^a-zA-Z0-9._-]/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "") || "unknown";
	const runtimeRootInContainer = path.posix.join(
		CONTAINER_SCAN_CONTEXT_ROOT,
		"jobs",
		input.scanJobId,
		"scanning",
		"full_scan",
		"modules",
		sanitizedModuleId,
	);
	return {
		runtimeDirHost: input.artifactDir,
		runtimeRootInContainer,
		setupMarkdownPathInContainer: `${runtimeRootInContainer}/00_setup.md`,
	};
};

export const resolveFunctionStageRuntime = async (input: {
	scanJobId: string;
	moduleId: string;
	functionId: string;
	moduleArtifactDir: string;
}) => {
	const sanitizedModuleId =
		input.moduleId
			.replace(/[\\/]+/g, "-")
			.replace(/[^a-zA-Z0-9._-]/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "") || "unknown";
	const sanitizedFunctionId =
		input.functionId
			.replace(/[\\/]+/g, "-")
			.replace(/[^a-zA-Z0-9._-]/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "") || "unknown";
	const runtimeDirHost = path.join(
		input.moduleArtifactDir,
		"functions",
		sanitizedFunctionId,
	);
	await fs.mkdir(runtimeDirHost, { recursive: true });
	const runtimeRootInContainer = path.posix.join(
		CONTAINER_SCAN_CONTEXT_ROOT,
		"jobs",
		input.scanJobId,
		"scanning",
		"full_scan",
		"modules",
		sanitizedModuleId,
		"functions",
		sanitizedFunctionId,
	);
	return {
		runtimeDirHost,
		runtimeRootInContainer,
		setupMarkdownPathInContainer: `${runtimeRootInContainer}/00_setup.md`,
	};
};
