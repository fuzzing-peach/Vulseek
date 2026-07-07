import {
	findScanJobOrganizationId,
	findSandboxAgentTaskRuntimeByTaskId,
	validateRequest,
} from "@vulseek/server";
import type { NextApiRequest, NextApiResponse } from "next";
import { promises as fs } from "node:fs";
import { getFileStreamBuffer } from "@/server/utils/file-stream-buffer";

type StreamMessage = {
	line: number;
	timestamp?: string;
	message: Record<string, unknown>;
};

type ParseState = {
	nextLine: number;
	pending: string;
};

const sendEvent = (
	res: NextApiResponse,
	event: string,
	payload: unknown,
) => {
	res.write(`event: ${event}\n`);
	res.write(`data: ${JSON.stringify(payload)}\n\n`);
};

const asRecord = (value: unknown) =>
	value && typeof value === "object" ? (value as Record<string, unknown>) : null;

const toStreamMessage = (
	line: number,
	event: Record<string, unknown>,
): StreamMessage | null => {
	const payload = asRecord(event.payload);
	const message = payload || event;
	const createdAt = event.createdAt;
	const timestamp =
		typeof createdAt === "string"
			? createdAt
			: typeof createdAt === "number"
				? new Date(createdAt).toISOString()
				: undefined;
	return {
		line,
		timestamp,
		message,
	};
};

const parseJsonlLines = (
	content: string,
	parseState: ParseState,
	onMessage?: (message: StreamMessage) => void,
): StreamMessage[] => {
	const combined = parseState.pending + content;
	const lines = combined.split("\n");
	parseState.pending = lines.pop() || "";
	const messages: StreamMessage[] = [];

	for (const line of lines) {
		parseState.nextLine += 1;
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}
		try {
			const parsed = JSON.parse(trimmed) as Record<string, unknown>;
			const message = toStreamMessage(parseState.nextLine, parsed);
			if (message) {
				if (onMessage) {
					onMessage(message);
				} else {
					messages.push(message);
				}
			}
		} catch {}
	}

	return messages;
};

const sendSnapshotStream = (
	res: NextApiResponse,
	content: string,
	metadata: Record<string, unknown>,
) => {
	sendEvent(res, "snapshot_start", {
		metadata,
		truncated: false,
	});

	const parseState: ParseState = { nextLine: 0, pending: "" };
	let count = 0;
	parseJsonlLines(content, parseState, (message) => {
		count += 1;
		sendEvent(res, "snapshot_message", message);
	});

	sendEvent(res, "snapshot_end", {
		count,
		truncated: false,
	});

	return parseState;
};

export default async function handler(
	req: NextApiRequest,
	res: NextApiResponse,
) {
	if (req.method !== "GET") {
		res.status(405).json({ message: "Method not allowed" });
		return;
	}

	const taskId = req.query.taskId;
	if (typeof taskId !== "string" || !taskId) {
		res.status(400).json({ message: "Invalid task id" });
		return;
	}

	const [{ user, session }, runtime] = await Promise.all([
		validateRequest(req),
		findSandboxAgentTaskRuntimeByTaskId(taskId),
	]);
	if (!user || !session) {
		res.status(401).json({ message: "Unauthorized" });
		return;
	}
	if (!runtime) {
		res.status(404).json({ message: "Task not found" });
		return;
	}

	const organizationId = await findScanJobOrganizationId(runtime.scanJobId);
	if (!organizationId || organizationId !== session.activeOrganizationId) {
		res.status(403).json({ message: "Forbidden" });
		return;
	}

	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache, no-transform",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
	});
	res.flushHeaders?.();

	let jsonlExists = false;
	let jsonlStatError: string | null = null;
	try {
		await fs.stat(runtime.jsonlPath);
		jsonlExists = true;
	} catch (error) {
		jsonlStatError =
			error instanceof Error ? error.message : "Unable to stat jsonl file";
	}

	const metadata = {
		taskId: runtime.taskId,
		scanJobId: runtime.scanJobId,
		taskKind: runtime.taskKind,
		containerName: runtime.containerName,
		baseUrl: runtime.baseUrl,
		provider: runtime.provider,
		status: runtime.status,
		jsonlPath: runtime.jsonlPath,
		jsonlExists,
		jsonlStatError,
	};

	if (!jsonlExists) {
		sendEvent(res, "stream_error", {
			message: "Sandbox agent event file is not visible to this API process",
			taskId: runtime.taskId,
			jsonlPath: runtime.jsonlPath,
			jsonlExists,
			jsonlStatError,
		});
	}

	const buffer = getFileStreamBuffer(runtime.jsonlPath);
	const snapshot = await buffer.getSnapshot();
	const parseState = sendSnapshotStream(res, snapshot.content, metadata);

	const cleanup = () => {
		unsubscribe();
		clearInterval(heartbeat);
		clearInterval(statusPoll);
	};

	const unsubscribe = buffer.subscribe((event) => {
		try {
			if (event.type === "append") {
				const messages = parseJsonlLines(event.content, parseState);
				if (messages.length > 0) {
					sendEvent(res, "delta", { messages });
				}
				return;
			}

			parseState.nextLine = 0;
			parseState.pending = "";
			const nextParseState = sendSnapshotStream(res, event.content, metadata);
			parseState.nextLine = nextParseState.nextLine;
			parseState.pending = nextParseState.pending;
		} catch (error) {
			sendEvent(res, "stream_error", {
				message: error instanceof Error ? error.message : "Unknown stream error",
			});
			cleanup();
			res.end();
		}
	});

	const heartbeat = setInterval(() => {
		res.write(": keepalive\n\n");
	}, 15000);

	const statusPoll = setInterval(async () => {
		try {
			const latest = await findSandboxAgentTaskRuntimeByTaskId(taskId);
			if (!latest || latest.status !== "running") {
				sendEvent(res, "done", {
					status: latest?.status || "missing",
					taskId,
					taskKind: latest?.taskKind || runtime.taskKind,
				});
				cleanup();
				res.end();
			}
		} catch (error) {
			sendEvent(res, "stream_error", {
				message: error instanceof Error ? error.message : "Unknown stream error",
			});
			cleanup();
			res.end();
		}
	}, 1000);

	req.on("close", () => {
		cleanup();
		res.end();
	});
}
