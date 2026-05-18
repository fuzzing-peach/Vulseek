import {
	fuzzRunResultSchema,
	type FuzzBuildResult,
} from "../artifacts/contracts/domain-object.contract";
import { buildTaskAgentProfileSnapshot } from "../agent-profile-snapshot";
import { bindTaskRuntimeRepo } from "../persistence/task.repo";
import {
	createStageDefinition,
	type StageDefinition,
	type StageQueueBinding,
} from "../pipeline/stage-definition";
import {
	runSingleTurnAgentInContainer,
	startContainer,
} from "../runtime/run-single-turn-agent";
import type { FuzzBuildStageInput } from "./fuzz-build.stage";
import {
	type PipelineContext,
	resolveScanProfileConcurrencySettings,
	resolveStageConcurrencySetting,
	type StageContext,
} from "./full-scan-stage.runtime";

export type FuzzRunStageInput = FuzzBuildStageInput & {
	buildResult: FuzzBuildResult;
};

export type FuzzRunStageOutput = unknown;

const DEFAULT_FUZZING_BUDGET_SECONDS = 600;

const buildFuzzRunPrompt = (
	input: FuzzRunStageInput,
	paths: {
		taskDirContainer: string;
		taskId: string;
		fuzzingBudgetSeconds: number;
	},
) =>
	[
		"You are the fuzzing execution agent for one vulnerability candidate.",
		"Use the installed skill named libafl-fuzz as your working method.",
		`candidate_id: ${input.candidate.id}`,
		`candidate_title: ${input.candidate.title}`,
		`task_dir: ${paths.taskDirContainer}`,
		`fuzzing_budget_seconds: ${paths.fuzzingBudgetSeconds}`,
		`build_result: ${JSON.stringify(input.buildResult)}`,
		"",
		"Run the LibAFL executable within the budget.",
		"Save corpus, crashes, triggering inputs, and logs under task_dir.",
		"Before returning, validate the structured JSON against the runtime-provided output.schema.json.",
		`Use ${paths.taskId} as id.`,
		"Always route back to analysis.",
	].join("\n");

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
	const containerName = ctx.containerName(stageInput.candidate.id.slice(0, 8));
	const fuzzingBudgetSeconds =
		(await resolveScanProfileConcurrencySettings(ctx.scanJobId))
			.fuzzingBudgetSeconds || DEFAULT_FUZZING_BUDGET_SECONDS;
	await bindTaskRuntimeRepo({
		taskId: ctx.taskId,
		containerName,
		agentProfile: buildTaskAgentProfileSnapshot(agentProfile).agentProfile,
	});
	await startContainer({
		scanJob: stageInput.candidate.scanJob,
		taskId: ctx.taskId,
		agentProfile,
		containerName,
		codexHome: `${stageRootInContainer}/.codex-fuzz-run`,
		stageDirPath,
		stageRootInContainer,
		persistent: ctx.persistent,
	});

	return await runSingleTurnAgentInContainer({
		scanJob: stageInput.candidate.scanJob,
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
	name?: string;
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
		name: input.name || "FuzzRunStage",
		mode: input.mode || "fanout",
		persistent: input.persistent,
		queue: input.queue,
		getDesiredConcurrency: async (ctx) =>
			await resolveStageConcurrencySetting(
				ctx.scanJobId,
				"FuzzRunStage",
				(settings) => settings.analysisConcurrency,
			),
		run: async (ctx, stageInput) => ({
			completion: "deferred",
			threadId: (
				await executeFuzzRunStage(ctx as unknown as StageContext, stageInput)
			).threadId,
		}),
	});
