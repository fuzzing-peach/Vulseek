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
		| "verifying";
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

		let pendingMessages: JsonRpcStreamMessage[] = [];
		let flushTimer: number | null = null;
		const flushMessages = () => {
			flushTimer = null;
			if (pendingMessages.length === 0) {
				return;
			}
			const messages = pendingMessages;
			pendingMessages = [];
			setState((current) => ({
				...current,
				messages: [...current.messages, ...messages],
				isConnected: true,
				errorMessage: null,
			}));
		};
		const queueMessages = (messages: JsonRpcStreamMessage[]) => {
			if (messages.length === 0) {
				return;
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

		const eventSource = new EventSource(url);
		eventSource.onopen = () => {
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
			queueMessages([message]);
		});
		eventSource.addEventListener("snapshot_end", () => {
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
			queueMessages(payload.messages || []);
		});
		eventSource.addEventListener("stream_error", (event) => {
			const payload = JSON.parse((event as MessageEvent).data) as {
				message?: string;
			};
			setState((current) => ({
				...current,
				isConnected: false,
				errorMessage: payload.message || "Sandbox agent stream error",
			}));
		});
		eventSource.addEventListener("done", () => {
			setState((current) => ({
				...current,
				isConnected: false,
			}));
			eventSource.close();
		});
		eventSource.addEventListener("error", () => {
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
			eventSource.close();
		};
	}, [enabled, url]);

	return state;
};
