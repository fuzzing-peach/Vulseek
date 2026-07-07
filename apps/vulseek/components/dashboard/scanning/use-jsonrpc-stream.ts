import { useEffect, useMemo, useState } from "react";
import type { JsonRpcStreamMessage } from "@/components/dashboard/scanning/jsonrpc-summary";

type StreamState = {
	messages: JsonRpcStreamMessage[];
	isConnected: boolean;
};

export const useJsonRpcStream = ({
	url,
	enabled,
	initialMessages,
}: {
	url: string | null;
	enabled: boolean;
	initialMessages?: JsonRpcStreamMessage[];
}) => {
	const stableInitialMessages = useMemo(() => initialMessages || [], [initialMessages]);
	const [state, setState] = useState<StreamState>({
		messages: stableInitialMessages,
		isConnected: false,
	});

	useEffect(() => {
		setState({
			messages: stableInitialMessages,
			isConnected: false,
		});
	}, [url]);

	useEffect(() => {
		if (stableInitialMessages.length === 0) {
			return;
		}

		setState((current) => {
			if (current.messages.length === 0) {
				return {
					...current,
					messages: stableInitialMessages,
				};
			}

			if (!current.isConnected && stableInitialMessages.length > current.messages.length) {
				return {
					...current,
					messages: stableInitialMessages,
				};
			}

			return current;
		});
	}, [stableInitialMessages]);

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
				messages?: JsonRpcStreamMessage[];
			};
			setState({
				messages: payload.messages || [],
				isConnected: true,
			});
		});
		eventSource.addEventListener("append", (event) => {
			const payload = JSON.parse((event as MessageEvent).data) as {
				messages?: JsonRpcStreamMessage[];
			};
			setState((current) => ({
				messages: [...current.messages, ...(payload.messages || [])],
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
