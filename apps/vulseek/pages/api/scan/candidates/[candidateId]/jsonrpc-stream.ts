import {
	findApplicationById,
	findComposeById,
	findScanJobById,
	findVulnerabilityCandidateById,
	getCandidateAnalysisAppServerJsonlPath,
	getCandidateVerifierAppServerJsonlPath,
	validateRequest,
} from "@vulseek/server";
import type { NextApiRequest, NextApiResponse } from "next";
import { getFileStreamBuffer } from "@/server/utils/file-stream-buffer";
import {
	advanceJsonRpcParseState,
	JSONRPC_INCREMENTAL_ONLY_SNAPSHOT_MAX_BYTES,
	parseJsonRpcChunk,
	parseJsonRpcSnapshot,
	type JsonRpcStreamMessage,
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
			messages: [] as JsonRpcStreamMessage[],
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

const resolveStage = (value: string | string[] | undefined) =>
	value === "verifying" ? "verifying" : "analyzing";

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

	const candidateId = req.query.candidateId;
	if (typeof candidateId !== "string") {
		res.status(400).json({ message: "Invalid candidate id" });
		return;
	}

	const requestedStage = resolveStage(req.query.stage);
	const candidate = await findVulnerabilityCandidateById(candidateId);
	const scanJob = await findScanJobById(candidate.scanJobId);

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

	const filePath =
		requestedStage === "verifying"
			? await getCandidateVerifierAppServerJsonlPath(
					scanJob.scanJobId,
					candidate.vulnerabilityCandidateId,
				)
			: await getCandidateAnalysisAppServerJsonlPath(
					scanJob.scanJobId,
					candidate.vulnerabilityCandidateId,
				);
	if (!filePath) {
		res.status(404).json({ message: "Candidate runtime log not found" });
		return;
	}
	const buffer = getFileStreamBuffer(filePath);
	const snapshot = await buffer.getSnapshot();
	const parseState = { nextLine: 0, pending: "" };
	let { messages: lastMessages, incrementalOnly } = buildSnapshotPayload(
		snapshot.content,
		parseState,
		snapshot.offset,
	);
	sendEvent(res, "snapshot", {
		stage: requestedStage,
		messages: lastMessages as JsonRpcStreamMessage[],
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
						stage: requestedStage,
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
				stage: requestedStage,
				messages: lastMessages as JsonRpcStreamMessage[],
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
			const latestCandidate = await findVulnerabilityCandidateById(candidateId);
			if (
				latestCandidate.status === "completed" ||
				latestCandidate.status === "failed"
			) {
				sendEvent(res, "done", {
					status: latestCandidate.status,
					stage: requestedStage,
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
