export type AgentActivityKind =
	| "waiting"
	| "prompt"
	| "reasoning"
	| "writing"
	| "planning"
	| "tool"
	| "web"
	| "command"
	| "completed"
	| "cancelled"
	| "error";

export type AgentActivity = {
	kind: AgentActivityKind;
	label: string;
	detail?: string;
	toolCallId?: string;
	timestamp?: string;
};

export type AgentActivitySnapshot = {
	version: 1;
	revision: number;
	taskId: string | null;
	sessionId: string | null;
	status: string;
	activity: AgentActivity;
	updatedAt: string;
};

export type AgentActivityMetadata = {
	taskId: string;
	scanJobId: string;
	taskKind: string;
	containerName?: string | null;
	provider?: "codex" | "claude";
	status?: string;
	sessionId?: string | null;
};

export const idleAgentActivity: AgentActivity = {
	kind: "waiting",
	label: "Idle",
};
