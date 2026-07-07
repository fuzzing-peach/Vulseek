export type JsonRpcStreamMessage = {
	line: number;
	timestamp?: string;
	message: Record<string, unknown>;
};

export const JSONRPC_INCREMENTAL_ONLY_SNAPSHOT_MAX_BYTES =
	5 * 1024 * 1024;

export const parseJsonRpcMessageLine = (
	raw: string,
): { timestamp?: string; message: Record<string, unknown> } => {
	const parsed = JSON.parse(raw) as unknown;
	if (
		parsed &&
		typeof parsed === "object" &&
		"message" in parsed &&
		(parsed as Record<string, unknown>).message &&
		typeof (parsed as Record<string, unknown>).message === "object"
	) {
		return {
			timestamp:
				typeof (parsed as Record<string, unknown>).timestamp === "string"
					? ((parsed as Record<string, unknown>).timestamp as string)
					: undefined,
			message: (parsed as Record<string, unknown>).message as Record<string, unknown>,
		};
	}

	return {
		message: parsed as Record<string, unknown>,
	};
};

export const parseJsonRpcChunk = (
	chunk: string,
	state: { nextLine: number; pending: string },
): JsonRpcStreamMessage[] => {
	const combined = `${state.pending}${chunk}`;
	const segments = combined.split("\n");
	state.pending = segments.pop() || "";

	const messages: JsonRpcStreamMessage[] = [];
	for (const segment of segments) {
		const raw = segment.trim();
		if (!raw) {
			continue;
		}
		state.nextLine += 1;
		const parsed = parseJsonRpcMessageLine(raw);
		messages.push({
			line: state.nextLine,
			timestamp: parsed.timestamp,
			message: parsed.message,
		});
	}

	return messages;
};

export const parseJsonRpcSnapshot = (
	content: string,
	state: { nextLine: number; pending: string },
	maxMessages = 400,
): JsonRpcStreamMessage[] => {
	const segments = content.split("\n");
	state.pending = segments.pop() || "";

	const indexedSegments: Array<{ raw: string; line: number }> = [];
	let nextLine = 0;

	for (const segment of segments) {
		const raw = segment.trim();
		if (!raw) {
			continue;
		}
		nextLine += 1;
		indexedSegments.push({ raw, line: nextLine });
	}

	state.nextLine = nextLine;

	const tailSegments =
		maxMessages > 0 ? indexedSegments.slice(-maxMessages) : indexedSegments;

	return tailSegments.map((entry) => {
		const parsed = parseJsonRpcMessageLine(entry.raw);
		return {
			line: entry.line,
			timestamp: parsed.timestamp,
			message: parsed.message,
		};
	});
};

export const advanceJsonRpcParseState = (
	content: string,
	state: { nextLine: number; pending: string },
) => {
	const segments = content.split("\n");
	state.pending = segments.pop() || "";

	let nextLine = 0;
	for (const segment of segments) {
		if (!segment.trim()) {
			continue;
		}
		nextLine += 1;
	}

	state.nextLine = nextLine;
};
