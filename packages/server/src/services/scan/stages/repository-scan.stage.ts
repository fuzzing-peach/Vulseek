import { z } from "zod";
import {
	moduleSchema,
	repositorySchema,
} from "../artifacts/contracts/domain-object.contract";
import type {
	Module,
	Repository,
	ScanJob,
} from "../types";
import { DEFAULT_DELTA_COMMIT_WINDOW } from "../constants";
import {
	createStageDefinition,
	type StageQueueBinding,
	type StageDefinition,
} from "../pipeline/stage-definition";
import {
	updateScanJobTargetContextRepo,
} from "../persistence/scan-job.repo";
import {
	buildRepositoryScannerPrompt,
} from "../prompts/repository-scanner.prompt";
import { buildTaskAgentProfileSnapshot } from "../agent-profile-snapshot";
import { bindTaskRuntimeRepo } from "../persistence/task.repo";
import {
	prepareRepositoryForScanInContainer,
} from "../repository/prepare-repository";
import {
	runSingleTurnAgentInContainer,
	startContainer,
} from "../runtime/run-single-turn-agent";
import {
	type PipelineContext,
	resolveStageConcurrencySetting,
	type StageContext,
} from "./full-scan-stage.runtime";

export type RepositoryScanningStageInput = null;

export type RepositoryScanningStageOutput = {
	repository: Repository;
	modules: Module[];
};

const repositoryScanSchema = z.object({
	repository: repositorySchema,
	modules: z.array(moduleSchema),
});

const validateRepositoryStageOutput = async (
	ctx: StageContext,
	rawOutput: string,
): Promise<RepositoryScanningStageOutput> => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawOutput);
	} catch (error) {
		throw new Error(
			`Repository scan returned invalid JSON output: ${error instanceof Error ? error.message : "unknown error"}`,
		);
	}
	const repositoryScan = repositoryScanSchema.parse(parsed);
	return {
		repository: repositoryScan.repository,
		modules: repositoryScan.modules,
	};
};

const executeRepositoryScanStage = async (
	ctx: StageContext,
	_stageInput: RepositoryScanningStageInput,
) => {
	const pipelineScanJob = (ctx as StageContext & { scanJob?: ScanJob }).scanJob;
	if (!pipelineScanJob) {
		throw new Error("Repository stage requires scanJob in pipeline context");
	}
	const scanJob = pipelineScanJob;
	const repository: Repository = {
		id: ctx.taskId,
		name: ctx.serviceName,
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
	};
	const scanAgentProfile = await ctx.agentProfile();
	const taskStageDirPath = await ctx.taskDir();
	const taskStageRootInContainer = await ctx.taskDirContainer();
	const stageDirPath = ctx.persistent ? await ctx.laneDir() : taskStageDirPath;
	const stageRootInContainer = ctx.persistent
		? await ctx.laneDirContainer()
		: taskStageRootInContainer;
	const repositoryRoot = taskStageRootInContainer;
	const containerName = ctx.containerName();

	await bindTaskRuntimeRepo({
		taskId: ctx.taskId,
		containerName,
		agentProfile: buildTaskAgentProfileSnapshot(scanAgentProfile).agentProfile,
	});
	await startContainer({
		scanJob,
		taskId: ctx.taskId,
		agentProfile: scanAgentProfile,
		containerName,
		codexHome: `${stageRootInContainer}/.codex`,
		stageDirPath,
		stageRootInContainer,
		persistent: ctx.persistent,
	});

	const repositoryState = await prepareRepositoryForScanInContainer({
		containerName,
		scanType: scanJob.scanType,
		targetRef: scanJob.targetRef,
		targetTag: scanJob.targetTag,
		commitSha: scanJob.commitSha,
		baseSha: scanJob.baseSha,
		commitWindow:
			scanJob.commitWindow || DEFAULT_DELTA_COMMIT_WINDOW,
		scanRootDir: taskStageRootInContainer,
	});

	await updateScanJobTargetContextRepo(scanJob.scanJobId, {
		targetRef: repositoryState.currentBranch || repositoryState.targetRef,
		targetTag: repositoryState.currentExactTag || repositoryState.targetTag,
		commitSha: repositoryState.resolvedTargetSha,
		baseSha: repositoryState.resolvedBaseSha,
		commitWindow: repositoryState.commitWindow,
	});

	return await runSingleTurnAgentInContainer({
		scanJob,
		agentProfile: scanAgentProfile,
		containerName,
		codexHome: `${stageRootInContainer}/.codex`,
		stageDirPath,
		stageRootInContainer,
		taskId: ctx.taskId,
		taskStageDirPath,
		taskStageRootInContainer,
		persistent: ctx.persistent,
		laneThreadId: ctx.laneThreadId,
		cwd: "/workspace/repo",
		sessionMode: ctx.sessionMode,
		parentSessionId: ctx.parentSessionId,
		parentTaskId: ctx.parentTaskId,
		prompt: buildRepositoryScannerPrompt({
			repositoryRoot,
			repositoryState,
			repositoryStatePath: `${repositoryRoot}/00_repository_state.json`,
			repository,
			agentProvider: scanAgentProfile?.provider || "codex",
			thinkingLevel: scanAgentProfile?.thinkingLevel || "medium",
		}),
		outputSchema: repositoryScanSchema,
		onThreadId: async (threadId) => {
			await bindTaskRuntimeRepo({ taskId: ctx.taskId, threadId });
		},
	});
};

export const createRepositoryScanningStageDefinition = <
	TPipelineContext extends PipelineContext,
>(input: {
	name?: string;
	mode?: "serial" | "fanout";
	persistent?: boolean;
	queue?: StageQueueBinding<TPipelineContext, RepositoryScanningStageInput>;
}): StageDefinition<
	TPipelineContext,
	RepositoryScanningStageInput,
	RepositoryScanningStageOutput,
	StageContext
> =>
	createStageDefinition({
		name: input.name || "RepositoryScanningStage",
		mode: input.mode || "serial",
		persistent: input.persistent,
		queue: input.queue,
		getDesiredConcurrency: async (ctx) =>
			await resolveStageConcurrencySetting(
				ctx.scanJobId,
				"RepositoryScanningStage",
				() => 1,
			),
		run: async (ctx, stageInput) => {
			const result = await executeRepositoryScanStage(
				ctx as unknown as StageContext,
				stageInput,
			);
			return {
				completion: "deferred",
				threadId: result.threadId,
			};
		},
		validateOutput: async (_ctx, _stageInput, rawOutput) =>
			await validateRepositoryStageOutput(
				_ctx as unknown as StageContext,
				rawOutput,
			),
	});
