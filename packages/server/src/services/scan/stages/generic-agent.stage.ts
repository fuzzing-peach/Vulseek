import { bindTaskRuntimeRepo } from "../persistence/task.repo";
import {
	syncVulnerabilityCandidatesFromProducerTask,
	type CandidateSyncTransaction,
} from "../persistence/candidate.repo";
import {
	createStageDefinition,
	type StageDefinition,
	type StageQueueBinding,
} from "../pipeline/stage-definition";
import type { StructuredOutputSchemaSource } from "../pipeline/scan-pipeline-schema-contracts";
import { renderPipelineTemplate } from "../pipeline/scan-pipeline-edge-transform";
import type { YamlPipelineStage } from "../pipeline/yaml-pipeline-runtime";
import { NEVER_REUSE_TASK_PROMPT_LINES } from "../prompts/task-isolation.prompt";
import {
	readTaskJsonArtifact,
	replaceTaskJsonArtifact,
	taskArtifactHostPath,
	writeTaskJsonArtifact,
} from "../artifacts/task-artifact-paths";
import { promises as fs } from "node:fs";
import {
	isJsonSchemaContract,
	validateJsonSchemaContractArtifacts,
	validateStructuredOutputSchemaSource,
} from "../pipeline/scan-pipeline-schema-contracts";
import { applySchemaTransforms } from "../pipeline/scan-pipeline-schema-transforms";
import { DEFAULT_DELTA_COMMIT_WINDOW } from "../constants";
import { getResearchMinimumDurationMs } from "../scan-type";
import { updateScanJobTargetContextRepo } from "../persistence/scan-job.repo";
import { findResearchTrackIdentityRepo } from "../persistence/research-track.repo";
import { prepareRepositoryForScanInContainer } from "../repository/prepare-repository";
import { runSingleTurnAgentInContainer } from "../runtime/run-single-turn-agent";
import {
	launchAgentStageRuntime,
	resolveAgentStageRuntime,
	resolveStageRuntimeCwd,
	resolveStageRuntimePrompt,
	resolveStageRuntimePromptTemplate,
} from "./agent-stage-runtime";
import { tryBuildTobGoalHuntNativePrompt } from "./tob-goal-native-prompt";
import {
	type PipelineContext,
	resolveStageConcurrencySetting,
	type StageContext,
} from "./full-scan-stage.runtime";
import type { ScanJob } from "../types";
import {
	assertResearchTrackIdentity,
	enrichResearchTrackInput,
} from "./research-track-input";

type GenericStageContext = StageContext & { scanJob?: ScanJob };

export const resolveStageReuseContainer = (
	scanType: ScanJob["scanType"] | "full_scan" | "delta_scan",
	configured: boolean,
) =>
	scanType === "research" || scanType === "tob-goal" ? false : configured;

export const resolveStageContainerNameParts = (
	scanType: ScanJob["scanType"] | "full_scan" | "delta_scan",
	taskId: string,
	configured: Array<string | null | undefined> | undefined,
) =>
	scanType === "research" || scanType === "tob-goal"
		? [...(configured || []), taskId]
		: configured;

const buildResearchTaskContext = (
	ctx: GenericStageContext,
	stageInput: unknown,
) => ({
	taskId: ctx.taskId,
	scanJobId: ctx.scanJobId,
	stageName: ctx.stageName,
	stageInput,
});

const toPromptValues = (value: unknown): Record<string, string | number> => {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return {};
	}
	return Object.fromEntries(
		Object.entries(value).flatMap(([key, item]) => {
			if (typeof item === "string" || typeof item === "number") {
				return [[key, item]];
			}
			if (item === null || item === undefined) return [[key, "-"]];
			return [[key, JSON.stringify(item)]];
		}),
	);
};

const resolvePromptValues = async (
	ctx: GenericStageContext,
	input: unknown,
	config: YamlPipelineStage,
) => {
	const taskDir = await ctx.taskDir();
	const taskDirContainer = await ctx.taskDirContainer();
	const agentProfile = await ctx.agentProfile();
	const templateContext = {
		...ctx,
		taskDir: taskDirContainer,
		taskDirHost: taskDir,
	};
	const rendered = await renderPipelineTemplate(
		{
			taskId: ctx.taskId,
			taskName: ctx.taskName,
			taskDir: taskDirContainer,
			taskDirHost: taskDir,
			scanJobId: ctx.scanJobId,
			taskIsolation: NEVER_REUSE_TASK_PROMPT_LINES.join("\n"),
			thinkingInstruction: agentProfile?.thinkingLevelEnabled
				? `use_reasoning_effort: ${agentProfile.thinkingLevel}`
				: "",
			...config.promptValues,
			...(ctx.stageName === "research-scope"
				? {
						researchDeadlineAt: new Date(
							Date.now() + getResearchMinimumDurationMs(),
						).toISOString(),
				}
				: {}),
		},
		{
			ctx: templateContext,
			stageInput: input,
			stageOutput: null,
			readJsonFile: async (containerPath) =>
				await readTaskJsonArtifact({ taskDir, containerPath }),
			allowedRoots: [taskDir],
		},
	);
	return toPromptValues(rendered);
};

