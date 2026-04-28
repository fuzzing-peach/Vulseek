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
		| "verifying";
	containerName?: string | null;
	baseUrl?: string | null;
	provider?: "codex" | "claude";
	status?: string;
};

type StreamState = {
	messages: JsonRpcStreamMessage[];
	isConnected: boolean;
	metadata: SandboxAgentSessionMetadata | null;
};

const MAX_MESSAGES = 500;

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
	});

	useEffect(() => {
		setState({
			messages: [],
			isConnected: false,
			metadata: null,
		});
	}, [url]);

	useEffect(() => {
		if (!enabled || !url || typeof window === "undefined") {
			return;
		}

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
			});
		});
		eventSource.addEventListener("delta", (event) => {
			const payload = JSON.parse((event as MessageEvent).data) as {
				messages?: JsonRpcStreamMessage[];
			};
			setState((current) => ({
				...current,
				messages: [...current.messages, ...(payload.messages || [])].slice(
					-MAX_MESSAGES,
				),
				isConnected: true,
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
			}));
		});

		return () => {
			eventSource.close();
		};
	}, [enabled, url]);

	return state;
};
