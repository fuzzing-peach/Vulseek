export type SandboxAgentActivityKind =
	| "waiting"
	| "prompt"
	| "reasoning"
	| "writing"
	| "planning"
	| "tool"
	| "web"
	| "command"
	| "error";

export type SandboxAgentActivity = {
	kind: SandboxAgentActivityKind;
	label: string;
	detail?: string;
	line?: number;
	timestamp?: string;
	tokenUsage?: SandboxAgentActivityTokenUsage;
};

export type SandboxAgentActivityTokenUsage = {
	firstUsed: number;
	latestUsed: number;
	used: number;
	contextSize?: number | null;
	line?: number;
	timestamp?: string;
};

export type SandboxAgentActivityStreamMessage = {
	line: number;
	timestamp?: string;
	message: Record<string, unknown>;
};

export const idleSandboxAgentActivity: SandboxAgentActivity = {
	kind: "waiting",
	label: "Idle",
};

const trimSummary = (value: string, max = 120) => {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (!normalized) {
		return "";
	}
	return normalized.length > max
		? `${normalized.slice(0, Math.max(0, max - 3))}...`
		: normalized;
};

const getStringField = (
	record: Record<string, unknown> | null | undefined,
	key: string,
) => (record && typeof record[key] === "string" ? (record[key] as string) : "");

const getObjectField = (
	record: Record<string, unknown> | null | undefined,
	key: string,
) =>
	record && record[key] && typeof record[key] === "object"
		? (record[key] as Record<string, unknown>)
		: null;

const getNumberField = (
	record: Record<string, unknown> | null | undefined,
	key: string,
) =>
	record && typeof record[key] === "number" && Number.isFinite(record[key])
		? (record[key] as number)
		: null;

const getTextContent = (value: unknown): string => {
	if (!value) {
		return "";
	}
	if (typeof value === "string") {
		return value;
	}
	if (Array.isArray(value)) {
		return value
			.map((entry) => {
				if (!entry || typeof entry !== "object") {
					return "";
				}
				const record = entry as Record<string, unknown>;
				if (typeof record.text === "string") {
					return record.text;
				}
				const content = getObjectField(record, "content");
				return getStringField(content, "text");
			})
			.filter(Boolean)
			.join("\n");
	}
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		if (typeof record.text === "string") {
			return record.text;
		}
		const content = getObjectField(record, "content");
		return getStringField(content, "text");
	}
	return "";
};

const firstStringFromArray = (value: unknown, preferredKeys: string[] = []) => {
	if (!Array.isArray(value)) {
		return "";
	}

	for (const entry of value) {
		if (typeof entry === "string" && entry.trim()) {
			return entry;
		}
		if (!entry || typeof entry !== "object") {
			continue;
		}
		const record = entry as Record<string, unknown>;
		for (const key of preferredKeys) {
			const next = getStringField(record, key);
			if (next.trim()) {
				return next;
			}
		}
	}

	return "";
};

const extractWebDetail = (rawInput: Record<string, unknown> | null) => {
	if (!rawInput) {
		return "";
	}

	const action = getObjectField(rawInput, "action");
	const argumentsRecord = getObjectField(rawInput, "arguments");

	const query =
		getStringField(action, "query") ||
		getStringField(argumentsRecord, "query") ||
		getStringField(argumentsRecord, "q") ||
		getStringField(rawInput, "query") ||
		firstStringFromArray(getObjectField(argumentsRecord, "action")?.queries, [
			"q",
			"query",
		]) ||
		firstStringFromArray(argumentsRecord?.queries, ["q", "query"]) ||
		firstStringFromArray(action?.queries, ["q", "query"]);
	if (query.trim()) {
		return trimSummary(query, 140);
	}

	const url =
		getStringField(action, "url") ||
		getStringField(argumentsRecord, "url") ||
		getStringField(rawInput, "url") ||
		firstStringFromArray(action?.urls, ["url", "href"]) ||
		firstStringFromArray(argumentsRecord?.urls, ["url", "href"]) ||
		firstStringFromArray(argumentsRecord?.links, ["url", "href"]);
	if (url.trim()) {
		return trimSummary(url, 160);
	}

	return "";
};

