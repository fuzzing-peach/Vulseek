import {
	type AgentTaskRuntime,
	findAgentTaskRuntimeByTaskId,
} from "./live-session";
import {
	buildNativeAgentTranscriptRoots,
	findNativeAgentTranscript,
	type NativeAgentTranscriptProvider,
} from "./native-agent-transcript";

export type AgentStreamRuntime = {
	runtime: AgentTaskRuntime;
	provider: NativeAgentTranscriptProvider;
	threadId: string | null;
	roots: string[];
	transcriptPath: string | null;
};

export const findAgentStreamRuntimeByTaskId = async (
	taskId: string,
): Promise<AgentStreamRuntime | null> => {
	const runtime = await findAgentTaskRuntimeByTaskId(taskId);
	if (!runtime) {
		return null;
	}

	const roots = buildNativeAgentTranscriptRoots({
		runtimeDir: runtime.runtimeDir,
		scanJobId: runtime.scanJobId,
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
