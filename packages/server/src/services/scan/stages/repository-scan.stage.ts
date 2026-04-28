import path from "node:path";
import {
	validateRepositoryScanArtifacts,
} from "../artifacts/contracts/repository-scan.contract";
import type {
	Module,
	Repository,
	ScanJob,
} from "../types";
import { DEFAULT_DELTA_COMMIT_WINDOW } from "../constants";
import {
	type StageQueueBinding,
	type StageDefinition,
} from "../pipeline/stage-definition";
import {
	updateScanJobTargetContextRepo,
} from "../persistence/scan-job.repo";
import {
	updateScanRepositoryTaskRepo,
} from "../persistence/scan-repository-task.repo";
import {
	buildRepositoryScannerPrompt,
} from "../prompts/repository-scanner.prompt";
import {
	prepareRepositoryForScanInContainer,
} from "../repository/prepare-repository";
import {
	removeContainer,
	runSingleTurnAgentInContainer,
	startContainer,
} from "../runtime/run-single-turn-agent";
import {
	resolveRepositoryArtifactsDir,
	resolveRepositoryStageRuntime,
	resolveStageAgentProfile,
	type StageRuntimeTarget,
} from "./full-scan-stage.runtime";

export type RepositoryScanningStageInput = {
	taskId: string;
	scanJob: ScanJob;
	repository: Repository;
};

export type RepositoryScanningStageOutput = {
	taskId: string;
	modules: Module[];
};

type RepositoryStageContext = StageRuntimeTarget;

