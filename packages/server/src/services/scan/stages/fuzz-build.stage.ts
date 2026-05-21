import {
	fuzzBuildResultSchema,
	type BuildFuzzerRequest,
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
import { NEVER_REUSE_TASK_PROMPT_LINES } from "../prompts/task-isolation.prompt";
import type { CandidateAnalysisStageInput } from "./candidate-analysis.stage";
import {
	type PipelineContext,
	resolveStageConcurrencySetting,
	type StageContext,
} from "./full-scan-stage.runtime";

export type FuzzBuildStageInput = CandidateAnalysisStageInput & {
	buildRequest: BuildFuzzerRequest;
};

export type FuzzBuildStageOutput = unknown;

const buildFuzzBuildPrompt = (
	input: FuzzBuildStageInput,
	paths: {
		taskDirContainer: string;
		taskId: string;
	},
) =>
	[
		"You are the fuzzing-program build agent for one vulnerability candidate.",
		...NEVER_REUSE_TASK_PROMPT_LINES,
		"Use the installed skill named libafl-build as your working method.",
		`candidate_id: ${input.candidate.id}`,
		`candidate_title: ${input.candidate.title}`,
		`candidate_file: ${input.candidate.filePath || "-"}`,
		`candidate_line: ${typeof input.candidate.line === "number" ? input.candidate.line : "-"}`,
		`task_dir: ${paths.taskDirContainer}`,
		`build_request: ${JSON.stringify(input.buildRequest)}`,
		"",
		"Generate a per-candidate Rust LibAFL crate under task_dir.",
		"Build the executable fuzzer and keep all source, logs, and artifacts under task_dir.",
		"Set output.json route to the correct route key for the build result.",
		"Before returning, validate the structured JSON against the runtime-provided output.schema.json.",
		`Use ${paths.taskId} as id.`,
		"Route mapping:",
		"- Successful build -> run_fuzzer",
		"- Failed build -> analysis",
	].join("\n");

const executeFuzzBuildStage = async (
	ctx: StageContext,
	stageInput: FuzzBuildStageInput,
) => {
	const agentProfile = await ctx.agentProfile();
	const taskStageDirPath = await ctx.taskDir();
	const taskStageRootInContainer = await ctx.taskDirContainer();
	const stageDirPath = ctx.persistent ? await ctx.laneDir() : taskStageDirPath;
	const stageRootInContainer = ctx.persistent
		? await ctx.laneDirContainer()
		: taskStageRootInContainer;
	const containerName = ctx.containerName(stageInput.candidate.id.slice(0, 8));
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
		codexHome: `${stageRootInContainer}/.codex-fuzz-build`,
		stageDirPath,
		stageRootInContainer,
		persistent: ctx.persistent,
	});

	return await runSingleTurnAgentInContainer({
		scanJob: stageInput.candidate.scanJob,
		agentProfile,
		containerName,
		codexHome: `${stageRootInContainer}/.codex-fuzz-build`,
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
		prompt: buildFuzzBuildPrompt(stageInput, {
			taskDirContainer: taskStageRootInContainer,
			taskId: ctx.taskId,
		}),
		outputSchema: fuzzBuildResultSchema,
		routeOutputSchemas: ctx.routeOutputSchemas,
		onThreadId: async (threadId) => {
			await bindTaskRuntimeRepo({ taskId: ctx.taskId, threadId });
		},
	});
};

export const createFuzzBuildStageDefinition = <
	TPipelineContext extends PipelineContext,
>(input: {
	name?: string;
	mode?: "serial" | "fanout";
	persistent?: boolean;
	queue?: StageQueueBinding<TPipelineContext, FuzzBuildStageInput>;
}): StageDefinition<
	TPipelineContext,
	FuzzBuildStageInput,
	FuzzBuildStageOutput,
	StageContext
> =>
	createStageDefinition({
		name: input.name || "FuzzBuildStage",
		mode: input.mode || "fanout",
		persistent: input.persistent,
		queue: input.queue,
		getDesiredConcurrency: async (ctx) =>
			await resolveStageConcurrencySetting(
				ctx.scanJobId,
				"FuzzBuildStage",
				(settings) => settings.analysisConcurrency,
			),
		run: async (ctx, stageInput) => ({
			completion: "deferred",
			threadId: (
				await executeFuzzBuildStage(ctx as unknown as StageContext, stageInput)
			).threadId,
		}),
	});
