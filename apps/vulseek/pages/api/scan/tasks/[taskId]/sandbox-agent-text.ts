import { promises as fs } from "node:fs";
import {
	findSandboxAgentTaskRuntimeByTaskId,
	findScanJobOrganizationId,
	validateRequest,
} from "@vulseek/server";
import type { NextApiRequest, NextApiResponse } from "next";
import { getFileStreamBuffer } from "@/server/utils/file-stream-buffer";

const sendEvent = (
	res: NextApiResponse,
	event: string,
	payload: Record<string, unknown>,
) => {
	res.write(`event: ${event}\n`);
	res.write(`data: ${JSON.stringify(payload)}\n\n`);
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

	let textExists = false;
	let textStatError: string | null = null;
	try {
		await fs.stat(runtime.textPath);
		textExists = true;
	} catch (error) {
		textStatError =
			error instanceof Error ? error.message : "Unable to stat text file";
	}

	const metadata = {
		taskId: runtime.taskId,
		scanJobId: runtime.scanJobId,
		taskKind: runtime.taskKind,
		containerName: runtime.containerName,
		baseUrl: runtime.baseUrl,
		provider: runtime.provider,
		status: runtime.status,
		textPath: runtime.textPath,
		textExists,
		textStatError,
	};

	if (!textExists) {
		sendEvent(res, "stream_error", {
			message: "Sandbox agent text file is not visible to this API process",
			taskId: runtime.taskId,
			textPath: runtime.textPath,
			textExists,
			textStatError,
		});
	}

	const buffer = getFileStreamBuffer(runtime.textPath);
	let lastText = (await buffer.getSnapshot()).content;
	sendEvent(res, "snapshot", { metadata, text: lastText });

	const cleanup = () => {
		unsubscribe();
		clearInterval(heartbeat);
		clearInterval(statusPoll);
	};

	const unsubscribe = buffer.subscribe((event) => {
		try {
			if (event.type === "append") {
				lastText += event.content;
				sendEvent(res, "append", { text: event.content });
				return;
			}

			lastText = event.content;
			sendEvent(res, "snapshot", { metadata, text: lastText });
		} catch (error) {
			sendEvent(res, "stream_error", {
				message:
					error instanceof Error ? error.message : "Unknown stream error",
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
				message:
					error instanceof Error ? error.message : "Unknown stream error",
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