export const createGenericAgentStageDefinition = <
	TPipelineContext extends PipelineContext & { scanJob?: ScanJob },
>(input: {
	config: YamlPipelineStage;
	outputSchema?: StructuredOutputSchemaSource;
	queue?: StageQueueBinding<TPipelineContext, unknown>;
}): StageDefinition<TPipelineContext, unknown, unknown, StageContext> =>
	createStageDefinition({
		id: input.config.id,
		name: input.config.name,
		mode: input.config.mode,
		persistent: input.config.runtime.persistent ?? undefined,
		reuseContainer: input.config.runtime.reuseContainer ?? undefined,
		nullableOutput: input.config.runtime.nullableOutput ?? undefined,
		allowAgentExit: input.config.allowAgentExit,
		outputSchema: input.outputSchema,
		queue: input.queue,
		getDesiredConcurrency: async (ctx) =>
			await resolveStageConcurrencySetting(
				ctx.scanJobId,
				input.config.id,
				() => input.config.concurrency,
			),
		launch: async (ctx) => {
			const stageCtx = ctx as GenericStageContext;
			const scanJob = stageCtx.scanJob;
			if (!scanJob) throw new Error("Generic stage requires scanJob context");
			const reuseContainer = resolveStageReuseContainer(
				scanJob.scanType,
				stageCtx.reuseContainer,
			);
			const containerNameParts = resolveStageContainerNameParts(
				scanJob.scanType,
				stageCtx.taskId,
				input.config.containerNameParts,
			);
			const runtime = await launchAgentStageRuntime({
				ctx: stageCtx,
				scanJob,
				containerNameParts,
				reuseContainer,
			});
			if (input.config.runtime.prepareRepository) {
				const repositoryState = await prepareRepositoryForScanInContainer({
					containerName: runtime.containerName,
						scanType: scanJob.scanType,
					targetRef: scanJob.targetRef,
					targetTag: scanJob.targetTag,
					commitSha: scanJob.commitSha,
					baseSha: scanJob.baseSha,
					commitWindow:
						scanJob.commitWindow || DEFAULT_DELTA_COMMIT_WINDOW,
					scanRootDir: runtime.taskStageRootInContainer,
				});
				await updateScanJobTargetContextRepo(scanJob.scanJobId, {
					targetRef: repositoryState.currentBranch || repositoryState.targetRef,
					targetTag:
						repositoryState.currentExactTag || repositoryState.targetTag,
					commitSha: repositoryState.resolvedTargetSha,
					baseSha: repositoryState.resolvedBaseSha,
					commitWindow: repositoryState.commitWindow,
				});
			}
		},
	run: async (ctx, stageInput) => {
			const stageCtx = ctx as GenericStageContext;
			const scanJob = stageCtx.scanJob;
			if (!scanJob) throw new Error("Generic stage requires scanJob context");
			let effectiveStageInput =
				scanJob.scanType === "research"
					? await enrichResearchTrackInput({
							stageName: stageCtx.stageName,
							stageInput,
							resolveTrack: (trackKey, approachFamily) =>
								findResearchTrackIdentityRepo({
									scanJobId: stageCtx.scanJobId,
									trackKey,
									approachFamily,
								}),
						})
					: stageInput;
			if (
				scanJob.scanType === "tob-goal" &&
				(stageCtx.stageName === "goal-craft" ||
					stageCtx.stageName === "goal-surface")
			) {
				const inputRecord =
					effectiveStageInput &&
					typeof effectiveStageInput === "object" &&
					!Array.isArray(effectiveStageInput)
						? (effectiveStageInput as Record<string, unknown>)
						: {};
				const threatDirection =
					inputRecord.threatDirection ??
					(scanJob.scanRuntimeSettings as { threatDirection?: unknown } | null)
						?.threatDirection;
				if (threatDirection && !inputRecord.threatDirection) {
					effectiveStageInput = {
						...inputRecord,
						threatDirection,
					};
				}
			}
			const containerNameParts = resolveStageContainerNameParts(
				scanJob.scanType,
				stageCtx.taskId,
				input.config.containerNameParts,
			);
			const runtime = await resolveAgentStageRuntime({
				ctx: stageCtx,
				containerNameParts,
			});
			await writeTaskJsonArtifact({
				taskDir: await stageCtx.taskDir(),
				relativePath: "inputs/task-input.json",
				value: effectiveStageInput,
			});
			if (scanJob.scanType === "research") {
				await replaceTaskJsonArtifact({
					taskDir: await stageCtx.taskDir(),
					containerPath: "/task/task-context.json",
					value: buildResearchTaskContext(stageCtx, effectiveStageInput),
				});
			}
			const promptTemplate = await resolveStageRuntimePromptTemplate(stageCtx);
			const promptValues = await resolvePromptValues(
				stageCtx,
				effectiveStageInput,
				input.config,
			);
			const renderedPrompt = await resolveStageRuntimePrompt(
				stageCtx,
				promptTemplate,
				promptValues,
			);
			// tob-goal hunt must activate Codex native /goal (thread_goals), not a plain prompt.
			const nativeHuntPrompt =
				scanJob.scanType === "tob-goal" && stageCtx.stageName === "goal-hunt"
					? tryBuildTobGoalHuntNativePrompt(effectiveStageInput)
					: null;
			const result = await runSingleTurnAgentInContainer({
				scanJob,
				agentProfile: runtime.agentProfile,
				containerName: runtime.containerName,
				codexHome: runtime.codexHome,
				stageDirPath: runtime.stageDirPath,
				stageRootInContainer: runtime.stageRootInContainer,
				taskId: stageCtx.taskId,
				taskStageDirPath: runtime.taskStageDirPath,
				taskStageRootInContainer: runtime.taskStageRootInContainer,
				taskRealRootInContainer: runtime.taskRealRootInContainer,
				persistent: stageCtx.persistent,
				reuseContainer: resolveStageReuseContainer(
					scanJob.scanType,
					stageCtx.reuseContainer,
				),
				groupedPersistent: stageCtx.groupedPersistent,
				allowAgentExit: input.config.allowAgentExit,
				includePolicy: Boolean(input.config.runtime?.includePolicy),
				laneThreadId: stageCtx.laneThreadId,
				laneDriverPid: stageCtx.laneDriverPid,
				cwd: await resolveStageRuntimeCwd(stageCtx),
				sessionMode: stageCtx.sessionMode,
				parentSessionId: stageCtx.parentSessionId,
				parentTaskId: stageCtx.parentTaskId,
				prompt: nativeHuntPrompt ?? renderedPrompt,
				outputSchema: input.outputSchema,
				routeOutputSchemas: stageCtx.routeOutputSchemas,
				onThreadId: async (threadId) => {
					await bindTaskRuntimeRepo({ taskId: stageCtx.taskId, threadId });
				},
			});
			return { completion: "deferred", threadId: result.threadId };
		},
		validateOutput: async (_ctx, _stageInput, rawOutput) => {
			try {
				const taskDir = await _ctx.taskDir();
				let output = JSON.parse(rawOutput) as unknown;
				const scanJob = (_ctx as GenericStageContext).scanJob;
				if (scanJob?.scanType === "research") {
					await assertResearchTrackIdentity({
						stageName: _ctx.stageName,
						stageInput: _stageInput,
						stageOutput: output,
						resolveTrack: (trackKey, approachFamily) =>
							findResearchTrackIdentityRepo({
								scanJobId: _ctx.scanJobId,
								trackKey,
								approachFamily,
							}),
					});
				}
				if (input.outputSchema && isJsonSchemaContract(input.outputSchema)) {
					output = await applySchemaTransforms({
						contract: input.outputSchema,
						taskDir,
						value: output,
					});
					validateStructuredOutputSchemaSource(input.outputSchema, output);
					await validateJsonSchemaContractArtifacts(
						input.outputSchema,
						output,
						async (containerPath) =>
							await readTaskJsonArtifact({ taskDir, containerPath }),
					);
				} else if (input.outputSchema) {
					validateStructuredOutputSchemaSource(input.outputSchema, output);
				}
				if (input.config.report) {
					const reportPath = taskArtifactHostPath({
						taskDir,
						containerPath: input.config.report.path,
					});
					const reportExists = await fs
						.stat(reportPath)
						.then(() => true)
						.catch(() => false);
					if (input.config.report.required && !reportExists) {
						throw new Error(`Required report is missing: ${input.config.report.path}`);
					}
				}
				return output;
			} catch (error) {
				throw new Error(
					`Generic stage returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		},
		onSuccess: async (ctx, stageInput, output, transaction) => {
			for (const effect of input.config.effects) {
				if (effect.type === "sync-candidates") {
					await syncVulnerabilityCandidatesFromProducerTask(
						ctx.taskId,
						transaction as CandidateSyncTransaction | undefined,
					);
				}
				if (effect.type === "tob-goal-registry") {
					const { applyTobGoalRegistryEffect } = await import(
						"../persistence/tob-goal-registry.repo"
					);
					await applyTobGoalRegistryEffect({
						scanJobId: ctx.scanJobId,
						taskId: ctx.taskId,
						operation: effect.operation,
						stageOutput: output,
						stageInput,
					});
				}
			}
		},
	});
