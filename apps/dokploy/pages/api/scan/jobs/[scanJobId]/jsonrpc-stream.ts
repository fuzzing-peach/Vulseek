import {
	findApplicationById,
	findComposeById,
	findScanJobById,
	readScanJobAppServerMessages,
	validateRequest,
} from "@dokploy/server";
import type { NextApiRequest, NextApiResponse } from "next";

type StreamMessage = {
	line: number;
	message: Record<string, unknown>;
};

const sendEvent = (
	res: NextApiResponse,
	event: string,
	payload: Record<string, unknown>,
) => {
	res.write(`event: ${event}\n`);
	res.write(`data: ${JSON.stringify(payload)}\n\n`);
};

const toStreamMessages = (messages: Record<string, unknown>[]): StreamMessage[] =>
	messages.map((message, index) => ({
		line: index + 1,
		message,
	}));

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

	let lastMessages = await readScanJobAppServerMessages(scanJobId);
	sendEvent(res, "snapshot", {
		messages: toStreamMessages(lastMessages as Record<string, unknown>[]),
	});

	const cleanup = () => {
		clearInterval(heartbeat);
		clearInterval(poll);
	};

	const heartbeat = setInterval(() => {
		res.write(": keepalive\n\n");
	}, 15000);

	const poll = setInterval(async () => {
		try {
			const nextMessages = await readScanJobAppServerMessages(scanJobId);
			if (nextMessages.length !== lastMessages.length) {
				if (
					nextMessages.length >= lastMessages.length &&
					lastMessages.every(
						(message, index) =>
							JSON.stringify(message) === JSON.stringify(nextMessages[index]),
					)
				) {
					sendEvent(res, "append", {
						messages: toStreamMessages(
							nextMessages.slice(lastMessages.length) as Record<string, unknown>[],
						),
					});
				} else {
					sendEvent(res, "snapshot", {
						messages: toStreamMessages(nextMessages as Record<string, unknown>[]),
					});
				}
				lastMessages = nextMessages;
			}

			const latestScanJob = await findScanJobById(scanJobId);
			if (
				latestScanJob.status === "completed" ||
				latestScanJob.status === "failed"
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
