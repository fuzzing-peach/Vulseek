import { execAsync } from "../../../utils/process/execAsync";
import {
	repositoryModuleSchema,
	repositoryProfileManifestSchema,
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
import type { StructuredOutputSchemaSource } from "../pipeline/scan-pipeline-schema-contracts";
import { buildRepositoryProfilePrompt } from "../prompts/repository-profile.prompt";
import { NEVER_REUSE_TASK_PROMPT_LINES } from "../prompts/task-isolation.prompt";
import {
	prepareRepositoryForScanInContainer,
	type PreparedRepositoryState,
} from "../repository/prepare-repository";
import { runSingleTurnAgentInContainer } from "../runtime/run-single-turn-agent";
import type { RepositoryProfileManifest, ScanJob } from "../types";
import {
	launchAgentStageRuntime,
	resolveAgentStageRuntime,
	resolveStageRuntimeCwd,
	resolveStageRuntimePrompt,
} from "./agent-stage-runtime";
import {
	type PipelineContext,
	resolveStageConcurrencySetting,
	type StageContext,
} from "./full-scan-stage.runtime";

export type RepositoryProfileStageInput = null;

export type RepositoryProfileStageOutput = RepositoryProfileManifest;

const validateRepositoryStageOutput = async (
	ctx: StageContext,
	rawOutput: string,
): Promise<RepositoryProfileStageOutput> => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawOutput);
	} catch (error) {
		throw new Error(
			`Repository profile returned invalid JSON output: ${error instanceof Error ? error.message : "unknown error"}`,
		);
	}
	const manifest = repositoryProfileManifestSchema.parse(parsed);
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
			`Repository profile artifact validation failed: ${error instanceof Error ? error.message : "unknown error"}`,
		);
	}
	return manifest;
};

const executeRepositoryProfileStage = async (
	ctx: StageContext,
	_stageInput: RepositoryProfileStageInput,
	outputSchema?: StructuredOutputSchemaSource,
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
		const agentProvider = runtime.agentProfile?.provider || "codex";
		const agentInstruction = runtime.agentProfile?.thinkingLevelEnabled
			? `Use ${agentProvider} with reasoning effort around ${runtime.agentProfile.thinkingLevel}.`
			: `Use ${agentProvider}.`;
		const repositoryStateJson = await execAsync(
			`docker exec ${runtime.containerName} bash -lc "cat '${repositoryRoot}/00_repository_state.json'"`,
		);
	const repositoryState = JSON.parse(
		repositoryStateJson.stdout,
	) as PreparedRepositoryState;

	const fallbackPrompt = buildRepositoryProfilePrompt({
			repositoryRoot,
			repositoryState,
			repositoryStatePath: `${repositoryRoot}/00_repository_state.json`,
			repository,
			agentProvider,
			thinkingLevel: runtime.agentProfile?.thinkingLevelEnabled
				? runtime.agentProfile.thinkingLevel
				: null,
	});

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
		cwd: await resolveStageRuntimeCwd(ctx),
		sessionMode: ctx.sessionMode,
		parentSessionId: ctx.parentSessionId,
		parentTaskId: ctx.parentTaskId,
			prompt: await resolveStageRuntimePrompt(ctx, fallbackPrompt, {
				taskIsolation: NEVER_REUSE_TASK_PROMPT_LINES.join("\n"),
				repositoryId: repository.id,
				repositoryName: repository.name,
				targetRef:
					repositoryState.currentBranch ||
					repositoryState.targetRef ||
					"<none>",
				targetTag:
					repositoryState.currentExactTag ||
					repositoryState.targetTag ||
					"<none>",
				targetCommit: repositoryState.resolvedTargetSha,
				agentInstruction,
				repositoryStatePath: `${repositoryRoot}/00_repository_state.json`,
			}),
		outputSchema: outputSchema ?? repositoryProfileManifestSchema,
		onThreadId: async (threadId) => {
			await bindTaskRuntimeRepo({ taskId: ctx.taskId, threadId });
		},
	});
};

const launchRepositoryProfileStage = async (ctx: StageContext) => {
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

export const createRepositoryProfileStageDefinition = <
	TPipelineContext extends PipelineContext,
>(input: {
	id: string;
	name: string;
	mode?: "serial" | "fanout";
	persistent?: boolean;
	reuseContainer?: boolean;
	outputSchema?: StructuredOutputSchemaSource;
	queue?: StageQueueBinding<TPipelineContext, RepositoryProfileStageInput>;
}): StageDefinition<
	TPipelineContext,
	RepositoryProfileStageInput,
	RepositoryProfileStageOutput,
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
			await launchRepositoryProfileStage(ctx as unknown as StageContext);
		},
		run: async (ctx, stageInput) => {
			const result = await executeRepositoryProfileStage(
				ctx as unknown as StageContext,
				stageInput,
				input.outputSchema,
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
