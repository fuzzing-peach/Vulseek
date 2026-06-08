import { buildTaskAgentProfileSnapshot } from "../agent-profile-snapshot";
import { fuzzBuildResultSchema } from "../artifacts/contracts/domain-object.contract";
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
import type { CandidateAnalysisStageInput } from "./candidate-analysis.stage";
import {
	type PipelineContext,
	resolveStageConcurrencySetting,
	type StageContext,
} from "./full-scan-stage.runtime";

export type FuzzBuildStageInput = CandidateAnalysisStageInput & {
	buildRequestPath: string;
};

export type FuzzBuildStageOutput = unknown;

export const buildFuzzBuildPrompt = (
	input: FuzzBuildStageInput,
	paths: {
		candidate: Candidate;
		taskDirContainer: string;
		taskId: string;
	},
) =>
	renderPromptTemplate(new URL("./build-fuzzer.prompt.md", import.meta.url), {
		taskIsolation: NEVER_REUSE_TASK_PROMPT_LINES.join("\n"),
		candidateId: paths.candidate.id,
		candidateTitle: paths.candidate.title,
		candidateFile: paths.candidate.filePath || "-",
		candidateLine:
			typeof paths.candidate.line === "number" ? paths.candidate.line : "-",
		taskDir: paths.taskDirContainer,
		candidateJsonPath: input.candidatePath,
		buildRequestJsonPath: input.buildRequestPath,
		taskId: paths.taskId,
	});

const executeFuzzBuildStage = async (
	ctx: StageContext,
	stageInput: FuzzBuildStageInput,
) => {
	const agentProfile = await ctx.agentProfile();
	const taskStageDirPath = await ctx.taskDir();
	const taskStageRootInContainer = await ctx.taskDirContainer();
	const taskRealRootInContainer = await ctx.taskDirRealContainer();
	const stageDirPath = ctx.laneIndex !== null ? await ctx.laneDir() : taskStageDirPath;
	const stageRootInContainer = ctx.laneIndex !== null
		? await ctx.laneDirContainer()
		: taskRealRootInContainer;
	const candidate = await readTaskJsonArtifact<Candidate>({
		taskDir: taskStageDirPath,
		containerPath: stageInput.candidatePath,
	});
	const containerName = ctx.containerName(candidate.id.slice(0, 8));
	await bindTaskRuntimeRepo({
		taskId: ctx.taskId,
		containerName,
		containerIndex: ctx.containerIndex,
		agentProfile: buildTaskAgentProfileSnapshot(agentProfile).agentProfile,
	});
	await startContainer({
		scanJob: stageInput.scanJob,
		taskId: ctx.taskId,
		agentProfile,
		containerName,
		codexHome: `${stageRootInContainer}/.codex-fuzz-build`,
		stageDirPath,
		stageRootInContainer,
		taskRealRootInContainer,
		persistent: ctx.persistent,
		reuseContainer: ctx.reuseContainer,
	});

	return await runSingleTurnAgentInContainer({
		scanJob: stageInput.scanJob,
		agentProfile,
		containerName,
		codexHome: `${stageRootInContainer}/.codex-fuzz-build`,
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
		prompt: buildFuzzBuildPrompt(stageInput, {
			candidate,
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
	id: string;
	name: string;
	mode?: "serial" | "fanout";
	persistent?: boolean;
	reuseContainer?: boolean;
	queue?: StageQueueBinding<TPipelineContext, FuzzBuildStageInput>;
}): StageDefinition<
	TPipelineContext,
	FuzzBuildStageInput,
	FuzzBuildStageOutput,
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
			await resolveStageConcurrencySetting(
				ctx.scanJobId,
				input.id,
				(settings) => settings.analysisConcurrency,
			),
		run: async (ctx, stageInput) => ({
			completion: "deferred",
			threadId: (
				await executeFuzzBuildStage(ctx as unknown as StageContext, stageInput)
			).threadId,
		}),
	});
