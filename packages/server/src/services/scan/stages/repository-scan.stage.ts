import { buildTaskAgentProfileSnapshot } from "../agent-profile-snapshot";
import {
	repositoryModuleSchema,
	repositoryScanManifestSchema,
	repositorySchema,
} from "../artifacts/contracts/domain-object.contract";
import { readTaskJsonArtifact } from "../artifacts/task-artifact-paths";
import { DEFAULT_DELTA_COMMIT_WINDOW } from "../constants";
import { updateScanJobTargetContextRepo } from "../persistence/scan-job.repo";
import { bindTaskRuntimeRepo } from "../persistence/task.repo";
import {
	createStageDefinition,
	type StageDefinition,
	type StageQueueBinding,
} from "../pipeline/stage-definition";
import { buildRepositoryScannerPrompt } from "../prompts/repository-scanner.prompt";
import { prepareRepositoryForScanInContainer } from "../repository/prepare-repository";
import {
	runSingleTurnAgentInContainer,
	startContainer,
} from "../runtime/run-single-turn-agent";
import type { RepositoryScanManifest, ScanJob } from "../types";
import {
	type PipelineContext,
	resolveStageConcurrencySetting,
	type StageContext,
} from "./full-scan-stage.runtime";

export type RepositoryScanningStageInput = null;

export type RepositoryScanningStageOutput = RepositoryScanManifest;

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
	const manifest = repositoryScanManifestSchema.parse(parsed);
	const taskDir = await ctx.taskDir();
	try {
		repositorySchema.parse(
			await readTaskJsonArtifact({
				taskDir,
				containerPath: manifest.repository,
			}),
		);
		for (const modulePath of manifest.modules) {
			repositoryModuleSchema.parse(
				await readTaskJsonArtifact({
					taskDir,
					containerPath: modulePath,
				}),
			);
		}
	} catch (error) {
		throw new Error(
			`Repository scan artifact validation failed: ${error instanceof Error ? error.message : "unknown error"}`,
		);
	}
	return manifest;
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
	const repository = {
		id: ctx.taskId,
		name: ctx.serviceName,
		summary: "",
		languages: [],
		buildSystems: [],
		runtimeDirectories: [],
		downrankedDirectories: [],
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
	const taskRealRootInContainer = await ctx.taskDirRealContainer();
	const stageDirPath =
		ctx.laneIndex !== null ? await ctx.laneDir() : taskStageDirPath;
	const stageRootInContainer =
		ctx.laneIndex !== null
			? await ctx.laneDirContainer()
			: taskRealRootInContainer;
	const repositoryRoot = taskStageRootInContainer;
	const containerName = ctx.containerName();

	await bindTaskRuntimeRepo({
		taskId: ctx.taskId,
		containerName,
		containerIndex: ctx.containerIndex,
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
		taskRealRootInContainer,
		persistent: ctx.persistent,
		reuseContainer: ctx.reuseContainer,
	});

	const repositoryState = await prepareRepositoryForScanInContainer({
		containerName,
		scanType: scanJob.scanType,
		targetRef: scanJob.targetRef,
		targetTag: scanJob.targetTag,
		commitSha: scanJob.commitSha,
		baseSha: scanJob.baseSha,
		commitWindow: scanJob.commitWindow || DEFAULT_DELTA_COMMIT_WINDOW,
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
		taskRealRootInContainer,
		persistent: ctx.persistent,
		reuseContainer: ctx.reuseContainer,
		groupedPersistent: ctx.groupedPersistent,
		allowAgentExit: ctx.allowAgentExit,
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
			thinkingLevel: scanAgentProfile?.thinkingLevelEnabled
				? scanAgentProfile.thinkingLevel
				: null,
		}),
		outputSchema: repositoryScanManifestSchema,
		onThreadId: async (threadId) => {
			await bindTaskRuntimeRepo({ taskId: ctx.taskId, threadId });
		},
	});
};

export const createRepositoryScanningStageDefinition = <
	TPipelineContext extends PipelineContext,
>(input: {
	id: string;
	name: string;
	mode?: "serial" | "fanout";
	persistent?: boolean;
	reuseContainer?: boolean;
	queue?: StageQueueBinding<TPipelineContext, RepositoryScanningStageInput>;
}): StageDefinition<
	TPipelineContext,
	RepositoryScanningStageInput,
	RepositoryScanningStageOutput,
	StageContext
> =>
	createStageDefinition({
		id: input.id,
		name: input.name,
		mode: input.mode || "serial",
		persistent: input.persistent,
		reuseContainer: input.reuseContainer,
		queue: input.queue,
		getDesiredConcurrency: async (ctx) =>
			await resolveStageConcurrencySetting(ctx.scanJobId, input.id, () => 1),
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