const commandTitlePrefixes = [
	"bash",
	"cat ",
	"cd ",
	"cmake",
	"cp ",
	"find ",
	"git ",
	"grep ",
	"ls ",
	"make",
	"mkdir ",
	"mv ",
	"node ",
	"npm ",
	"pnpm ",
	"python",
	"rg ",
	"sed ",
	"sh ",
	"timeout ",
	"touch ",
	"./",
	"/",
];

const looksLikeCommandTitle = (title: string) => {
	const normalized = title.trim().toLowerCase();
	if (!normalized) {
		return false;
	}
	return (
		normalized.includes("\n") ||
		normalized.startsWith("$ ") ||
		commandTitlePrefixes.some((prefix) => normalized.startsWith(prefix))
	);
};

const normalizeToolTitle = (title: string) => {
	const normalized = title.trim();
	if (!normalized) {
		return { label: "Tool", detail: "" };
	}

	if (normalized.toLowerCase().startsWith("search ")) {
		return {
			label: "Search",
			detail: normalized.slice("search ".length).trim() || normalized,
		};
	}

	if (looksLikeCommandTitle(normalized)) {
		return { label: "Command", detail: normalized };
	}

	return {
		label: normalized.length > 40 ? "Tool" : normalized,
		detail: normalized === "Tool" ? "" : normalized,
	};
};

const makeActivity = (
	entry: SandboxAgentActivityStreamMessage,
	activity: Omit<SandboxAgentActivity, "line" | "timestamp">,
	current?: SandboxAgentActivity,
): SandboxAgentActivity => ({
	...activity,
	tokenUsage: activity.tokenUsage || current?.tokenUsage,
	line: entry.line,
	timestamp: entry.timestamp,
});

const getUsageUpdate = (
	entry: SandboxAgentActivityStreamMessage,
	update: Record<string, unknown>,
	current: SandboxAgentActivity,
): SandboxAgentActivity | null => {
	const directUsed = getNumberField(update, "used");
	const tokenUsage = getObjectField(update, "tokenUsage");
	const total = getObjectField(tokenUsage, "total");
	const nestedUsed = getNumberField(total, "totalTokens");
	const latestUsed = directUsed ?? nestedUsed;
	if (latestUsed === null) {
		return null;
	}
	const previous = current.tokenUsage;
	const firstUsed = previous?.firstUsed ?? latestUsed;
	return makeActivity(
		entry,
		{
			kind: current.kind,
			label: current.label,
			detail: current.detail,
			tokenUsage: {
				firstUsed,
				latestUsed,
				used: Math.max(0, latestUsed - firstUsed),
				contextSize:
					getNumberField(update, "size") ??
					getNumberField(tokenUsage, "modelContextWindow"),
				line: entry.line,
				timestamp: entry.timestamp,
			},
		},
		current,
	);
};

const getToolActivity = (
	entry: SandboxAgentActivityStreamMessage,
	update: Record<string, unknown>,
): SandboxAgentActivity => {
	const rawInput =
		update.rawInput && typeof update.rawInput === "object"
			? (update.rawInput as Record<string, unknown>)
			: null;
	const rawTitle = getStringField(update, "title");
	const server = getStringField(rawInput, "server");
	const tool = getStringField(rawInput, "tool");
	const combined = `${rawTitle} ${server} ${tool}`.toLowerCase();

	if (
		rawTitle === "Terminal" ||
		combined.includes("terminal") ||
		looksLikeCommandTitle(rawTitle)
	) {
		return makeActivity(entry, {
			kind: "command",
			label: "Command",
			detail:
				trimSummary(rawTitle || getTextContent(update.rawInput), 120) ||
				undefined,
		});
	}

	if (
		combined.includes("web") ||
		combined.includes("search_query") ||
		combined.includes("image_query")
	) {
		const isSearch =
			combined.includes("search") || combined.includes("query");
		return makeActivity(entry, {
			kind: "web",
			label: isSearch ? "Web Search" : "Web",
			detail: extractWebDetail(rawInput) || undefined,
		});
	}

	if (combined.includes("skill")) {
		return makeActivity(entry, {
			kind: "tool",
			label: "Skill",
			detail: rawTitle ? trimSummary(rawTitle, 120) : undefined,
		});
	}

	const normalizedTitle = normalizeToolTitle(rawTitle);
	return makeActivity(entry, {
		kind: "tool",
		label: normalizedTitle.label,
		detail: trimSummary(normalizedTitle.detail, 120) || undefined,
	});
};

