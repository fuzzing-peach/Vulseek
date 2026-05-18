const PARENT_PROMPT_CHAR_LIMIT = 8000;
const ASSISTANT_TAIL_CHAR_LIMIT = 30000;
const TOOL_OUTPUT_CHAR_LIMIT = 2000;
const MANUAL_REPLAY_CHAR_LIMIT = 80000;

type PersistEvent = {
	payload?: unknown;
	[key: string]: unknown;
};

export type ManualReplayStats = {
	parentEventCount: number;
	manualReplayTextBytes: number;
	manualReplayTruncatedBytes: number;
	toolOutputCharsKept: number;
	promptContainsJsonRpcReplay: false;
};

export type ManualReplayResult = {
	text: string;
	stats: ManualReplayStats;
};

const asRecord = (value: unknown) =>
	value && typeof value === "object" ? (value as Record<string, unknown>) : null;

const asString = (value: unknown) => (typeof value === "string" ? value : "");

const byteLength = (value: string) => Buffer.byteLength(value, "utf-8");

const clipHead = (value: string, limit: number) =>
	value.length > limit ? value.slice(0, limit) : value;

const clipTail = (value: string, limit: number) =>
	value.length > limit ? value.slice(value.length - limit) : value;

const truncateWithNote = (value: string, limit: number) => {
	if (value.length <= limit) {
		return value;
	}
	if (limit <= 32) {
		return value.slice(0, Math.max(0, limit));
	}
	return `${value.slice(0, limit - 32)}\n...[truncated]`;
};

const extractTextValue = (value: unknown): string => {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(extractTextValue).join("");
	const record = asRecord(value);
	if (!record) return "";
	return [record.text, record.value, record.content]
		.map(extractTextValue)
		.find(Boolean) || "";
};

