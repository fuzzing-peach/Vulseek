import {
	findApplicationById,
	findComposeById,
	findScanJobById,
	getScanJobAppServerTextPath,
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

	const buffer = getFileStreamBuffer(getScanJobAppServerTextPath(scanJobId));
	let lastText = (await buffer.getSnapshot()).content;
	sendEvent(res, "snapshot", { text: lastText });

	const cleanup = () => {
		unsubscribe();
		clearInterval(heartbeat);
		clearInterval(statusPoll);
	};

	const unsubscribe = buffer.subscribe((event) => {
		try {
			if (event.type === "append") {
				lastText += event.content;
				sendEvent(res, "append", {
					text: event.content,
				});
				return;
			}

			lastText = event.content;
			sendEvent(res, "snapshot", { text: lastText });
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