export const getSandboxAgentActivityFromMessage = (
	entry: SandboxAgentActivityStreamMessage,
	current: SandboxAgentActivity = idleSandboxAgentActivity,
): SandboxAgentActivity => {
	const message = entry.message;
	const method = typeof message.method === "string" ? message.method : "";
	const params =
		message.params && typeof message.params === "object"
			? (message.params as Record<string, unknown>)
			: {};

	if (method === "session/prompt") {
		return makeActivity(
			entry,
			{
				kind: "prompt",
				label: "Prompt",
			},
			current,
		);
	}

	if (method === "session/update") {
		const update =
			params.update && typeof params.update === "object"
				? (params.update as Record<string, unknown>)
				: {};
		const sessionUpdate = getStringField(update, "sessionUpdate");

			if (sessionUpdate === "agent_message_chunk") {
				return makeActivity(
					entry,
					{
						kind: "writing",
						label: "Writing",
					},
					current,
				);
			}

			if (sessionUpdate === "tool_call") {
				return {
					...getToolActivity(entry, update),
					tokenUsage: current.tokenUsage,
				};
			}

			if (sessionUpdate === "plan") {
				return makeActivity(
					entry,
					{
						kind: "planning",
						label: "Planning",
						detail: trimSummary(getTextContent(update.content), 120) || undefined,
					},
					current,
				);
			}

			if (sessionUpdate === "usage_update") {
				return getUsageUpdate(entry, update, current) || current;
			}

		return current;
	}

	if (method === "item/started") {
		const item =
			params.item && typeof params.item === "object"
				? (params.item as Record<string, unknown>)
				: {};
		const itemType = getStringField(item, "type");

			if (itemType === "commandExecution") {
				return makeActivity(
					entry,
					{
						kind: "command",
						label: "Command",
						detail: trimSummary(getStringField(item, "command"), 120) || undefined,
					},
					current,
				);
			}

			if (itemType === "reasoning") {
				return makeActivity(
					entry,
					{
						kind: "reasoning",
						label: "Reasoning",
					},
					current,
				);
			}
	}

	if (
		method === "item/reasoning/textDelta" ||
		method === "item/reasoning/summaryTextDelta"
	) {
		return makeActivity(
			entry,
			{
				kind: "reasoning",
				label: "Reasoning",
			},
			current,
		);
	}

	if (method === "item/agentMessage/delta") {
		return makeActivity(
			entry,
			{
				kind: "writing",
				label: "Writing",
			},
			current,
		);
	}

	if (method === "error") {
		const error =
			params.error && typeof params.error === "object"
				? (params.error as Record<string, unknown>)
				: {};
		return makeActivity(
			entry,
			{
				kind: "error",
				label: "Error",
				detail:
					trimSummary(
						getStringField(error, "message") || getStringField(params, "message"),
						120,
					) || undefined,
			},
			current,
		);
	}

	return current;
};

export const deriveSandboxAgentActivity = (
	messages: SandboxAgentActivityStreamMessage[],
	initial: SandboxAgentActivity = idleSandboxAgentActivity,
) =>
	messages.reduce(
		(current, message) => getSandboxAgentActivityFromMessage(message, current),
		initial,
	);

export const areSandboxAgentActivitiesEqual = (
	left: SandboxAgentActivity,
	right: SandboxAgentActivity,
) =>
	left.kind === right.kind &&
	left.label === right.label &&
	left.detail === right.detail &&
	left.line === right.line &&
	left.timestamp === right.timestamp &&
	left.tokenUsage?.used === right.tokenUsage?.used &&
	left.tokenUsage?.latestUsed === right.tokenUsage?.latestUsed;
