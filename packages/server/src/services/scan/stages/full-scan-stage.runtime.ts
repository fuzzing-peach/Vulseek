import { promises as fs } from "node:fs";
import path from "node:path";
import { db } from "@dokploy/server/db";
import {
	applications,
	compose,
	scanJobs,
} from "@dokploy/server/db/schema";
import { eq } from "drizzle-orm";
import type { ZodTypeAny } from "zod";
import { getAgentProfileById } from "../../ai";
import { findApplicationById } from "../../application";
import { findComposeById } from "../../compose";
import type { AgentProfileLike, ScanJob } from "../types";
import type { ScanStageSettings } from "@dokploy/server/db/schema";

const CONTAINER_SCAN_CONTEXT_ROOT = "/scan-context";
const CONTAINER_TASK_RUNTIME_ROOT = "/task";

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
	fuzzingBudgetSeconds: number | null;
	scanStageSettings: ScanStageSettings;
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
		case "FuzzBuildStage":
		case "FuzzRunStage":
		case "AnalysisCriticStage":
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
		case "FuzzBuildStage":
			return "fuzz-build";
		case "FuzzRunStage":
			return "fuzz-run";
		case "AnalysisCriticStage":
			return "analysis-critic";
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

export const resolveStageLaneRootSegment = (
	stageName: string,
	laneIndex: number,
) =>
	path.join(
		"scanning",
		"full_scan",
		"stages",
		sanitizePathPart(stageName),
		"lanes",
		`lane-${laneIndex}`,
	);

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
	stageName?: string,
): Promise<AgentProfileLike | null> => {
	const target = scanJob.applicationId
		? await findApplicationById(scanJob.applicationId)
		: await findComposeById(scanJob.composeId as string);
	const targetDefaultAgentProfile =
		("agentProfile" in target && target.agentProfile) || null;
	const stageAgentProfileId =
		stageName && "scanStageSettings" in target
			? target.scanStageSettings?.[stageName]?.agentProfileId
			: null;
	if (stageAgentProfileId) {
		return (
			(await getAgentProfileById(stageAgentProfileId).catch(() => null)) ||
			targetDefaultAgentProfile ||
			null
		);
	}

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
				fuzzingBudgetSeconds: applications.fuzzingBudgetSeconds,
				fullScanModuleConcurrency: applications.fullScanModuleConcurrency,
				fullScanFunctionConcurrency:
					applications.fullScanFunctionConcurrency,
				scanStageSettings: applications.scanStageSettings,
			})
			.from(applications)
			.where(eq(applications.applicationId, scanJob.applicationId))
			.limit(1);
		return {
			analysisConcurrency: row?.analysisConcurrency ?? null,
			verifyConcurrency: row?.verifyConcurrency ?? null,
			fuzzingBudgetSeconds: row?.fuzzingBudgetSeconds ?? null,
			fullScanModuleConcurrency: row?.fullScanModuleConcurrency ?? null,
			fullScanFunctionConcurrency:
				row?.fullScanFunctionConcurrency ?? null,
			scanStageSettings: row?.scanStageSettings ?? {},
		};
	}

	if (scanJob?.composeId) {
		const [row] = await db
			.select({
				analysisConcurrency: compose.analysisConcurrency,
				verifyConcurrency: compose.verifyConcurrency,
				fuzzingBudgetSeconds: compose.fuzzingBudgetSeconds,
				fullScanModuleConcurrency: compose.fullScanModuleConcurrency,
				fullScanFunctionConcurrency: compose.fullScanFunctionConcurrency,
				scanStageSettings: compose.scanStageSettings,
			})
			.from(compose)
			.where(eq(compose.composeId, scanJob.composeId))
			.limit(1);
		return {
			analysisConcurrency: row?.analysisConcurrency ?? null,
			verifyConcurrency: row?.verifyConcurrency ?? null,
			fuzzingBudgetSeconds: row?.fuzzingBudgetSeconds ?? null,
			fullScanModuleConcurrency: row?.fullScanModuleConcurrency ?? null,
			fullScanFunctionConcurrency:
				row?.fullScanFunctionConcurrency ?? null,
			scanStageSettings: row?.scanStageSettings ?? {},
		};
	}

	return {
		analysisConcurrency: null,
		verifyConcurrency: null,
		fullScanModuleConcurrency: null,
		fullScanFunctionConcurrency: null,
		fuzzingBudgetSeconds: null,
		scanStageSettings: {},
	};
};

