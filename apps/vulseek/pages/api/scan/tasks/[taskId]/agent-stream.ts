import {
	findAgentStreamRuntimeByTaskId,
	findScanJobOrganizationId,
	validateRequest,
} from "@vulseek/server";
import type { NextApiRequest, NextApiResponse } from "next";
import { getFileStreamBuffer } from "@/server/utils/file-stream-buffer";

const SNAPSHOT_CHUNK_SIZE = 64 * 1024;

const isLiveStatus = (status: string | null | undefined) =>
	status === "launching" ||
	status === "launched" ||
	status === "starting" ||
	status === "running";

const sendEvent = (res: NextApiResponse, event: string, payload: unknown) => {
	res.write(`event: ${event}\n`);
	res.write(`data: ${JSON.stringify(payload)}\n\n`);
};

const sendSnapshot = (
	res: NextApiResponse,
	content: string,
	metadata: Record<string, unknown>,
) => {
	sendEvent(res, "snapshot_start", metadata);
	for (let offset = 0; offset < content.length; offset += SNAPSHOT_CHUNK_SIZE) {
		sendEvent(res, "chunk", {
			text: content.slice(offset, offset + SNAPSHOT_CHUNK_SIZE),
			offset,
		});
	}
	sendEvent(res, "snapshot_end", { length: content.length });
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

	const { user, session } = await validateRequest(req);
	if (!user || !session) {
		res.status(401).json({ message: "Unauthorized" });
		return;
	}
	const streamRuntime = await findAgentStreamRuntimeByTaskId(taskId);
	if (!streamRuntime) {
		res.status(404).json({ message: "Task not found" });
		return;
	}

	const organizationId = await findScanJobOrganizationId(
		streamRuntime.runtime.scanJobId,
	);
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

	let closed = false;
	let activePath: string | null = null;
	let unsubscribe: (() => void) | null = null;
	let statusPoll: NodeJS.Timeout | null = null;
	let heartbeat: NodeJS.Timeout | null = null;
	let polling = false;

	const cleanup = () => {
		closed = true;
		unsubscribe?.();
		unsubscribe = null;
		if (statusPoll) clearInterval(statusPoll);
		if (heartbeat) clearInterval(heartbeat);
	};

	const metadata = (current: typeof streamRuntime) => ({
		taskId: current.runtime.taskId,
		scanJobId: current.runtime.scanJobId,
		provider: current.provider,
		threadId: current.threadId,
		status: current.runtime.status,
	});

	sendEvent(res, "metadata", metadata(streamRuntime));

	const attachTranscript = async (current: typeof streamRuntime) => {
		if (
			closed ||
			!current.transcriptPath ||
			current.transcriptPath === activePath
		) {
			return Boolean(activePath);
		}

		unsubscribe?.();
		const transcriptPath = current.transcriptPath;
		activePath = transcriptPath;
		const buffer = getFileStreamBuffer(transcriptPath);
		const snapshot = await buffer.getSnapshot();
		if (closed) return true;
		sendSnapshot(res, snapshot.content, metadata(current));
		unsubscribe = buffer.subscribe((event) => {
			if (closed) return;
			if (event.type === "append") {
				sendEvent(res, "append", {
					text: event.content,
					offset: event.offset,
				});
				return;
			}
			sendSnapshot(res, event.content, metadata(current));
		});
		return true;
	};

	if (!streamRuntime.threadId || !streamRuntime.transcriptPath) {
		sendEvent(res, "waiting", {
			reason: streamRuntime.threadId ? "transcript_not_found" : "thread_id",
		});
	} else {
		await attachTranscript(streamRuntime);
	}

	const poll = async () => {
		if (closed || polling) return;
		polling = true;
		try {
			const current = await findAgentStreamRuntimeByTaskId(taskId);
			if (!current) {
				sendEvent(res, "stream_error", { code: "task_not_found" });
				cleanup();
				res.end();
				return;
			}
			if (current.transcriptPath) {
				await attachTranscript(current);
			} else if (!activePath) {
				sendEvent(res, "waiting", {
					reason: current.threadId ? "transcript_not_found" : "thread_id",
				});
			}
			if (!isLiveStatus(current.runtime.status)) {
				if (!activePath) {
					sendEvent(res, "stream_error", {
						code: "source_unavailable",
						message: "Native agent transcript is unavailable",
					});
				}
				sendEvent(res, "done", {
					status: current.runtime.status,
					taskId,
				});
				cleanup();
				res.end();
			}
		} catch (error) {
			sendEvent(res, "stream_error", {
				code: "stream_failure",
				message:
					error instanceof Error ? error.message : "Unknown stream error",
			});
			cleanup();
			res.end();
		} finally {
			polling = false;
		}
	};

	heartbeat = setInterval(() => {
		if (!closed) res.write(": keepalive\n\n");
	}, 15_000);
	statusPoll = setInterval(() => void poll(), 1_000);
	req.on("close", () => {
		cleanup();
		if (!res.writableEnded) res.end();
	});
}
