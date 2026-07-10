import {
	moduleThreatModelManifestSchema,
	moduleThreatModelSchema,
} from "../artifacts/contracts/domain-object.contract";
import {
	readTaskJsonArtifact,
	writeTaskJsonArtifact,
} from "../artifacts/task-artifact-paths";
import { bindTaskRuntimeRepo } from "../persistence/task.repo";
import {
	createStageDefinition,
	type StageDefinition,
	type StageQueueBinding,
} from "../pipeline/stage-definition";
import type { StructuredOutputSchemaSource } from "../pipeline/scan-pipeline-schema-contracts";
import { buildAttackSurfaceModelPrompt } from "../prompts/attack-surface-model.prompt";
import { NEVER_REUSE_TASK_PROMPT_LINES } from "../prompts/task-isolation.prompt";
import { runSingleTurnAgentInContainer } from "../runtime/run-single-turn-agent";
import type { ModuleThreatModelManifest, ScanJob } from "../types";
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
import { normalizeLikelyVulnerabilityClasses } from "./normalize-likely-vulnerability-classes";

export type AttackSurfaceModelStageInput = {
	scanJob: ScanJob;
	repositoryPath: string;
	modulePath: string;
	moduleId: string;
	moduleName: string;
	priority: number | null;
};

export type AttackSurfaceModelStageOutput = ModuleThreatModelManifest;

const validateAttackSurfaceModelOutput = async (
	ctx: StageContext,
	rawOutput: string,
) => {
	const manifest = moduleThreatModelManifestSchema.parse(JSON.parse(rawOutput));
	const taskDir = await ctx.taskDir();
	const threatModel = moduleThreatModelSchema.parse(
		await readTaskJsonArtifact({
			taskDir,
			containerPath: manifest.threatModel,
		}),
	);
	const normalizedClasses = normalizeLikelyVulnerabilityClasses(
		threatModel.likelyVulnerabilityClasses,
	);
	const previous = threatModel.likelyVulnerabilityClasses ?? [];
	const changed =
		previous.length !== normalizedClasses.length ||
		previous.some((value, index) => value !== normalizedClasses[index]);
	if (changed) {
		const relativePath = manifest.threatModel.replace(/^\/task\//, "");
		await writeTaskJsonArtifact({
			taskDir,
			relativePath,
			value: {
				...threatModel,
				likelyVulnerabilityClasses: normalizedClasses,
			},
		});
	}
	return manifest;
};

const executeAttackSurfaceModelStage = async (
	ctx: StageContext,
	stageInput: AttackSurfaceModelStageInput,
	outputSchema?: StructuredOutputSchemaSource,
) => {
	const runtime = await resolveAgentStageRuntime({
		ctx,
		containerNameParts: [stageInput.moduleId.slice(0, 24)],
	});
	const thinkingInstruction = runtime.agentProfile?.thinkingLevelEnabled
		? `use_reasoning_effort: ${runtime.agentProfile.thinkingLevel}`
		: "";
	const fallbackPrompt = buildAttackSurfaceModelPrompt({
		scanJobId: stageInput.scanJob.scanJobId,
		moduleId: stageInput.moduleId,
		moduleName: stageInput.moduleName,
		repositoryJsonPath: stageInput.repositoryPath,
		moduleJsonPath: stageInput.modulePath,
		thinkingLevel: runtime.agentProfile?.thinkingLevelEnabled
			? runtime.agentProfile.thinkingLevel
			: null,
	});

	return await runSingleTurnAgentInContainer({
		scanJob: stageInput.scanJob,
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
				scanJobId: stageInput.scanJob.scanJobId,
				moduleId: stageInput.moduleId,
				moduleName: stageInput.moduleName,
				repositoryJsonPath: stageInput.repositoryPath,
				moduleJsonPath: stageInput.modulePath,
				thinkingInstruction,
			}),
		outputSchema: outputSchema ?? moduleThreatModelManifestSchema,
		onThreadId: async (threadId) => {
			await bindTaskRuntimeRepo({ taskId: ctx.taskId, threadId });
		},
	});
};

export const createAttackSurfaceModelStageDefinition = <
	TPipelineContext extends PipelineContext & { executionContext?: unknown },
>(input: {
	id: string;
	name: string;
	mode?: "serial" | "fanout";
	persistent?: boolean;
	reuseContainer?: boolean;
	outputSchema?: StructuredOutputSchemaSource;
	queue?: StageQueueBinding<TPipelineContext, AttackSurfaceModelStageInput>;
}): StageDefinition<
	TPipelineContext,
	AttackSurfaceModelStageInput,
	AttackSurfaceModelStageOutput,
	StageContext
> =>
	createStageDefinition({
		id: input.id,
		name: input.name,
		mode: input.mode || "fanout",
		persistent: input.persistent,
		reuseContainer: input.reuseContainer,
		queue: input.queue,
		getDesiredConcurrency: async (ctx) =>
			await resolveStageConcurrencySetting(ctx.scanJobId, input.id, () => 4),
		launch: async (ctx, stageInput) => {
			await launchAgentStageRuntime({
				ctx: ctx as unknown as StageContext,
				scanJob: stageInput.scanJob,
				containerNameParts: [stageInput.moduleId.slice(0, 24)],
			});
		},
		run: async (ctx, stageInput) => {
			const result = await executeAttackSurfaceModelStage(
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
			await validateAttackSurfaceModelOutput(
				_ctx as unknown as StageContext,
				rawOutput,
			),
	});
