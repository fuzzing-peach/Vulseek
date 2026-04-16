import {
	findApplicationById,
	findComposeById,
	findScanJobById,
	findVulnerabilityCandidateById,
	readCandidateAnalysisAppServerText,
	validateRequest,
} from "@dokploy/server";
import type { NextApiRequest, NextApiResponse } from "next";

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
	const stage = currentCandidateStage;

	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache, no-transform",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
	});
	res.flushHeaders?.();

	let lastText = await readCandidateAnalysisAppServerText(
		scanJob.scanJobId,
		candidate.vulnerabilityCandidateId,
	);
	sendEvent(res, "snapshot", { text: lastText, stage });

	const cleanup = () => {
		clearInterval(heartbeat);
		clearInterval(poll);
	};

	const heartbeat = setInterval(() => {
		res.write(": keepalive\n\n");
	}, 15000);

	const poll = setInterval(async () => {
		try {
			const latestCandidate = await findVulnerabilityCandidateById(candidateId);
			const activeStage = isStage(latestCandidate.currentStage)
				? latestCandidate.currentStage
				: "analyzing";
			const nextText = await readCandidateAnalysisAppServerText(
				latestCandidate.scanJobId,
				latestCandidate.vulnerabilityCandidateId,
			);
			if (nextText !== lastText) {
				if (nextText.startsWith(lastText)) {
					sendEvent(res, "append", {
						text: nextText.slice(lastText.length),
						stage: activeStage,
					});
				} else {
					sendEvent(res, "snapshot", { text: nextText, stage: activeStage });
				}
				lastText = nextText;
			}

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
