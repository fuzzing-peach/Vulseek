import {
	findApplicationById,
	findComposeById,
	findScanJobById,
	findVulnerabilityCandidateById,
	getCandidateAnalysisAppServerTextPath,
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

const isStage = (value: string): value is "analyzing" | "fuzzing" =>
	value === "analyzing" || value === "fuzzing";

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

	const currentCandidateStage = isStage(candidate.currentStage)
		? candidate.currentStage
		: "analyzing";
	let activeStage = currentCandidateStage;

	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache, no-transform",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
	});
	res.flushHeaders?.();

	const textPath = await getCandidateAnalysisAppServerTextPath(
		scanJob.scanJobId,
		candidate.vulnerabilityCandidateId,
	);
	if (!textPath) {
		res.status(404).json({ message: "Candidate runtime log not found" });
		return;
	}

	const buffer = getFileStreamBuffer(textPath);
	let lastText = (await buffer.getSnapshot()).content;
	sendEvent(res, "snapshot", { text: lastText, stage: activeStage });

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
					stage: activeStage,
				});
				return;
			}

			lastText = event.content;
			sendEvent(res, "snapshot", { text: lastText, stage: activeStage });
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
			activeStage = isStage(latestCandidate.currentStage)
				? latestCandidate.currentStage
				: "analyzing";

			if (
				latestCandidate.status === "completed" ||
				latestCandidate.status === "failed"
			) {
				sendEvent(res, "done", {
					status: latestCandidate.status,
					stage: activeStage,
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
