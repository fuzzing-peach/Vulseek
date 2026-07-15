import {
	type AgentTaskRuntime,
	findAgentTaskRuntimeByTaskId,
} from "./live-session";
import {
	buildNativeAgentTranscriptRoots,
	findNativeAgentTranscript,
	type NativeAgentTranscriptProvider,
} from "./native-agent-transcript";
import { findStageLaneRuntimeByTaskIdRepo } from "./persistence/stage-lane-runtime.repo";

export type AgentStreamRuntime = {
	runtime: AgentTaskRuntime;
	provider: NativeAgentTranscriptProvider;
	threadId: string | null;
	roots: string[];
	transcriptPath: string | null;
};

const resolveLaneIndexFromContainerName = (containerName: string | null) => {
	const match = (containerName || "").match(/(?:^|-)lane-(\d+)$/);
	if (!match?.[1]) {
		return null;
	}
	const laneIndex = Number.parseInt(match[1], 10);
	return Number.isFinite(laneIndex) ? laneIndex : null;
};

export const findAgentStreamRuntimeByTaskId = async (
	taskId: string,
): Promise<AgentStreamRuntime | null> => {
	const runtime = await findAgentTaskRuntimeByTaskId(taskId);
	if (!runtime) {
		return null;
	}

	const containerLaneIndex = resolveLaneIndexFromContainerName(
		runtime.containerName,
	);
	const laneRuntime =
		containerLaneIndex === null
			? await findStageLaneRuntimeByTaskIdRepo({
					scanJobId: runtime.scanJobId,
					stageName: runtime.stageName,
					taskId: runtime.taskId,
				}).catch(() => null)
			: null;
	const laneIndex = containerLaneIndex ?? laneRuntime?.laneIndex ?? null;
	const roots = buildNativeAgentTranscriptRoots({
		runtimeDir: runtime.runtimeDir,
		laneIndex,
	});

	const provider: NativeAgentTranscriptProvider =
		runtime.provider === "claude" ? "claude-code" : "codex";
	const transcriptPath = await findNativeAgentTranscript({
		roots,
		provider,
		threadId: runtime.sessionId,
	});

	return {
		runtime,
		provider,
		threadId: runtime.sessionId,
		roots,
		transcriptPath,
	};
};
