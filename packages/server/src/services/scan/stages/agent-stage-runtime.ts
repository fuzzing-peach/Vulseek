import { buildTaskAgentProfileSnapshot } from "../agent-profile-snapshot";
import { bindTaskRuntimeRepo } from "../persistence/task.repo";
import {
	startContainer,
	type StageContainerInput,
} from "../runtime/run-single-turn-agent";
import type { AgentProfileLike, ScanJob } from "../types";
import type { StageContext } from "./full-scan-stage.runtime";

export type AgentStageRuntime = {
	agentProfile: AgentProfileLike | null;
	taskStageDirPath: string;
	taskStageRootInContainer: string;
	taskRealRootInContainer: string;
	stageDirPath: string;
	stageRootInContainer: string;
	containerName: string;
	codexHome: string;
};

export const resolveAgentStageRuntime = async (input: {
	ctx: StageContext;
	containerNameParts?: Array<string | null | undefined>;
	codexHomeName?: string;
}): Promise<AgentStageRuntime> => {
	const agentProfile = await input.ctx.agentProfile();
	const taskStageDirPath = await input.ctx.taskDir();
	const taskStageRootInContainer = await input.ctx.taskDirContainer();
	const taskRealRootInContainer = await input.ctx.taskDirRealContainer();
	const stageDirPath =
		input.ctx.laneIndex !== null
			? await input.ctx.laneDir()
			: taskStageDirPath;
	const stageRootInContainer =
		input.ctx.laneIndex !== null
			? await input.ctx.laneDirContainer()
			: taskRealRootInContainer;
	const containerName = input.ctx.containerName(
		...(input.containerNameParts || []),
	);
	const codexHome = `${stageRootInContainer}/${input.codexHomeName || ".codex"}`;
	return {
		agentProfile,
		taskStageDirPath,
		taskStageRootInContainer,
		taskRealRootInContainer,
		stageDirPath,
		stageRootInContainer,
		containerName,
		codexHome,
	};
};

export const launchAgentStageRuntime = async (input: {
	ctx: StageContext;
	scanJob: ScanJob;
	containerNameParts?: Array<string | null | undefined>;
	codexHomeName?: string;
	runtimeFileNames?: StageContainerInput["runtimeFileNames"];
}) => {
	const runtime = await resolveAgentStageRuntime(input);
	await bindTaskRuntimeRepo({
		taskId: input.ctx.taskId,
		containerName: runtime.containerName,
		containerIndex: input.ctx.containerIndex,
		agentProfile: buildTaskAgentProfileSnapshot(runtime.agentProfile).agentProfile,
	});
	await startContainer({
		scanJob: input.scanJob,
		taskId: input.ctx.taskId,
		agentProfile: runtime.agentProfile,
		containerName: runtime.containerName,
		codexHome: runtime.codexHome,
		stageDirPath: runtime.stageDirPath,
		stageRootInContainer: runtime.stageRootInContainer,
		taskRealRootInContainer: runtime.taskRealRootInContainer,
		persistent: input.ctx.persistent,
		reuseContainer: input.ctx.reuseContainer,
		runtimeFileNames: input.runtimeFileNames,
	});
	return runtime;
};
