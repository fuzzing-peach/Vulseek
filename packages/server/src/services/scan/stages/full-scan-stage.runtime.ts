import { promises as fs } from "node:fs";
import path from "node:path";
import { db } from "@dokploy/server/db";
import {
	applications,
	compose,
	scanJobs,
} from "@dokploy/server/db/schema";
import { eq } from "drizzle-orm";
import { findApplicationById } from "../../application";
import { findComposeById } from "../../compose";
import type { StageOutputTextChannel } from "../pipeline/stage-definition";
import type { AgentProfileLike, ScanJob } from "../types";

const CONTAINER_SCAN_CONTEXT_ROOT = "/scan-context";

export type PipelineContext = {
	projectName: string;
	serviceName: string;
	scanJobId: string;
};

export type ScanProfileConcurrencySettings = {
	analysisConcurrency: number | null;
	verifyConcurrency: number | null;
	fullScanModuleConcurrency: number | null;
	fullScanFunctionConcurrency: number | null;
};

export type StageAgentKind = "scan" | "analysis" | "verification";
type ScanJobRef = Pick<ScanJob, "scanJobId" | "applicationId" | "composeId">;

const sanitizeContainerNamePart = (value: string) =>
	value
		.toLowerCase()
		.replace(/[^a-z0-9_.-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "") || "x";

const resolveStageAgentKindFromStageName = (stageName: string): StageAgentKind => {
	switch (stageName) {
		case "AnalysisStage":
			return "analysis";
		case "VerifyingStage":
			return "verification";
		default:
			return "scan";
	}
};

const resolveStageContainerPrefix = (stageName: string) => {
	switch (stageName) {
		case "RepositoryScanningStage":
			return "repository-scan";
		case "ModuleScanningStage":
			return "module-scan";
		case "FunctionScanningStage":
			return "function-scan";
		case "AnalysisStage":
			return "analysis";
		case "VerifyingStage":
			return "verify";
		default:
			return sanitizeContainerNamePart(stageName);
	}
};

const sanitizePathPart = (value: string) =>
	value
		.replace(/[\\/]+/g, "-")
		.replace(/[^a-zA-Z0-9._-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "") || "unknown";

const resolveMountedProfileDir = (
	input: Pick<PipelineContext, "projectName" | "serviceName">,
) =>
	path.join(
		CONTAINER_SCAN_CONTEXT_ROOT,
		"projects",
		sanitizePathPart(input.projectName),
		"profiles",
		sanitizePathPart(input.serviceName),
	);

export const resolveTaskRootSegment = (
	stageName: string,
	taskName: string,
	taskId?: string,
) => {
	const taskPathPart = taskId
		? `${sanitizePathPart(taskName)}-${sanitizePathPart(taskId).slice(0, 6)}`
		: sanitizePathPart(taskName);
	return path.join(
		"scanning",
		"full_scan",
		"stages",
		sanitizePathPart(stageName),
		"tasks",
		taskPathPart,
	);
};

const resolveScanContextMount = async (
	input: Pick<PipelineContext, "projectName" | "serviceName">,
) => {
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
		sanitizePathPart(input.projectName),
		"profiles",
		sanitizePathPart(input.serviceName),
	);
	await fs.mkdir(hostProfileDir, { recursive: true });
	return {
		mountSource: hostProfileDir,
		mountDescription: `host_path:${hostProfileDir}`,
		dockerMountArg: `-v '${hostProfileDir.replace(/'/g, `'"'"'`)}':${CONTAINER_SCAN_CONTEXT_ROOT}`,
	};
};

export const resolveStageAgentProfile = async (
	scanJob: ScanJobRef,
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

export const resolveScanProfileConcurrencySettings = async (
	scanJobId: string,
): Promise<ScanProfileConcurrencySettings> => {
	const [scanJob] = await db
		.select({
			applicationId: scanJobs.applicationId,
			composeId: scanJobs.composeId,
		})
		.from(scanJobs)
		.where(eq(scanJobs.scanJobId, scanJobId))
		.limit(1);

	if (scanJob?.applicationId) {
		const [row] = await db
			.select({
				analysisConcurrency: applications.analysisConcurrency,
				verifyConcurrency: applications.verifyConcurrency,
				fullScanModuleConcurrency: applications.fullScanModuleConcurrency,
				fullScanFunctionConcurrency:
					applications.fullScanFunctionConcurrency,
			})
			.from(applications)
			.where(eq(applications.applicationId, scanJob.applicationId))
			.limit(1);
		return {
			analysisConcurrency: row?.analysisConcurrency ?? null,
			verifyConcurrency: row?.verifyConcurrency ?? null,
			fullScanModuleConcurrency: row?.fullScanModuleConcurrency ?? null,
			fullScanFunctionConcurrency:
				row?.fullScanFunctionConcurrency ?? null,
		};
	}

	if (scanJob?.composeId) {
		const [row] = await db
			.select({
				analysisConcurrency: compose.analysisConcurrency,
				verifyConcurrency: compose.verifyConcurrency,
				fullScanModuleConcurrency: compose.fullScanModuleConcurrency,
				fullScanFunctionConcurrency: compose.fullScanFunctionConcurrency,
			})
			.from(compose)
			.where(eq(compose.composeId, scanJob.composeId))
			.limit(1);
		return {
			analysisConcurrency: row?.analysisConcurrency ?? null,
			verifyConcurrency: row?.verifyConcurrency ?? null,
			fullScanModuleConcurrency: row?.fullScanModuleConcurrency ?? null,
			fullScanFunctionConcurrency:
				row?.fullScanFunctionConcurrency ?? null,
		};
	}

	return {
		analysisConcurrency: null,
		verifyConcurrency: null,
		fullScanModuleConcurrency: null,
		fullScanFunctionConcurrency: null,
	};
};

export const resolveRepositoryArtifactsDir = async (input: {
	scanJobId: string;
	projectName: string;
	serviceName: string;
}) =>
	path.join(
		resolveMountedProfileDir(input),
		"jobs",
		input.scanJobId,
		resolveTaskRootSegment(
			"RepositoryScanningStage",
			"repository-scanning",
			input.scanJobId,
		),
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

	const stageDirPath = path.join(
		resolveMountedProfileDir(input),
		"jobs",
		input.scanJobId,
		resolveTaskRootSegment(
			"RepositoryScanningStage",
			"repository-scanning",
			input.scanJobId,
		),
	);
	await fs.mkdir(stageDirPath, { recursive: true });

	return {
		stageDirPath,
		stageRootInContainer: path.posix.join(
			CONTAINER_SCAN_CONTEXT_ROOT,
			"jobs",
			input.scanJobId,
			resolveTaskRootSegment(
				"RepositoryScanningStage",
				"repository-scanning",
				input.scanJobId,
			)
				.split(path.sep)
				.join("/"),
		),
	};
};

export type StageContext = PipelineContext & {
	stageName: string;
	taskId: string;
	taskName: string;
	outputTextChannel: StageOutputTextChannel;
	sessionMode: "new" | "fork";
	parentSessionId: string | null;
	parentTaskId: string | null;
	agentProfile: () => Promise<AgentProfileLike | null>;
	containerName: (...parts: Array<string | null | undefined>) => string;
	taskDir: (input?:
		| string
		| {
		moduleId?: string;
		functionId?: string;
		candidateId?: string;
		taskName?: string;
		stageName?: string;
	}) => Promise<string>;
	taskDirContainer: () => Promise<string>;
	repositoryArtifactsDir: () => Promise<string>;
	repositoryStageRuntime: () => Promise<{
		stageDirPath: string;
		stageRootInContainer: string;
	}>;
};

export const createStageContext = <TBase extends PipelineContext>(input: {
	base: TBase;
	stageName: string;
	scanJob: ScanJobRef;
	taskId: string;
	taskName: string;
	outputTextChannel?: StageOutputTextChannel;
	sessionMode?: "new" | "fork";
	parentSessionId?: string | null;
	parentTaskId?: string | null;
}): TBase & StageContext => ({
	...input.base,
	stageName: input.stageName,
	taskId: input.taskId,
	taskName: input.taskName,
	outputTextChannel: input.outputTextChannel || "file",
	sessionMode: input.sessionMode || "new",
	parentSessionId: input.parentSessionId ?? null,
	parentTaskId: input.parentTaskId ?? null,
	agentProfile: async () =>
		await resolveStageAgentProfile(
			input.scanJob,
			resolveStageAgentKindFromStageName(input.stageName),
		),
	containerName: (...parts) =>
		[
			sanitizeContainerNamePart(input.base.projectName),
			sanitizeContainerNamePart(input.base.serviceName),
			resolveStageContainerPrefix(input.stageName),
			sanitizeContainerNamePart(input.scanJob.scanJobId),
			...parts
				.filter((value): value is string => Boolean(value && value.trim()))
				.map((value) => sanitizeContainerNamePart(value)),
			sanitizeContainerNamePart(input.taskId),
		].join("-"),
	taskDir: async (runtimeInput) => {
		const normalizedRuntimeInput =
			typeof runtimeInput === "string"
				? { taskName: runtimeInput, stageName: input.stageName }
				: runtimeInput;
		const targetStageName = normalizedRuntimeInput?.stageName || input.stageName;
		const targetTaskName = normalizedRuntimeInput?.taskName || input.taskName;
		await resolveScanContextMount(input.base);
		const defaultStageDirPath = path.join(
			resolveMountedProfileDir(input.base),
			"jobs",
			input.scanJob.scanJobId,
			resolveTaskRootSegment(targetStageName, targetTaskName, input.taskId),
		);
		await fs.mkdir(defaultStageDirPath, { recursive: true });
		return defaultStageDirPath;
	},
	taskDirContainer: async () =>
		path.posix.join(
			CONTAINER_SCAN_CONTEXT_ROOT,
			"jobs",
			input.scanJob.scanJobId,
			resolveTaskRootSegment(input.stageName, input.taskName, input.taskId)
				.split(path.sep)
				.join("/"),
		),
	repositoryArtifactsDir: async () =>
		await resolveRepositoryArtifactsDir({
			scanJobId: input.scanJob.scanJobId,
			projectName: input.base.projectName,
			serviceName: input.base.serviceName,
		}),
	repositoryStageRuntime: async () =>
		await resolveRepositoryStageRuntime({
			scanJobId: input.scanJob.scanJobId,
			projectName: input.base.projectName,
			serviceName: input.base.serviceName,
		}),
});
