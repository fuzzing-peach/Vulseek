import { useEffect, useMemo, useState } from "react";
import type { JsonRpcStreamMessage } from "@/components/dashboard/scanning/jsonrpc-summary";

type SandboxAgentSessionMetadata = {
	taskId: string;
	scanJobId: string;
	taskKind:
		| "repository_scanning"
		| "module_scanning"
		| "function_scanning"
		| "analyzing"
		| "fuzz_building"
		| "fuzzing"
		| "criticizing"
		| "verifying"
		| "triaging";
	containerName?: string | null;
	baseUrl?: string | null;
	provider?: "codex" | "claude";
	status?: string;
	jsonlPath?: string;
	jsonlExists?: boolean;
	jsonlStatError?: string | null;
};

type StreamState = {
	messages: JsonRpcStreamMessage[];
	isConnected: boolean;
	metadata: SandboxAgentSessionMetadata | null;
	errorMessage: string | null;
};

const logSandboxAgentOutputTiming = (
	taskId: string,
	event: string,
	startedAt: number,
	details: Record<string, unknown> = {},
) => {
	if (typeof window === "undefined") {
		return;
	}
	console.info("[sandbox-agent-output]", {
		taskId,
		event,
		elapsedMs: Math.round(performance.now() - startedAt),
		...details,
	});
};

