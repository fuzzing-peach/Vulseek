import { useEffect, useMemo, useRef, useState } from "react";
import type { JsonRpcStreamMessage } from "@/components/dashboard/scanning/jsonrpc-summary";
import { api } from "@/utils/api";

type StreamState = {
	messages: JsonRpcStreamMessage[];
	isConnected: boolean;
};

type ScannerSessionInput = {
	kind: "scanner";
	scanJobId: string;
	stage: "repository_scanning" | "module_scanning" | "function_scanning";
	scanModuleTaskId?: string;
	scanFunctionTaskId?: string;
	enabled: boolean;
	initialMessages?: JsonRpcStreamMessage[];
};

type CandidateSessionInput = {
	kind: "candidate";
	vulnerabilityCandidateId: string;
	stage: "analyzing" | "verifying";
	enabled: boolean;
	initialMessages?: JsonRpcStreamMessage[];
};

type SandboxSessionMetadata = {
	sessionId: string;
	provider: "codex" | "claude";
	containerName?: string | null;
	baseUrl: string;
};

const toJsonRpcStreamMessage = (
	line: number,
	event: Record<string, unknown>,
): JsonRpcStreamMessage | null => {
	const message =
		event.payload && typeof event.payload === "object"
			? (event.payload as Record<string, unknown>)
			: event;
	if (!message || typeof message !== "object") {
		return null;
	}
	return {
		line,
		timestamp: typeof event.createdAt === "string" ? event.createdAt : undefined,
		message,
	};
};

const loadExistingSession = async (client: any, sessionId: string) => {
	if (typeof client.loadSession === "function") {
		return await client.loadSession(sessionId);
	}
	if (typeof client.resumeSession === "function") {
		return await client.resumeSession(sessionId);
	}
	if (typeof client.session === "function") {
		return await client.session(sessionId);
	}
	throw new Error("sandbox-agent client does not support loading sessions");
};

export const useSandboxAgentSession = (
	input: ScannerSessionInput | CandidateSessionInput,
) => {
	const stableInitialMessages = useMemo(
		() => input.initialMessages || [],
		[input.initialMessages],
	);
	const [state, setState] = useState<StreamState>({
		messages: stableInitialMessages,
		isConnected: false,
	});
	const lineRef = useRef(stableInitialMessages.length);
	const seenEventIdsRef = useRef<Set<string>>(new Set());

	const scannerSessionQuery = api.scan.scannerSession.useQuery(
		input.kind === "scanner"
			? {
				scanJobId: input.scanJobId,
				stage: input.stage,
				scanModuleTaskId: input.scanModuleTaskId,
				scanFunctionTaskId: input.scanFunctionTaskId,
			}
			: {
				scanJobId: "",
				stage: "repository_scanning",
			},
		{
			enabled: input.kind === "scanner" && input.enabled,
			refetchInterval: input.enabled ? 2000 : false,
		},
	);

	const candidateSessionQuery = api.scan.candidateSession.useQuery(
		input.kind === "candidate"
			? {
				vulnerabilityCandidateId: input.vulnerabilityCandidateId,
				stage: input.stage,
			}
			: {
				vulnerabilityCandidateId: "",
				stage: "analyzing",
			},
		{
			enabled: input.kind === "candidate" && input.enabled,
			refetchInterval: input.enabled ? 2000 : false,
		},
	);

	const metadata =
		(input.kind === "scanner"
			? scannerSessionQuery.data
			: candidateSessionQuery.data) as SandboxSessionMetadata | null | undefined;

	useEffect(() => {
		lineRef.current = stableInitialMessages.length;
		seenEventIdsRef.current = new Set();
		setState({
			messages: stableInitialMessages,
			isConnected: false,
		});
	}, [stableInitialMessages, metadata?.sessionId, metadata?.baseUrl]);

	useEffect(() => {
		if (!input.enabled || !metadata?.sessionId || !metadata.baseUrl) {
			return;
		}

		let closed = false;
		let cleanup: (() => void) | undefined;

		void (async () => {
			try {
				const { SandboxAgent } = await import("sandbox-agent");
				const baseUrl = new URL(metadata.baseUrl, window.location.origin).toString();
				const client: any = await SandboxAgent.connect({
					baseUrl,
				} as never);
				const session: any = await loadExistingSession(client, metadata.sessionId);
				if (closed) {
					return;
				}
				setState((current) => ({ ...current, isConnected: true }));
				session.onEvent((event: Record<string, unknown>) => {
					if (closed) {
						return;
					}
					const eventId = typeof event.id === "string" ? event.id : "";
					if (eventId) {
						if (seenEventIdsRef.current.has(eventId)) {
							return;
						}
						seenEventIdsRef.current.add(eventId);
					}
					lineRef.current += 1;
					const nextMessage = toJsonRpcStreamMessage(lineRef.current, event);
					if (!nextMessage) {
						return;
					}
					setState((current) => ({
						messages: [...current.messages, nextMessage],
						isConnected: true,
					}));
				});
				cleanup = () => {
					if (typeof session.close === "function") {
						void session.close().catch(() => {});
					}
				};
			} catch {
				if (!closed) {
					setState((current) => ({ ...current, isConnected: false }));
				}
			}
		})();

		return () => {
			closed = true;
			cleanup?.();
		};
	}, [input.enabled, metadata?.baseUrl, metadata?.sessionId]);

	return {
		...state,
		metadata,
	};
};
