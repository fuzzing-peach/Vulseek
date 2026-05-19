export const SANDBOX_AGENT_RUNTIME_FILE_NAMES = {
	jsonl: "sandbox-agent-event.jsonl",
	text: "sandbox-agent-text.log",
	stderr: "sandbox-agent-stderr.log",
	stdout: "task-stdout.log",
} as const;

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
	return (
		[record.text, record.value, record.content]
			.map(extractTextValue)
			.find(Boolean) || ""
	);
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

const asNumber = (value: unknown) =>
	typeof value === "number" && Number.isFinite(value) ? value : null;

export type SandboxAgentTokenUsageSummary = {
	firstUsed: number;
	latestUsed: number;
	tokenUsage: number;
	contextSize: number | null;
};

export const getUsageUpdateUsedTokens = (
	update: MaybeSandboxAgentSessionUpdate,
) => {
	const record = asRecord(update);
	if (!record || asString(record.sessionUpdate) !== "usage_update") {
		return null;
	}
	const directUsed = asNumber(record.used);
	const tokenUsage = asRecord(record.tokenUsage);
	const total = asRecord(tokenUsage?.total);
	const nestedUsed = asNumber(total?.totalTokens);
	const used = directUsed ?? nestedUsed;
	if (used === null) {
		return null;
	}
	return {
		used,
		contextSize:
			asNumber(record.size) ?? asNumber(tokenUsage?.modelContextWindow),
	};
};

export const summarizeSandboxAgentTokenUsage = (
	content: string,
): SandboxAgentTokenUsageSummary | null => {
	let firstUsed: number | null = null;
	let latestUsed: number | null = null;
	let contextSize: number | null = null;

	for (const rawLine of content.split("\n")) {
		const trimmed = rawLine.trim();
		if (!trimmed) {
			continue;
		}
		try {
			const parsed = JSON.parse(trimmed) as SandboxAgentSessionEvent;
			const usage = getUsageUpdateUsedTokens(getEventUpdate(parsed));
			if (!usage) {
				continue;
			}
			firstUsed ??= usage.used;
			latestUsed = usage.used;
			contextSize = usage.contextSize ?? contextSize;
		} catch {}
	}

	if (firstUsed === null || latestUsed === null) {
		return null;
	}

	return {
		firstUsed,
		latestUsed,
		tokenUsage: Math.max(0, latestUsed - firstUsed),
		contextSize,
	};
};

export const isAgentMessageChunkEvent = (event: SandboxAgentSessionEvent) => {
	const update = getEventUpdate(event);
	const payloadRecord = asRecord(update);
	return asString(payloadRecord?.sessionUpdate) === "agent_message_chunk";
};

export const hasEndTurnInJsonlContent = (content: string): boolean => {
	for (const rawLine of content.split("\n")) {
		const trimmed = rawLine.trim();
		if (!trimmed) {
			continue;
		}
		try {
			const parsed = JSON.parse(trimmed) as SandboxAgentSessionEvent;
			const payloadRecord = getEventPayloadRecord(parsed);
			const resultRecord = asRecord(payloadRecord?.result);
			if (asString(resultRecord?.stopReason) === "end_turn") {
				return true;
			}
		} catch {}
	}
	return false;
};
