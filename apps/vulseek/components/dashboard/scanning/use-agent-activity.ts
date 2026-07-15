import { useEffect, useMemo, useState } from "react";
import {
	type AgentActivity,
	type AgentActivityMetadata,
	idleAgentActivity,
} from "@/lib/scan/agent-activity";

type ActivityState = {
	activity: AgentActivity;
	isConnected: boolean;
	metadata: AgentActivityMetadata | null;
};

type ActivitiesState = {
	activitiesByTaskId: Record<string, AgentActivity>;
	metadataByTaskId: Record<string, AgentActivityMetadata>;
	connectedTaskIds: Set<string>;
	isConnected: boolean;
	errorMessage: string | null;
};

export const useAgentActivity = ({
	taskId,
	enabled,
}: {
	taskId: string;
	enabled: boolean;
}) => {
	const url = useMemo(
		() =>
			taskId ? `/api/scan/tasks/${encodeURIComponent(taskId)}/activity` : null,
		[taskId],
	);
	const [state, setState] = useState<ActivityState>({
		activity: idleAgentActivity,
		isConnected: false,
		metadata: null,
	});

	useEffect(() => {
		if (!enabled || !url || typeof window === "undefined") return;
		setState({
			activity: idleAgentActivity,
			isConnected: false,
			metadata: null,
		});
		const eventSource = new EventSource(url);
		eventSource.onopen = () =>
			setState((current) => ({ ...current, isConnected: true }));
		const update = (event: Event) => {
			const payload = JSON.parse((event as MessageEvent).data) as {
				metadata?: AgentActivityMetadata;
				activity?: AgentActivity;
			};
			setState((current) => ({
				activity: payload.activity || current.activity,
				metadata: payload.metadata || current.metadata,
				isConnected: true,
			}));
		};
		eventSource.addEventListener("snapshot", update);
		eventSource.addEventListener("activity", update);
		eventSource.addEventListener("done", () => {
			setState((current) => ({ ...current, isConnected: false }));
			eventSource.close();
		});
		eventSource.onerror = () =>
			setState((current) => ({ ...current, isConnected: false }));
		return () => eventSource.close();
	}, [enabled, url]);

	return state;
};

export const useAgentActivities = ({
	scanJobId,
	enabled,
}: {
	scanJobId: string;
	enabled: boolean;
}) => {
	const url = useMemo(
		() =>
			scanJobId
				? `/api/scan/jobs/${encodeURIComponent(scanJobId)}/activities`
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
		if (!enabled || !url || typeof window === "undefined") return;
		setState({
			activitiesByTaskId: {},
			metadataByTaskId: {},
			connectedTaskIds: new Set(),
			isConnected: false,
			errorMessage: null,
		});
		const eventSource = new EventSource(url);
		eventSource.onopen = () =>
			setState((current) => ({
				...current,
				isConnected: true,
				errorMessage: null,
			}));
		eventSource.addEventListener("snapshot", (event) => {
			const payload = JSON.parse((event as MessageEvent).data) as {
				tasks?: Array<{
					taskId: string;
					metadata: AgentActivityMetadata;
					activity: AgentActivity;
				}>;
			};
			const activitiesByTaskId: Record<string, AgentActivity> = {};
			const metadataByTaskId: Record<string, AgentActivityMetadata> = {};
			const connectedTaskIds = new Set<string>();
			for (const task of payload.tasks || []) {
				activitiesByTaskId[task.taskId] = task.activity || idleAgentActivity;
				metadataByTaskId[task.taskId] = task.metadata;
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
				taskId: string;
				metadata: AgentActivityMetadata;
				activity: AgentActivity;
			};
			setState((current) => {
				const connectedTaskIds = new Set(current.connectedTaskIds);
				connectedTaskIds.add(payload.taskId);
				return {
					...current,
					activitiesByTaskId: {
						...current.activitiesByTaskId,
						[payload.taskId]: payload.activity,
					},
					metadataByTaskId: {
						...current.metadataByTaskId,
						[payload.taskId]: payload.metadata,
					},
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
				setState((current) => ({ ...current, isConnected: false }));
				eventSource.close();
				return;
			}
			setState((current) => {
				const connectedTaskIds = new Set(current.connectedTaskIds);
				connectedTaskIds.delete(payload.taskId as string);
				return { ...current, connectedTaskIds };
			});
		});
		eventSource.addEventListener("activity_error", (event) => {
			const payload = JSON.parse((event as MessageEvent).data) as {
				message?: string;
			};
			setState((current) => ({
				...current,
				errorMessage: payload.message || "Agent activity stream disconnected",
			}));
		});
		eventSource.onerror = () =>
			setState((current) => ({
				...current,
				isConnected: false,
				errorMessage: "Agent activity stream disconnected",
			}));
		return () => eventSource.close();
	}, [enabled, url]);

	return state;
};