export const resolveStageConcurrencySetting = async (
	scanJobId: string,
	stageName: string,
	fallback: (settings: ScanProfileConcurrencySettings) => number | null,
) => {
	const settings = await resolveScanProfileConcurrencySettings(scanJobId);
	return Math.max(
		1,
		settings.scanStageSettings?.[stageName]?.concurrency ||
			fallback(settings) ||
			1,
	);
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
		stageRootInContainer: CONTAINER_TASK_RUNTIME_ROOT,
	};
};

export type StageContext = PipelineContext & {
	stageName: string;
	taskId: string;
	taskName: string;
	persistent: boolean;
	laneIndex: number | null;
	laneThreadId: string | null;
	routeOutputSchemas?: Array<{
		routeKey: string;
		description?: string;
		schema: ZodTypeAny;
		default?: boolean;
	}>;
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
	laneDir: () => Promise<string>;
	laneDirContainer: () => Promise<string>;
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
	routeOutputSchemas?: Array<{
		routeKey: string;
		description?: string;
		schema: ZodTypeAny;
		default?: boolean;
	}>;
	persistent?: boolean;
	laneIndex?: number | null;
	laneThreadId?: string | null;
	sessionMode?: "new" | "fork";
	parentSessionId?: string | null;
	parentTaskId?: string | null;
}): TBase & StageContext => ({
	...input.base,
	stageName: input.stageName,
	taskId: input.taskId,
	taskName: input.taskName,
	persistent: input.persistent ?? false,
	laneIndex: input.laneIndex ?? null,
	laneThreadId: input.laneThreadId ?? null,
	routeOutputSchemas: input.routeOutputSchemas,
	sessionMode: input.sessionMode || "new",
	parentSessionId: input.parentSessionId ?? null,
	parentTaskId: input.parentTaskId ?? null,
	agentProfile: async () =>
		await resolveStageAgentProfile(
			input.scanJob,
			resolveStageAgentKindFromStageName(input.stageName),
			input.stageName,
		),
	containerName: (...parts) =>
		[
			sanitizeContainerNamePart(input.base.projectName),
			sanitizeContainerNamePart(input.base.serviceName),
			resolveStageContainerPrefix(input.stageName),
			sanitizeContainerNamePart(input.scanJob.scanJobId),
			input.persistent && input.laneIndex !== undefined && input.laneIndex !== null
				? `lane-${input.laneIndex}`
				: null,
			...(input.persistent
				? []
				: parts
						.filter((value): value is string => Boolean(value && value.trim()))
						.map((value) => sanitizeContainerNamePart(value))),
			input.persistent ? null : sanitizeContainerNamePart(input.taskId),
		]
			.filter((value): value is string => Boolean(value))
			.join("-"),
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
	taskDirContainer: async () => CONTAINER_TASK_RUNTIME_ROOT,
	laneDir: async () => {
		if (input.laneIndex === undefined || input.laneIndex === null) {
			return await (createStageContext({
				...input,
				persistent: false,
			}) as TBase & StageContext).taskDir();
		}
		await resolveScanContextMount(input.base);
		const laneDirPath = path.join(
			resolveMountedProfileDir(input.base),
			"jobs",
			input.scanJob.scanJobId,
			resolveStageLaneRootSegment(input.stageName, input.laneIndex),
		);
		await fs.mkdir(laneDirPath, { recursive: true });
		return laneDirPath;
	},
	laneDirContainer: async () => CONTAINER_TASK_RUNTIME_ROOT,
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
