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
import { runSingleTurnAgentInContainer } from "../runtime/run-single-turn-agent";
import type { Candidate } from "../types";
import {
	launchAgentStageRuntime,
	resolveAgentStageRuntime,
} from "./agent-stage-runtime";
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
	const taskStageDirPath = await ctx.taskDir();
	const candidate = await readTaskJsonArtifact<Candidate>({
		taskDir: taskStageDirPath,
		containerPath: stageInput.candidatePath,
	});
	const runtime = await resolveAgentStageRuntime({
		ctx,
		containerNameParts: [candidate.id.slice(0, 8)],
		codexHomeName: ".codex-fuzz-run",
	});
	const fuzzingBudgetSeconds =
		(await resolveScanProfileConcurrencySettings(ctx.scanJobId))
			.fuzzingBudgetSeconds || DEFAULT_FUZZING_BUDGET_SECONDS;

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
		cwd: "/workspace/repo",
		sessionMode: ctx.sessionMode,
		parentSessionId: ctx.parentSessionId,
		parentTaskId: ctx.parentTaskId,
		prompt: buildFuzzRunPrompt(stageInput, {
			candidate,
			taskDirContainer: runtime.taskStageRootInContainer,
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
	reuseContainer?: boolean;
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
		reuseContainer: input.reuseContainer,
		queue: input.queue,
		getDesiredConcurrency: async (ctx) =>
			await resolveStageConcurrencySetting(ctx.scanJobId, input.id, () => 2),
		launch: async (ctx, stageInput) => {
			const stageCtx = ctx as unknown as StageContext;
			const candidate = await readTaskJsonArtifact<Candidate>({
				taskDir: await stageCtx.taskDir(),
				containerPath: stageInput.candidatePath,
			});
			await launchAgentStageRuntime({
				ctx: stageCtx,
				scanJob: stageInput.scanJob,
				containerNameParts: [candidate.id.slice(0, 8)],
				codexHomeName: ".codex-fuzz-run",
			});
		},
		run: async (ctx, stageInput) => ({
			completion: "deferred",
			threadId: (
				await executeFuzzRunStage(ctx as unknown as StageContext, stageInput)
			).threadId,
		}),
	});
