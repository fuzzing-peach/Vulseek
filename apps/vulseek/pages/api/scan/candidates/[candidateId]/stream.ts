import {
	deriveCandidateTaskExecutionState,
	findApplicationById,
	findCandidateTaskLineage,
	findComposeById,
	findScanJobById,
	findVulnerabilityCandidateById,
	getCandidateAnalysisAppServerTextPath,
	getCandidateVerifierAppServerTextPath,
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

	const deriveExecutionState = async () => {
		const lineage = await findCandidateTaskLineage({
			vulnerabilityCandidateId: candidateId,
			scanJobId: candidate.scanJobId,
			producerTaskId: candidate.producerTaskId || undefined,
		});
		return deriveCandidateTaskExecutionState(
			lineage.tasks
				.filter((task) => task.relation === "candidate")
				.map((task) => ({
					taskId: task.taskId,
					stageName: task.stageName,
					status: task.status,
					createdAt: task.createdAt,
				})),
		);
	};
	const executionState = await deriveExecutionState();
	let activePhase =
		executionState.activePhase || executionState.latestPhase || "analysis";
	let activeStage =
		executionState.activeTask?.stageName ||
		executionState.latestTask?.stageName ||
		"analyze-finding";

	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache, no-transform",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
	});
	res.flushHeaders?.();

	const textPath =
		activePhase === "verification"
			? await getCandidateVerifierAppServerTextPath(
					scanJob.scanJobId,
					candidate.vulnerabilityCandidateId,
				)
			: await getCandidateAnalysisAppServerTextPath(
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
			const latestExecutionState = await deriveExecutionState();
			activePhase =
				latestExecutionState.activePhase ||
				latestExecutionState.latestPhase ||
				"analysis";
			activeStage =
				latestExecutionState.activeTask?.stageName ||
				latestExecutionState.latestTask?.stageName ||
				"analyze-finding";

			if (!latestExecutionState.activeTask && latestExecutionState.latestTask) {
				sendEvent(res, "done", {
					status: latestExecutionState.latestTask.status,
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