const extractPayloadText = (payload: unknown): string => {
	if (typeof payload === "string") return payload;
	if (Array.isArray(payload)) {
		return payload.map(extractPayloadText).join("");
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

const getEventPayloadRecord = (event: PersistEvent) => asRecord(event.payload);

const getEventParamsRecord = (event: PersistEvent) =>
	asRecord(getEventPayloadRecord(event)?.params);

const getEventUpdate = (event: PersistEvent) => {
	const paramsUpdate = getEventParamsRecord(event)?.update;
	return paramsUpdate !== undefined ? paramsUpdate : event.payload;
};

const extractPromptText = (event: PersistEvent) => {
	const payload = getEventPayloadRecord(event);
	if (asString(payload?.method) !== "session/prompt") {
		return "";
	}
	const prompt = asRecord(payload?.params)?.prompt;
	if (!Array.isArray(prompt)) {
		return "";
	}
	return prompt
		.map((item) => extractTextValue(asRecord(item)?.text))
		.join("");
};

const extractPathValue = (record: Record<string, unknown>, keys: string[]) => {
	for (const key of keys) {
		const parts = key.split(".");
		let current: unknown = record;
		for (const part of parts) {
			current = asRecord(current)?.[part];
		}
		const value = extractTextValue(current);
		if (value) return value;
	}
	return "";
};

const simplifyToolCall = (update: Record<string, unknown>) => {
	const lines: string[] = [];
	const title =
		asString(update.title) ||
		asString(update.name) ||
		asString(update.tool) ||
		"tool";
	const kind = asString(update.kind) || asString(update.type);
	const status = asString(update.status);
	lines.push(
		[
			`tool: ${title}`,
			kind ? `kind=${kind}` : "",
			status ? `status=${status}` : "",
		]
			.filter(Boolean)
			.join(" "),
	);

	const command = extractPathValue(update, [
		"command",
		"cmd",
		"rawInput.command",
		"rawInput.cmd",
		"input.command",
		"action.command",
	]);
	const cwd = extractPathValue(update, [
		"cwd",
		"rawInput.cwd",
		"input.cwd",
		"action.cwd",
	]);
	const filePath = extractPathValue(update, [
		"path",
		"filePath",
		"rawInput.path",
		"input.path",
	]);
	if (command) lines.push(`command: ${truncateWithNote(command, 500)}`);
	if (cwd) lines.push(`cwd: ${truncateWithNote(cwd, 300)}`);
	if (filePath) lines.push(`path: ${truncateWithNote(filePath, 300)}`);
	return lines.join("\n");
};

const summarizeRawOutput = (rawOutput: unknown, limit: number) => {
	const record = asRecord(rawOutput);
	if (!record) {
		return truncateWithNote(extractTextValue(rawOutput), limit);
	}
	const lines: string[] = [];
	const exitCode = record.exit_code ?? record.exitCode ?? record.code;
	const status = asString(record.status);
	if (exitCode !== undefined) lines.push(`exit_code: ${String(exitCode)}`);
	if (status) lines.push(`status: ${status}`);
	const stderr = extractTextValue(record.stderr);
	if (stderr) lines.push(`stderr:\n${truncateWithNote(stderr, 600)}`);
	const stdout =
		extractTextValue(record.stdout) ||
		extractTextValue(record.aggregated_output) ||
		extractTextValue(record.aggregatedOutput) ||
		extractTextValue(record.output);
	if (stdout) lines.push(`output:\n${truncateWithNote(stdout, limit)}`);
	return truncateWithNote(lines.join("\n"), limit);
};

const buildToolText = (events: PersistEvent[]) => {
	const entries: string[] = [];
	let toolOutputCharsKept = 0;
	for (const event of events) {
		const update = getEventUpdate(event);
		const record = asRecord(update);
		const updateType = asString(record?.sessionUpdate);
		if (!record || (updateType !== "tool_call" && updateType !== "tool_call_update")) {
			continue;
		}
		const lines = [simplifyToolCall(record)];
		if (updateType === "tool_call_update") {
			const rawOutput =
				record.rawOutput ?? record.output ?? record.content ?? record.result;
			const outputText = summarizeRawOutput(rawOutput, TOOL_OUTPUT_CHAR_LIMIT);
			if (outputText) {
				toolOutputCharsKept += outputText.length;
				lines.push(`output summary:\n${outputText}`);
			}
		}
		entries.push(lines.filter(Boolean).join("\n"));
	}
	return {
		text: entries.join("\n\n"),
		toolOutputCharsKept,
	};
};

const fitReplayText = (input: {
	parentPromptText: string;
	assistantText: string;
	assistantHasMarkers: boolean;
	toolText: string;
}) => {
	let parentPromptText = input.parentPromptText;
	let assistantText = input.assistantText;
	let toolText = input.toolText;

	const render = () =>
		[
			"Previous parent task context follows. Treat it as read-only context. The current task below is authoritative.",
			"<parent_context>",
			parentPromptText ? `Parent task prompt:\n${parentPromptText}` : "",
			assistantText ? `Assistant result/context:\n${assistantText}` : "",
			toolText ? `Tool activity summary:\n${toolText}` : "",
			"</parent_context>",
		]
			.filter(Boolean)
			.join("\n\n");

	let text = render();
	const initialBytes = byteLength(text);
	if (text.length <= MANUAL_REPLAY_CHAR_LIMIT) {
		return {
			text,
			truncatedBytes: 0,
		};
	}

	let excess = text.length - MANUAL_REPLAY_CHAR_LIMIT;
	if (toolText && excess > 0) {
		const nextLimit = Math.max(0, toolText.length - excess);
		toolText = truncateWithNote(toolText, nextLimit);
		text = render();
		excess = text.length - MANUAL_REPLAY_CHAR_LIMIT;
	}
	if (parentPromptText && excess > 0) {
		const nextLimit = Math.max(0, parentPromptText.length - excess);
		parentPromptText = truncateWithNote(parentPromptText, nextLimit);
		text = render();
		excess = text.length - MANUAL_REPLAY_CHAR_LIMIT;
	}
	if (assistantText && !input.assistantHasMarkers && excess > 0) {
		const nextLimit = Math.max(0, assistantText.length - excess);
		assistantText = clipTail(assistantText, nextLimit);
		text = render();
	}
	if (text.length > MANUAL_REPLAY_CHAR_LIMIT) {
		text = truncateWithNote(text, MANUAL_REPLAY_CHAR_LIMIT);
	}

	return {
		text,
		truncatedBytes: Math.max(0, initialBytes - byteLength(text)),
	};
};

export const buildSandboxAgentManualReplayText = (
	parentEvents: PersistEvent[],
): ManualReplayResult => {
	const parentPromptText = clipHead(
		parentEvents
			.map(extractPromptText)
			.filter(Boolean)
			.join("\n\n---\n\n"),
		PARENT_PROMPT_CHAR_LIMIT,
	);
	const assistantFullText = parentEvents
		.map((event) => {
			const update = getEventUpdate(event);
			const record = asRecord(update);
			return asString(record?.sessionUpdate) === "agent_message_chunk"
				? extractPayloadText(update)
				: "";
		})
		.join("");
	const assistantText = clipTail(assistantFullText, ASSISTANT_TAIL_CHAR_LIMIT);
	const toolSummary = buildToolText(parentEvents);
	const fitted = fitReplayText({
		parentPromptText,
		assistantText,
		assistantHasMarkers: false,
		toolText: toolSummary.text,
	});

	return {
		text: fitted.text,
		stats: {
			parentEventCount: parentEvents.length,
			manualReplayTextBytes: byteLength(fitted.text),
			manualReplayTruncatedBytes: fitted.truncatedBytes,
			toolOutputCharsKept: toolSummary.toolOutputCharsKept,
			promptContainsJsonRpcReplay: false,
		},
	};
};
