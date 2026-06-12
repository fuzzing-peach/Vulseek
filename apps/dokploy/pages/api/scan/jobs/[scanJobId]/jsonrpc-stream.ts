import {
	findApplicationById,
	findComposeById,
	findScanJobById,
	getScanJobAppServerJsonlPath,
	validateRequest,
} from "@dokploy/server";
import type { NextApiRequest, NextApiResponse } from "next";
import { getFileStreamBuffer } from "@/server/utils/file-stream-buffer";
import {
	advanceJsonRpcParseState,
	JSONRPC_INCREMENTAL_ONLY_SNAPSHOT_MAX_BYTES,
	parseJsonRpcChunk,
	parseJsonRpcSnapshot,
	type JsonRpcStreamMessage as StreamMessage,
} from "@/server/utils/jsonrpc-stream";

const SNAPSHOT_MAX_MESSAGES = 400;

const buildSnapshotPayload = (
	content: string,
	parseState: { nextLine: number; pending: string },
	offset: number,
) => {
	if (offset > JSONRPC_INCREMENTAL_ONLY_SNAPSHOT_MAX_BYTES) {
		advanceJsonRpcParseState(content, parseState);
		return {
			messages: [] as StreamMessage[],
			incrementalOnly: true,
		};
	}

	return {
		messages: parseJsonRpcSnapshot(content, parseState, SNAPSHOT_MAX_MESSAGES),
		incrementalOnly: false,
	};
};

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

	const { user, session } = await validateRequest(req);
	if (!user || !session) {
		res.status(401).json({ message: "Unauthorized" });
		return;
	}

	const scanJobId = req.query.scanJobId;
	if (typeof scanJobId !== "string") {
		res.status(400).json({ message: "Invalid scan job id" });
		return;
	}

	const scanJob = await findScanJobById(scanJobId);
	let organizationId = "";
	if (scanJob.applicationId) {
		const application = await findApplicationById(scanJob.applicationId);
		organizationId = application.environment.project.organizationId;
	}
	if (scanJob.composeId) {
		const compose = await findComposeById(scanJob.composeId);
		organizationId = compose.environment.project.organizationId;
	}

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

	const buffer = getFileStreamBuffer(
		await getScanJobAppServerJsonlPath(scanJobId),
	);
	const snapshot = await buffer.getSnapshot();
	const parseState = { nextLine: 0, pending: "" };
	let { messages: lastMessages, incrementalOnly } = buildSnapshotPayload(
		snapshot.content,
		parseState,
		snapshot.offset,
	);
	sendEvent(res, "snapshot", {
		messages: lastMessages as StreamMessage[],
		incrementalOnly,
	});

	const cleanup = () => {
		unsubscribe();
		clearInterval(heartbeat);
		clearInterval(statusPoll);
	};

	const unsubscribe = buffer.subscribe((event) => {
		try {
			if (event.type === "append") {
				const appendedMessages = parseJsonRpcChunk(event.content, parseState);
				if (appendedMessages.length > 0) {
					lastMessages = [...lastMessages, ...appendedMessages];
					sendEvent(res, "append", {
						messages: appendedMessages,
					});
				}
				return;
			}

			parseState.nextLine = 0;
			parseState.pending = "";
			const snapshotPayload = buildSnapshotPayload(
				event.content,
				parseState,
				event.offset,
			);
			lastMessages = snapshotPayload.messages;
			sendEvent(res, "snapshot", {
				messages: lastMessages as StreamMessage[],
				incrementalOnly: snapshotPayload.incrementalOnly,
			});
		} catch (error) {
			sendEvent(res, "error", {
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
			const latestScanJob = await findScanJobById(scanJobId);
			if (
				latestScanJob.status === "finished" ||
				latestScanJob.status === "canceled" ||
				latestScanJob.status === "paused"
			) {
				sendEvent(res, "done", {
					status: latestScanJob.status,
					errorMessage: latestScanJob.errorMessage || "",
				});
				cleanup();
				res.end();
			}
		} catch (error) {
			sendEvent(res, "error", {
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