const resolveHostPathFromContainerPath = (input: RepositoryStageContext & {
	scanJobId: string;
	containerPath: string;
}) => {
	const mountedProfileDir = path.join(
		"/scan-context",
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
	const containerJobRoot = `/scan-context/jobs/${input.scanJobId}`;
	if (
		input.containerPath === containerJobRoot ||
		input.containerPath.startsWith(`${containerJobRoot}/`)
	) {
		const relativePath = path.posix.relative(
			containerJobRoot,
			input.containerPath,
		);
		return path.join(mountedProfileDir, "jobs", input.scanJobId, relativePath);
	}
	return input.containerPath;
};

const executeRepositoryScanStage = async (
	ctx: RepositoryStageContext,
	stageInput: RepositoryScanningStageInput,
) => {
	const scanAgentProfile = await resolveStageAgentProfile(
		stageInput.scanJob,
		"scan",
	);
	const runtime = await resolveRepositoryStageRuntime({
		scanJobId: stageInput.scanJob.scanJobId,
		projectName: ctx.projectName,
		serviceName: ctx.serviceName,
	});
	const containerName = [
		ctx.projectName
			.toLowerCase()
			.replace(/[^a-z0-9_.-]/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "") || "x",
		ctx.serviceName
			.toLowerCase()
			.replace(/[^a-z0-9_.-]/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "") || "x",
		"repository-scan",
		stageInput.scanJob.scanJobId
			.toLowerCase()
			.replace(/[^a-z0-9_.-]/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "") || "x",
	].join("-");

	await updateScanRepositoryTaskRepo(stageInput.taskId, { containerName });
	await startContainer({
		scanJob: stageInput.scanJob,
		agentProfile: scanAgentProfile,
		containerName,
		codexHome: `${runtime.runtimeRootInContainer}/.codex`,
		runtimeDirHost: runtime.runtimeDirHost,
		runtimeRootInContainer: runtime.runtimeRootInContainer,
	});

	try {
		const repositoryState = await prepareRepositoryForScanInContainer({
		containerName,
		scanType: stageInput.scanJob.scanType,
		targetRef: stageInput.scanJob.targetRef,
		targetTag: stageInput.scanJob.targetTag,
		commitSha: stageInput.scanJob.commitSha,
		baseSha: stageInput.scanJob.baseSha,
		commitWindow:
			stageInput.scanJob.commitWindow || DEFAULT_DELTA_COMMIT_WINDOW,
		scanRootDir: runtime.runtimeRootInContainer,
	});

		await updateScanJobTargetContextRepo(stageInput.scanJob.scanJobId, {
		targetRef: repositoryState.currentBranch || repositoryState.targetRef,
		targetTag: repositoryState.currentExactTag || repositoryState.targetTag,
		commitSha: repositoryState.resolvedTargetSha,
		baseSha: repositoryState.resolvedBaseSha,
		commitWindow: repositoryState.commitWindow,
	});

		return await runSingleTurnAgentInContainer({
		scanJob: stageInput.scanJob,
		agentProfile: scanAgentProfile,
		containerName,
		codexHome: `${runtime.runtimeRootInContainer}/.codex`,
		runtimeDirHost: runtime.runtimeDirHost,
		runtimeRootInContainer: runtime.runtimeRootInContainer,
		cwd: "/workspace/repo",
		prompt: buildRepositoryScannerPrompt({
			repositoryRoot: path.posix.join(
				"/scan-context",
				"jobs",
				stageInput.scanJob.scanJobId,
				"scanning",
				"full_scan",
				"repository",
			),
			modulesRoot: path.posix.join(
				"/scan-context",
				"jobs",
				stageInput.scanJob.scanJobId,
				"scanning",
				"full_scan",
				"modules",
			),
			repositoryState,
			agentProvider: scanAgentProfile?.provider || "codex",
			thinkingLevel: scanAgentProfile?.thinkingLevel || "medium",
		}),
		setupMarkdownPathInContainer: runtime.setupMarkdownPathInContainer,
		setupMarkdown: [
			"# Repository Scanner Setup",
			"",
			`- scan_job_id: ${stageInput.scanJob.scanJobId}`,
			`- scan_type: ${stageInput.scanJob.scanType}`,
			`- repository_id: ${stageInput.repository.id}`,
			`- repository_name: ${stageInput.repository.name}`,
			`- agent_profile: ${scanAgentProfile?.name || scanAgentProfile?.agentProfileId || "default"}`,
		].join("\n"),
		onThreadId: async (threadId) => {
			await updateScanRepositoryTaskRepo(stageInput.taskId, { threadId });
		},
		});
	} finally {
		await removeContainer(containerName);
	}
};

const validateRepositoryStageOutput = async (
	ctx: RepositoryStageContext,
	stageInput: RepositoryScanningStageInput,
): Promise<RepositoryScanningStageOutput> => {
	const repositoryArtifactDir = await resolveRepositoryArtifactsDir({
		scanJobId: stageInput.scanJob.scanJobId,
		projectName: ctx.projectName,
		serviceName: ctx.serviceName,
	});
	const artifacts = await validateRepositoryScanArtifacts(repositoryArtifactDir);
	const modules: Module[] = [];
	for (const moduleEntry of artifacts.repositoryScan.modules) {
		const hostArtifactDir = resolveHostPathFromContainerPath({
			projectName: ctx.projectName,
			serviceName: ctx.serviceName,
			scanJobId: stageInput.scanJob.scanJobId,
			containerPath: moduleEntry.artifactDir,
		});
		const pathListFile = resolveHostPathFromContainerPath({
			projectName: ctx.projectName,
			serviceName: ctx.serviceName,
			scanJobId: stageInput.scanJob.scanJobId,
			containerPath: moduleEntry.pathListFile,
		});
		modules.push({
			id: moduleEntry.moduleId,
			moduleId: moduleEntry.moduleId,
			name: moduleEntry.name,
			summary: "",
			artifactDir: hostArtifactDir,
			pathListFile,
			priority: moduleEntry.priority,
			importantFiles: [],
			entryPoints: [],
			trustBoundaries: [],
			attackSurfaces: [],
			vulnerabilityThemes: [],
			notes: [],
		});
	}
	return {
		taskId: stageInput.taskId,
		modules,
	};
};

export const createRepositoryScanningStageDefinition = <
	TContext extends RepositoryStageContext,
>(input: {
	name?: string;
	mode?: "serial" | "fanout";
	queue?: StageQueueBinding<TContext, RepositoryScanningStageInput>;
}): StageDefinition<
	TContext,
	RepositoryScanningStageInput,
	RepositoryScanningStageOutput
> => ({
	name: input.name || "RepositoryScanningStage",
	mode: input.mode || "serial",
	queue: input.queue,
	run: async (ctx, stageInput) => {
		const result = await executeRepositoryScanStage(ctx, stageInput);
		return result.rawOutput;
	},
	validateOutput: async (ctx, stageInput) =>
		await validateRepositoryStageOutput(ctx, stageInput),
});
