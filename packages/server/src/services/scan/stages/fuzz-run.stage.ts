import { buildTaskAgentProfileSnapshot } from "../agent-profile-snapshot";
import { fuzzRunResultSchema } from "../artifacts/contracts/domain-object.contract";
import { readTaskJsonArtifact } from "../artifacts/task-artifact-paths";
import { bindTaskRuntimeRepo } from "../persistence/task.repo";
import {
	createStageDefinition,
	type StageDefinition,
	type StageQueueBinding,
} from "../pipeline/stage-definition";
import { renderPromptTemplate } from "../prompts/prompt-template";
import { NEVER_REUSE_TASK_PROMPT_LINES } from "../prompts/task-isolation.prompt";
import {
	runSingleTurnAgentInContainer,
	startContainer,
} from "../runtime/run-single-turn-agent";
import type { Candidate } from "../types";
import {
	type PipelineContext,
	resolveScanProfileConcurrencySettings,
	resolveStageConcurrencySetting,
	type StageContext,
} from "./full-scan-stage.runtime";
import type { FuzzBuildStageInput } from "./fuzz-build.stage";

export type FuzzRunStageInput = FuzzBuildStageInput & {
	buildResultPath: string;
};

export type FuzzRunStageOutput = unknown;

const DEFAULT_FUZZING_BUDGET_SECONDS = 600;

export const buildFuzzRunPrompt = (
	input: FuzzRunStageInput,
	paths: {
		candidate: Candidate;
		taskDirContainer: string;
		taskId: string;
		fuzzingBudgetSeconds: number;
	},
) =>
	renderPromptTemplate(new URL("./run-fuzzer.prompt.md", import.meta.url), {
		taskIsolation: NEVER_REUSE_TASK_PROMPT_LINES.join("\n"),
		candidateId: paths.candidate.id,
		candidateTitle: paths.candidate.title,
		taskDir: paths.taskDirContainer,
		fuzzingBudgetSeconds: paths.fuzzingBudgetSeconds,
		candidateJsonPath: input.candidatePath,
		buildRequestJsonPath: input.buildRequestPath,
		buildResultJsonPath: input.buildResultPath,
		taskId: paths.taskId,
	});

const executeFuzzRunStage = async (
	ctx: StageContext,
	stageInput: FuzzRunStageInput,
) => {
	const agentProfile = await ctx.agentProfile();
	const taskStageDirPath = await ctx.taskDir();
	const taskStageRootInContainer = await ctx.taskDirContainer();
	const stageDirPath = ctx.persistent ? await ctx.laneDir() : taskStageDirPath;
	const stageRootInContainer = ctx.persistent
		? await ctx.laneDirContainer()
		: taskStageRootInContainer;
	const candidate = await readTaskJsonArtifact<Candidate>({
		taskDir: taskStageDirPath,
		containerPath: stageInput.candidatePath,
	});
	const containerName = ctx.containerName(candidate.id.slice(0, 8));
	const fuzzingBudgetSeconds =
		(await resolveScanProfileConcurrencySettings(ctx.scanJobId))
			.fuzzingBudgetSeconds || DEFAULT_FUZZING_BUDGET_SECONDS;
	await bindTaskRuntimeRepo({
		taskId: ctx.taskId,
		containerName,
		agentProfile: buildTaskAgentProfileSnapshot(agentProfile).agentProfile,
	});
	await startContainer({
		scanJob: stageInput.scanJob,
		taskId: ctx.taskId,
		agentProfile,
		containerName,
		codexHome: `${stageRootInContainer}/.codex-fuzz-run`,
		stageDirPath,
		stageRootInContainer,
		persistent: ctx.persistent,
	});

	return await runSingleTurnAgentInContainer({
		scanJob: stageInput.scanJob,
		agentProfile,
		containerName,
		codexHome: `${stageRootInContainer}/.codex-fuzz-run`,
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
		prompt: buildFuzzRunPrompt(stageInput, {
			candidate,
			taskDirContainer: taskStageRootInContainer,
			taskId: ctx.taskId,
			fuzzingBudgetSeconds,
		}),
		outputSchema: fuzzRunResultSchema,
		routeOutputSchemas: ctx.routeOutputSchemas,
		onThreadId: async (threadId) => {
			await bindTaskRuntimeRepo({ taskId: ctx.taskId, threadId });
		},
	});
};

export const createFuzzRunStageDefinition = <
	TPipelineContext extends PipelineContext,
>(input: {
	id: string;
	name: string;
	mode?: "serial" | "fanout";
	persistent?: boolean;
	queue?: StageQueueBinding<TPipelineContext, FuzzRunStageInput>;
}): StageDefinition<
	TPipelineContext,
	FuzzRunStageInput,
	FuzzRunStageOutput,
	StageContext
> =>
	createStageDefinition({
		id: input.id,
		name: input.name,
		mode: input.mode || "fanout",
		persistent: input.persistent,
		queue: input.queue,
		getDesiredConcurrency: async (ctx) =>
			await resolveStageConcurrencySetting(
				ctx.scanJobId,
				input.id,
				(settings) => settings.analysisConcurrency,
			),
		run: async (ctx, stageInput) => ({
			completion: "deferred",
			threadId: (
				await executeFuzzRunStage(ctx as unknown as StageContext, stageInput)
			).threadId,
		}),
	});
