import { useEffect, useMemo, useState } from "react";
import {
	idleSandboxAgentActivity,
	type SandboxAgentActivity,
} from "@/lib/scan/sandbox-agent-activity";

type SandboxAgentActivityMetadata = {
	taskId: string;
	scanJobId: string;
	taskKind: string;
	containerName?: string | null;
	baseUrl?: string | null;
	provider?: "codex" | "claude";
	status?: string;
};

type ActivityState = {
	activity: SandboxAgentActivity;
	isConnected: boolean;
	metadata: SandboxAgentActivityMetadata | null;
};

export const useSandboxAgentActivity = ({
	taskId,
	enabled,
}: {
	taskId: string;
	enabled: boolean;
}) => {
	const url = useMemo(
		() =>
			taskId
				? `/api/scan/tasks/${encodeURIComponent(taskId)}/sandbox-agent-activity`
				: null,
		[taskId],
	);
	const [state, setState] = useState<ActivityState>({
		activity: idleSandboxAgentActivity,
		isConnected: false,
		metadata: null,
	});

	useEffect(() => {
		if (!enabled || !url || typeof window === "undefined") {
			return;
		}

		setState({
			activity: idleSandboxAgentActivity,
			isConnected: false,
			metadata: null,
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
				metadata?: SandboxAgentActivityMetadata;
				activity?: SandboxAgentActivity;
			};
			setState({
				activity: payload.activity || idleSandboxAgentActivity,
				isConnected: true,
				metadata: payload.metadata || null,
			});
		});
		eventSource.addEventListener("activity", (event) => {
			const payload = JSON.parse((event as MessageEvent).data) as {
				activity?: SandboxAgentActivity;
			};
			setState((current) => ({
				...current,
				activity: payload.activity || current.activity,
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
