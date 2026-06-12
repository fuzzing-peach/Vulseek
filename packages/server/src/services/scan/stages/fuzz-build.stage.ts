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
import { runSingleTurnAgentInContainer } from "../runtime/run-single-turn-agent";
import type { Candidate } from "../types";
import {
	launchAgentStageRuntime,
	resolveAgentStageRuntime,
} from "./agent-stage-runtime";
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
	const taskStageDirPath = await ctx.taskDir();
	const candidate = await readTaskJsonArtifact<Candidate>({
		taskDir: taskStageDirPath,
		containerPath: stageInput.candidatePath,
	});
	const runtime = await resolveAgentStageRuntime({
		ctx,
		containerNameParts: [candidate.id.slice(0, 8)],
		codexHomeName: ".codex-fuzz-build",
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
		cwd: "/workspace/repo",
		sessionMode: ctx.sessionMode,
		parentSessionId: ctx.parentSessionId,
		parentTaskId: ctx.parentTaskId,
		prompt: buildFuzzBuildPrompt(stageInput, {
			candidate,
			taskDirContainer: runtime.taskStageRootInContainer,
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
				codexHomeName: ".codex-fuzz-build",
			});
		},
		run: async (ctx, stageInput) => ({
			completion: "deferred",
			threadId: (
				await executeFuzzBuildStage(ctx as unknown as StageContext, stageInput)
			).threadId,
		}),
	});