export const useSandboxAgentSession = ({
	taskId,
	enabled,
}: {
	taskId: string;
	enabled: boolean;
}) => {
	const url = useMemo(
		() =>
			taskId ? `/api/scan/tasks/${encodeURIComponent(taskId)}/sandbox-agent-events` : null,
		[taskId],
	);
	const [state, setState] = useState<StreamState>({
		messages: [],
		isConnected: false,
		metadata: null,
		errorMessage: null,
	});

	useEffect(() => {
		if (!enabled || !url || typeof window === "undefined") {
			return;
		}

		const startedAt = performance.now();
		let pendingMessages: JsonRpcStreamMessage[] = [];
		let flushTimer: number | null = null;
		let snapshotMessageCount = 0;
		let deltaMessageCount = 0;
		let firstMessageQueued = false;
		let firstFlushLogged = false;
		let firstDeltaLogged = false;
		const flushMessages = () => {
			flushTimer = null;
			if (pendingMessages.length === 0) {
				return;
			}
			const messages = pendingMessages;
			pendingMessages = [];
			if (!firstFlushLogged) {
				firstFlushLogged = true;
				logSandboxAgentOutputTiming(taskId, "state_flush.first", startedAt, {
					batchSize: messages.length,
					snapshotMessageCount,
					deltaMessageCount,
				});
			}
			setState((current) => ({
				...current,
				messages: [...current.messages, ...messages],
				isConnected: true,
				errorMessage: null,
			}));
		};
		const queueMessages = (
			messages: JsonRpcStreamMessage[],
			source: "snapshot" | "delta",
		) => {
			if (messages.length === 0) {
				return;
			}
			if (!firstMessageQueued) {
				firstMessageQueued = true;
				logSandboxAgentOutputTiming(taskId, "message_queue.first", startedAt, {
					source,
					batchSize: messages.length,
					line: messages[0]?.line,
					timestamp: messages[0]?.timestamp,
				});
			}
			pendingMessages.push(...messages);
			if (flushTimer === null) {
				flushTimer = window.setTimeout(flushMessages, 50);
			}
		};

		setState({
			messages: [],
			isConnected: false,
			metadata: null,
			errorMessage: null,
		});

		logSandboxAgentOutputTiming(taskId, "eventsource.create", startedAt, {
			url,
		});
		const eventSource = new EventSource(url);
		eventSource.onopen = () => {
			logSandboxAgentOutputTiming(taskId, "eventsource.open", startedAt);
			setState((current) => ({
				...current,
				isConnected: true,
			}));
		};
		eventSource.addEventListener("snapshot", (event) => {
			const payload = JSON.parse((event as MessageEvent).data) as {
				metadata?: SandboxAgentSessionMetadata;
				messages?: JsonRpcStreamMessage[];
			};
			logSandboxAgentOutputTiming(taskId, "snapshot.legacy", startedAt, {
				messageCount: payload.messages?.length || 0,
				status: payload.metadata?.status,
				jsonlExists: payload.metadata?.jsonlExists,
			});
			setState({
				messages: payload.messages || [],
				isConnected: true,
				metadata: payload.metadata || null,
				errorMessage: null,
			});
		});
		eventSource.addEventListener("snapshot_start", (event) => {
			const payload = JSON.parse((event as MessageEvent).data) as {
				metadata?: SandboxAgentSessionMetadata;
			};
			logSandboxAgentOutputTiming(taskId, "snapshot.start", startedAt, {
				status: payload.metadata?.status,
				jsonlExists: payload.metadata?.jsonlExists,
				jsonlPath: payload.metadata?.jsonlPath,
			});
			pendingMessages = [];
			if (flushTimer !== null) {
				window.clearTimeout(flushTimer);
				flushTimer = null;
			}
			setState({
				messages: [],
				isConnected: true,
				metadata: payload.metadata || null,
				errorMessage: null,
			});
		});
		eventSource.addEventListener("snapshot_message", (event) => {
			const message = JSON.parse(
				(event as MessageEvent).data,
			) as JsonRpcStreamMessage;
			snapshotMessageCount += 1;
			queueMessages([message], "snapshot");
		});
		eventSource.addEventListener("snapshot_end", () => {
			logSandboxAgentOutputTiming(taskId, "snapshot.end", startedAt, {
				snapshotMessageCount,
				pendingMessages: pendingMessages.length,
			});
			flushMessages();
			setState((current) => ({
				...current,
				isConnected: true,
				errorMessage: null,
			}));
		});
		eventSource.addEventListener("delta", (event) => {
			const payload = JSON.parse((event as MessageEvent).data) as {
				messages?: JsonRpcStreamMessage[];
			};
			const messages = payload.messages || [];
			deltaMessageCount += messages.length;
			if (!firstDeltaLogged && messages.length > 0) {
				firstDeltaLogged = true;
				logSandboxAgentOutputTiming(taskId, "delta.first", startedAt, {
					batchSize: messages.length,
					line: messages[0]?.line,
					timestamp: messages[0]?.timestamp,
				});
			}
			queueMessages(messages, "delta");
		});
		eventSource.addEventListener("stream_error", (event) => {
			const payload = JSON.parse((event as MessageEvent).data) as {
				message?: string;
			};
			logSandboxAgentOutputTiming(taskId, "stream.error", startedAt, {
				message: payload.message,
			});
			setState((current) => ({
				...current,
				isConnected: false,
				errorMessage: payload.message || "Sandbox agent stream error",
			}));
		});
		eventSource.addEventListener("done", () => {
			logSandboxAgentOutputTiming(taskId, "stream.done", startedAt, {
				snapshotMessageCount,
				deltaMessageCount,
			});
			setState((current) => ({
				...current,
				isConnected: false,
			}));
			eventSource.close();
		});
		eventSource.addEventListener("error", () => {
			logSandboxAgentOutputTiming(taskId, "eventsource.error", startedAt, {
				readyState: eventSource.readyState,
			});
			setState((current) => ({
				...current,
				isConnected: false,
				errorMessage: current.errorMessage || "Sandbox agent stream disconnected",
			}));
		});

		return () => {
			if (flushTimer !== null) {
				window.clearTimeout(flushTimer);
			}
			logSandboxAgentOutputTiming(taskId, "eventsource.cleanup", startedAt, {
				snapshotMessageCount,
				deltaMessageCount,
			});
			eventSource.close();
		};
	}, [enabled, taskId, url]);

	return state;
};
