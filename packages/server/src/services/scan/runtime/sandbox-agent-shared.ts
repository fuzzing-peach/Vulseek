export const SANDBOX_AGENT_RUNTIME_FILE_NAMES = {
	jsonl: "sandbox-agent-event.jsonl",
	text: "sandbox-agent-text.log",
	stderr: "sandbox-agent-stderr.log",
	stdout: "task-stdout.log",
} as const;

const VULSEEK_RET_MARKER = "<VULSEEK_RET>";
const VULSEEK_RET_XML_CLOSE_MARKER = "</VULSEEK_RET>";

type SandboxAgentSessionUpdate =
	| {
			sessionUpdate?: string;
			content?: unknown;
			itemId?: string;
			[key: string]: unknown;
	  }
	| string
	| unknown[];

export type SandboxAgentSessionEvent = {
	id?: string;
	eventIndex?: number;
	sessionId?: string;
	createdAt?: string;
	connectionId?: string;
	sender?: string;
	payload?: SandboxAgentSessionUpdate | Record<string, unknown>;
};

type MaybeSandboxAgentSessionUpdate = SandboxAgentSessionUpdate | undefined;

const asRecord = (value: unknown) =>
	value && typeof value === "object" ? (value as Record<string, unknown>) : null;

const asString = (value: unknown) => (typeof value === "string" ? value : "");

const getEventPayloadRecord = (event: SandboxAgentSessionEvent) =>
	asRecord(event.payload);

const getEventParamsRecord = (event: SandboxAgentSessionEvent) =>
	asRecord(getEventPayloadRecord(event)?.params);

export const getEventUpdate = (event: SandboxAgentSessionEvent) => {
	const paramsUpdate = getEventParamsRecord(event)?.update;
	if (paramsUpdate !== undefined) {
		return paramsUpdate as MaybeSandboxAgentSessionUpdate;
	}
	return event.payload as MaybeSandboxAgentSessionUpdate;
};

const extractTextValue = (value: unknown): string => {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(extractTextValue).join("");
	if (!value || typeof value !== "object") return "";
	const record = value as Record<string, unknown>;
	return [record.text, record.value, record.content]
		.map(extractTextValue)
		.find(Boolean) || "";
};

export const extractPayloadText = (
	payload: MaybeSandboxAgentSessionUpdate,
): string => {
	if (typeof payload === "string") return payload;
	if (Array.isArray(payload)) {
		return payload
			.map((item) => extractPayloadText(item as MaybeSandboxAgentSessionUpdate))
			.join("");
	}
	const record = asRecord(payload);
	if (!record) return "";
	return (
		extractTextValue(record.content) ||
		extractTextValue(record.delta) ||
		extractTextValue(record.message) ||
		extractTextValue(record.result) ||
		extractTextValue(record)
	);
};

export const renderSandboxAgentEvent = (event: SandboxAgentSessionEvent) => {
	const update = getEventUpdate(event);
	const record = asRecord(update);
	const updateType = asString(record?.sessionUpdate);
	const text = extractPayloadText(update);
	switch (updateType) {
		case "agent_message_chunk":
		case "agent_thought_chunk":
		case "user_message_chunk":
			return text;
		case "tool_call":
		case "tool_call_update":
			return text ? `\n[tool] ${text}\n` : "";
		case "plan":
			return text ? `\n[plan] ${text}\n` : "";
		case "usage_update":
			return "";
		case "session_info_update":
			return text ? `\n[session] ${text}\n` : "";
		default:
			return text;
	}
};

export const formatSandboxAgentSessionEvent = (
	event: SandboxAgentSessionEvent,
) => `${JSON.stringify(event)}\n`;

export const isAgentMessageChunkEvent = (event: SandboxAgentSessionEvent) => {
	const update = getEventUpdate(event);
	const payloadRecord = asRecord(update);
	return asString(payloadRecord?.sessionUpdate) === "agent_message_chunk";
};

export const extractVulseekRetValue = (content: string): string | null => {
	const acceptPairedPayload = (payload: string) => {
		const trimmed = payload.trim();
		return trimmed || null;
	};

	const acceptTrailingStructuredPayload = (payload: string) => {
		const trimmed = payload.trim();
		if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
			return null;
		}
		try {
			JSON.parse(trimmed);
		} catch {
			return null;
		}
		return trimmed;
	};

	const xmlEnd = content.lastIndexOf(VULSEEK_RET_XML_CLOSE_MARKER);
	if (xmlEnd > 0) {
		const xmlStart = content.lastIndexOf(VULSEEK_RET_MARKER, xmlEnd - 1);
		if (xmlStart >= 0) {
			return acceptPairedPayload(
				content.slice(xmlStart + VULSEEK_RET_MARKER.length, xmlEnd),
			);
		}
	}

	const end = content.lastIndexOf(VULSEEK_RET_MARKER);
	if (end >= 0) {
		const trailingPayload = acceptTrailingStructuredPayload(
			content.slice(end + VULSEEK_RET_MARKER.length),
		);
		if (trailingPayload !== null) {
			return trailingPayload;
		}
	}
	if (end <= 0) return null;
	const start = content.lastIndexOf(VULSEEK_RET_MARKER, end - 1);
	if (start < 0) return null;
	return acceptPairedPayload(
		content.slice(start + VULSEEK_RET_MARKER.length, end),
	);
};

export const extractRetFromJsonlContent = (content: string): string | null => {
	let agentMessageText = "";
	for (const rawLine of content.split("\n")) {
		const trimmed = rawLine.trim();
		if (!trimmed) {
			continue;
		}
		try {
			const parsed = JSON.parse(trimmed) as SandboxAgentSessionEvent;
			if (!isAgentMessageChunkEvent(parsed)) {
				continue;
			}
			agentMessageText += extractPayloadText(getEventUpdate(parsed));
			const ret = extractVulseekRetValue(agentMessageText);
			if (ret !== null) {
				return ret;
			}
		} catch {}
	}
	return null;
};
