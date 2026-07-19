import { scanTargetManifestSchema } from "../artifacts/contracts/domain-object.contract";
import { bindTaskRuntimeRepo } from "../persistence/task.repo";
import {
	createStageDefinition,
	type StageDefinition,
	type StageQueueBinding,
} from "../pipeline/stage-definition";
import type { StructuredOutputSchemaSource } from "../pipeline/scan-pipeline-schema-contracts";
import { NEVER_REUSE_TASK_PROMPT_LINES } from "../prompts/task-isolation.prompt";
import { runSingleTurnAgentInContainer } from "../runtime/run-single-turn-agent";
import type { ScanJob, ScanTargetManifest } from "../types";
import {
	launchAgentStageRuntime,
	resolveAgentStageRuntime,
	resolveStageRuntimeCwd,
	resolveStageRuntimePrompt,
	resolveStageRuntimePromptTemplate,
} from "./agent-stage-runtime";
import { rewriteCandidateManifestIds } from "./candidate-manifest-normalizer";
import {
	type PipelineContext,
	resolveStageConcurrencySetting,
	type StageContext,
} from "./full-scan-stage.runtime";
import { slugVulnerabilityClassFocus } from "./normalize-likely-vulnerability-classes";

export type ScanTargetStageInput = {
	scanJob: ScanJob;
	repositoryPath: string;
	modulePath: string;
	threatModelPath: string;
	targetPath: string;
	moduleId: string;
	moduleName: string;
	targetId: string;
	targetName: string;
	targetKind: string;
	filePath?: string | null;
	line?: number | null;
	summary?: string | null;
	priority: number | null;
	vulnerabilityClassFocus: string;
};

export type ScanTargetStageOutput = ScanTargetManifest;

const executeScanTargetStage = async (
	ctx: StageContext,
	stageInput: ScanTargetStageInput,
	outputSchema?: StructuredOutputSchemaSource,
) => {
	const focusSlug = slugVulnerabilityClassFocus(
		stageInput.vulnerabilityClassFocus,
	);
	const runtime = await resolveAgentStageRuntime({
		ctx,
		containerNameParts: [stageInput.targetId.slice(0, 16), focusSlug],
	});
	const thinkingInstruction = runtime.agentProfile?.thinkingLevelEnabled
		? `use_reasoning_effort: ${runtime.agentProfile.thinkingLevel}`
		: "";
	const promptTemplate = await resolveStageRuntimePromptTemplate(ctx);

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
		nullableOutput: ctx.nullableOutput,
		groupedPersistent: ctx.groupedPersistent,
		allowAgentExit: ctx.allowAgentExit,
		laneThreadId: ctx.laneThreadId,
		cwd: await resolveStageRuntimeCwd(ctx),
		sessionMode: ctx.sessionMode,
		parentSessionId: ctx.parentSessionId,
		parentTaskId: ctx.parentTaskId,
		prompt: await resolveStageRuntimePrompt(ctx, promptTemplate, {
				taskIsolation: NEVER_REUSE_TASK_PROMPT_LINES.join("\n"),
				scanJobId: stageInput.scanJob.scanJobId,
				moduleId: stageInput.moduleId,
				moduleName: stageInput.moduleName,
				targetId: stageInput.targetId,
				targetName: stageInput.targetName,
				targetKind: stageInput.targetKind,
				vulnerabilityClassFocus: stageInput.vulnerabilityClassFocus,
				targetFile: stageInput.filePath || "-",
				targetLine: stageInput.line ?? "-",
				targetSummary: stageInput.summary || "-",
				repositoryJsonPath: stageInput.repositoryPath,
				moduleJsonPath: stageInput.modulePath,
				threatModelJsonPath: stageInput.threatModelPath,
				targetJsonPath: stageInput.targetPath,
				thinkingInstruction,
			}),
		outputSchema: outputSchema ?? scanTargetManifestSchema,
		onThreadId: async (threadId) => {
			await bindTaskRuntimeRepo({ taskId: ctx.taskId, threadId });
		},
	});
};

export const createScanTargetStageDefinition = <
	TPipelineContext extends PipelineContext & { executionContext?: unknown },
>(input: {
	id: string;
	name: string;
	mode?: "serial" | "fanout";
	persistent?: boolean;
	reuseContainer?: boolean;
	outputSchema?: StructuredOutputSchemaSource;
	queue?: StageQueueBinding<TPipelineContext, ScanTargetStageInput>;
}): StageDefinition<
	TPipelineContext,
	ScanTargetStageInput,
	ScanTargetStageOutput | null,
	StageContext
> =>
	createStageDefinition({
		id: input.id,
		name: input.name,
		mode: input.mode || "fanout",
		persistent: input.persistent,
		reuseContainer: input.reuseContainer,
		nullableOutput: true,
		queue: input.queue,
		getDesiredConcurrency: async (ctx) =>
			await resolveStageConcurrencySetting(ctx.scanJobId, input.id, () => 4),
		launch: async (ctx, stageInput) => {
			await launchAgentStageRuntime({
				ctx: ctx as unknown as StageContext,
				scanJob: stageInput.scanJob,
				containerNameParts: [
					stageInput.targetId.slice(0, 16),
					slugVulnerabilityClassFocus(stageInput.vulnerabilityClassFocus),
				],
			});
		},
		run: async (ctx, stageInput) => {
			const result = await executeScanTargetStage(
				ctx as unknown as StageContext,
				stageInput,
				input.outputSchema,
			);
			return {
				completion: "deferred",
				threadId: result.threadId,
			};
		},
		validateOutput: async (ctx, _stageInput, rawOutput) => {
			const manifest = scanTargetManifestSchema.parse(JSON.parse(rawOutput));
			const rewritten = await rewriteCandidateManifestIds({
				taskDir: await (ctx as unknown as StageContext).taskDir(),
				manifest,
			});
			return scanTargetManifestSchema.parse(
				rewritten.manifest,
			) as ScanTargetStageOutput | null;
		},
	});
