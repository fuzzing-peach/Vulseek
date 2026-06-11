import { execAsync } from "../../../utils/process/execAsync";
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
import {
	prepareRepositoryForScanInContainer,
	type PreparedRepositoryState,
} from "../repository/prepare-repository";
import { runSingleTurnAgentInContainer } from "../runtime/run-single-turn-agent";
import type { RepositoryScanManifest, ScanJob } from "../types";
import {
	launchAgentStageRuntime,
	resolveAgentStageRuntime,
} from "./agent-stage-runtime";
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
	const runtime = await resolveAgentStageRuntime({ ctx });
	const repositoryRoot = runtime.taskStageRootInContainer;
	const repositoryStateJson = await execAsync(
		`docker exec ${runtime.containerName} bash -lc "cat '${repositoryRoot}/00_repository_state.json'"`,
	);
	const repositoryState = JSON.parse(
		repositoryStateJson.stdout,
	) as PreparedRepositoryState;

	return await runSingleTurnAgentInContainer({
		scanJob,
		agentProfile: runtime.agentProfile,
		containerName: runtime.containerName,
		codexHome: runtime.codexHome,
		stageDirPath: runtime.stageDirPath,
		stageRootInContainer: runtime.stageRootInContainer,
		taskId: ctx.taskId,
		taskStageDirPath: runtime.taskStageDirPath,
		taskStageRootInContainer: runtime.taskStageRootInContainer,
		taskRealRootInContainer: runtime.taskRealRootInContainer,
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
			agentProvider: runtime.agentProfile?.provider || "codex",
			thinkingLevel: runtime.agentProfile?.thinkingLevelEnabled
				? runtime.agentProfile.thinkingLevel
				: null,
		}),
		outputSchema: repositoryScanManifestSchema,
		onThreadId: async (threadId) => {
			await bindTaskRuntimeRepo({ taskId: ctx.taskId, threadId });
		},
	});
};

const launchRepositoryScanStage = async (ctx: StageContext) => {
	const pipelineScanJob = (ctx as StageContext & { scanJob?: ScanJob }).scanJob;
	if (!pipelineScanJob) {
		throw new Error("Repository stage requires scanJob in pipeline context");
	}
	const scanJob = pipelineScanJob;
	const runtime = await launchAgentStageRuntime({ ctx, scanJob });
	const repositoryState = await prepareRepositoryForScanInContainer({
		containerName: runtime.containerName,
		scanType: scanJob.scanType,
		targetRef: scanJob.targetRef,
		targetTag: scanJob.targetTag,
		commitSha: scanJob.commitSha,
		baseSha: scanJob.baseSha,
		commitWindow: scanJob.commitWindow || DEFAULT_DELTA_COMMIT_WINDOW,
		scanRootDir: runtime.taskStageRootInContainer,
	});

	await updateScanJobTargetContextRepo(scanJob.scanJobId, {
		targetRef: repositoryState.currentBranch || repositoryState.targetRef,
		targetTag: repositoryState.currentExactTag || repositoryState.targetTag,
		commitSha: repositoryState.resolvedTargetSha,
		baseSha: repositoryState.resolvedBaseSha,
		commitWindow: repositoryState.commitWindow,
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
		launch: async (ctx) => {
			await launchRepositoryScanStage(ctx as unknown as StageContext);
		},
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
