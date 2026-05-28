import { useEffect, useMemo, useState } from "react";
import {
	idleSandboxAgentActivity,
	type SandboxAgentActivity,
} from "@/lib/scan/sandbox-agent-activity";

export type SandboxAgentActivityMetadata = {
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

type ActivitiesState = {
	activitiesByTaskId: Record<string, SandboxAgentActivity>;
	metadataByTaskId: Record<string, SandboxAgentActivityMetadata>;
	connectedTaskIds: Set<string>;
	isConnected: boolean;
	errorMessage: string | null;
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
		eventSource.addEventListener("activity_error", () => {
			setState((current) => ({
				...current,
				isConnected: true,
			}));
		});
		eventSource.onerror = () => {
			setState((current) => ({
				...current,
				isConnected: false,
			}));
		};

		return () => {
			eventSource.close();
		};
	}, [enabled, url]);

	return state;
};

export const useSandboxAgentActivities = ({
	scanJobId,
	enabled,
}: {
	scanJobId: string;
	enabled: boolean;
}) => {
	const url = useMemo(
		() =>
			scanJobId
				? `/api/scan/jobs/${encodeURIComponent(scanJobId)}/sandbox-agent-activities`
				: null,
		[scanJobId],
	);
	const [state, setState] = useState<ActivitiesState>({
		activitiesByTaskId: {},
		metadataByTaskId: {},
		connectedTaskIds: new Set(),
		isConnected: false,
		errorMessage: null,
	});

	useEffect(() => {
		if (!enabled || !url || typeof window === "undefined") {
			return;
		}

		setState({
			activitiesByTaskId: {},
			metadataByTaskId: {},
			connectedTaskIds: new Set(),
			isConnected: false,
			errorMessage: null,
		});

		const eventSource = new EventSource(url);
		eventSource.onopen = () => {
			setState((current) => ({
				...current,
				isConnected: true,
				errorMessage: null,
			}));
		};
		eventSource.addEventListener("snapshot", (event) => {
			const payload = JSON.parse((event as MessageEvent).data) as {
				tasks?: Array<{
					taskId: string;
					metadata?: SandboxAgentActivityMetadata;
					activity?: SandboxAgentActivity;
				}>;
			};
			const activitiesByTaskId: Record<string, SandboxAgentActivity> = {};
			const metadataByTaskId: Record<string, SandboxAgentActivityMetadata> = {};
			const connectedTaskIds = new Set<string>();

			for (const task of payload.tasks || []) {
				if (!task.taskId) {
					continue;
				}
				activitiesByTaskId[task.taskId] =
					task.activity || idleSandboxAgentActivity;
				if (task.metadata) {
					metadataByTaskId[task.taskId] = task.metadata;
				}
				connectedTaskIds.add(task.taskId);
			}

			setState({
				activitiesByTaskId,
				metadataByTaskId,
				connectedTaskIds,
				isConnected: true,
				errorMessage: null,
			});
		});
		eventSource.addEventListener("activity", (event) => {
			const payload = JSON.parse((event as MessageEvent).data) as {
				taskId?: string;
				metadata?: SandboxAgentActivityMetadata;
				activity?: SandboxAgentActivity;
			};
			if (!payload.taskId) {
				return;
			}
			const taskId = payload.taskId;
			setState((current) => {
				const connectedTaskIds = new Set(current.connectedTaskIds);
				connectedTaskIds.add(taskId);
				return {
					...current,
					activitiesByTaskId: {
						...current.activitiesByTaskId,
						[taskId]:
							payload.activity ||
							current.activitiesByTaskId[taskId] ||
							idleSandboxAgentActivity,
					},
					metadataByTaskId: payload.metadata
						? {
								...current.metadataByTaskId,
								[taskId]: payload.metadata,
							}
						: current.metadataByTaskId,
					connectedTaskIds,
					isConnected: true,
					errorMessage: null,
				};
			});
		});
		eventSource.addEventListener("done", (event) => {
			const payload = JSON.parse((event as MessageEvent).data) as {
				taskId?: string | null;
			};
			if (!payload.taskId) {
				setState((current) => ({
					...current,
					isConnected: false,
				}));
				eventSource.close();
				return;
			}
			setState((current) => {
				const connectedTaskIds = new Set(current.connectedTaskIds);
				connectedTaskIds.delete(payload.taskId as string);
				return {
					...current,
					connectedTaskIds,
				};
			});
		});
		eventSource.addEventListener("activity_error", (event) => {
			let message = "Sandbox agent activity stream disconnected";
			try {
				const payload = JSON.parse((event as MessageEvent).data) as {
					message?: string;
				};
				message = payload.message || message;
			} catch {}
			setState((current) => ({
				...current,
				isConnected: true,
				errorMessage: message,
			}));
		});
		eventSource.onerror = () => {
			setState((current) => ({
				...current,
				isConnected: false,
				errorMessage: "Sandbox agent activity stream disconnected",
			}));
		};

		return () => {
			eventSource.close();
		};
	}, [enabled, url]);

	return state;
};
