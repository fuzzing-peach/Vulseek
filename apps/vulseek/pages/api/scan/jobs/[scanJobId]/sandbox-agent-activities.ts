import { promises as fs } from "node:fs";
import {
	findRunningSandboxAgentTaskRuntimesByScanJobId,
	findSandboxAgentTaskRuntimeByTaskId,
	findScanJobOrganizationId,
	findScanJobStatusById,
	type SandboxAgentTaskRuntime,
	validateRequest,
} from "@vulseek/server";
import type { NextApiRequest, NextApiResponse } from "next";
import {
	areSandboxAgentActivitiesEqual,
	deriveSandboxAgentActivity,
	idleSandboxAgentActivity,
	type SandboxAgentActivity,
	type SandboxAgentActivityStreamMessage,
} from "@/lib/scan/sandbox-agent-activity";
import {
	clearFileStreamBuffer,
	getFileStreamBuffer,
} from "@/server/utils/file-stream-buffer";

type ParseState = {
	nextLine: number;
	pending: string;
};

type ActivityMetadata = {
	taskId: string;
	scanJobId: string;
	taskKind: string;
	containerName?: string | null;
	baseUrl?: string | null;
	provider?: "codex" | "claude";
	status?: string;
	jsonlExists?: boolean;
	jsonlStatError?: string | null;
};

type TaskActivitySubscription = {
	runtime: SandboxAgentTaskRuntime;
	metadata: ActivityMetadata;
	parseState: ParseState;
	currentActivity: SandboxAgentActivity;
	unsubscribe: () => void;
};

const sendEvent = (
	res: NextApiResponse,
	event: string,
	payload: Record<string, unknown>,
) => {
	res.write(`event: ${event}\n`);
	res.write(`data: ${JSON.stringify(payload)}\n\n`);
};

const asRecord = (value: unknown) =>
	value && typeof value === "object"
		? (value as Record<string, unknown>)
		: null;

const toStreamMessage = (
	line: number,
	event: Record<string, unknown>,
): SandboxAgentActivityStreamMessage | null => {
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
): SandboxAgentActivityStreamMessage[] => {
	const combined = parseState.pending + content;
	const lines = combined.split("\n");
	parseState.pending = lines.pop() || "";
	const messages: SandboxAgentActivityStreamMessage[] = [];

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
				messages.push(message);
			}
		} catch {}
	}

	return messages;
};

const buildMetadata = async (
	runtime: SandboxAgentTaskRuntime,
): Promise<ActivityMetadata> => {
	let jsonlExists = false;
	let jsonlStatError: string | null = null;
	try {
		await fs.stat(runtime.jsonlPath);
		jsonlExists = true;
	} catch (error) {
		jsonlStatError =
			error instanceof Error ? error.message : "Unable to stat jsonl file";
	}

	return {
		taskId: runtime.taskId,
		scanJobId: runtime.scanJobId,
		taskKind: runtime.taskKind,
		containerName: runtime.containerName,
		baseUrl: runtime.baseUrl,
		provider: runtime.provider,
		status: runtime.status,
		jsonlExists,
		jsonlStatError,
	};
};

const isTerminalScanStatus = (status: string) =>
	status === "finished" ||
	status === "canceled" ||
	status === "paused" ||
	status === "failed";

export default async function handler(
	req: NextApiRequest,
	res: NextApiResponse,
) {
	if (req.method !== "GET") {
		res.status(405).json({ message: "Method not allowed" });
		return;
	}

	const scanJobId = req.query.scanJobId;
	if (typeof scanJobId !== "string" || !scanJobId) {
		res.status(400).json({ message: "Invalid scan job id" });
		return;
	}

	const [{ user, session }, organizationId] = await Promise.all([
		validateRequest(req),
		findScanJobOrganizationId(scanJobId),
	]);
	if (!user || !session) {
		res.status(401).json({ message: "Unauthorized" });
		return;
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

	const subscriptions = new Map<string, TaskActivitySubscription>();

	const unsubscribeTask = (taskId: string) => {
		const subscription = subscriptions.get(taskId);
		if (!subscription) {
			return;
		}
		subscription.unsubscribe();
		subscriptions.delete(taskId);
	};

	const subscribeTask = async (runtime: SandboxAgentTaskRuntime) => {
		const existing = subscriptions.get(runtime.taskId);
		if (existing) {
			return {
				taskId: existing.runtime.taskId,
				metadata: existing.metadata,
				activity: existing.currentActivity,
			};
		}

		const metadata = await buildMetadata(runtime);
		if (!metadata.jsonlExists) {
			sendEvent(res, "activity_error", {
				taskId: runtime.taskId,
				message: "Sandbox agent event file is not visible to this API process",
				jsonlExists: metadata.jsonlExists,
				jsonlStatError: metadata.jsonlStatError,
			});
		}

		const buffer = getFileStreamBuffer(runtime.jsonlPath);
		const snapshot = await buffer.getSnapshot();
		const snapshotMessages = parseJsonlLines(snapshot.content, {
			nextLine: 0,
			pending: "",
		});
		const currentActivity = deriveSandboxAgentActivity(
			snapshotMessages,
			idleSandboxAgentActivity,
		);
		const parseState: ParseState = { nextLine: 0, pending: "" };
		parseJsonlLines(snapshot.content, parseState);

		const subscription: TaskActivitySubscription = {
			runtime,
			metadata,
			parseState,
			currentActivity,
			unsubscribe: () => {},
		};

		const emitActivityIfChanged = (nextActivity: SandboxAgentActivity) => {
			if (
				areSandboxAgentActivitiesEqual(
					subscription.currentActivity,
					nextActivity,
				)
			) {
				return;
			}
			subscription.currentActivity = nextActivity;
			sendEvent(res, "activity", {
				taskId: runtime.taskId,
				metadata: subscription.metadata,
				activity: subscription.currentActivity,
			});
		};

		subscription.unsubscribe = buffer.subscribe((event) => {
			try {
				if (event.type === "append") {
					const messages = parseJsonlLines(
						event.content,
						subscription.parseState,
					);
					if (messages.length > 0) {
						emitActivityIfChanged(
							deriveSandboxAgentActivity(
								messages,
								subscription.currentActivity,
							),
						);
					}
					return;
				}

				subscription.parseState.nextLine = 0;
				subscription.parseState.pending = "";
				const messages = parseJsonlLines(
					event.content,
					subscription.parseState,
				);
				emitActivityIfChanged(
					deriveSandboxAgentActivity(messages, idleSandboxAgentActivity),
				);
			} catch (error) {
				sendEvent(res, "activity_error", {
					taskId: runtime.taskId,
					message:
						error instanceof Error ? error.message : "Unknown stream error",
				});
				unsubscribeTask(runtime.taskId);
			}
		});

		subscriptions.set(runtime.taskId, subscription);

		return {
			taskId: runtime.taskId,
			metadata,
			activity: currentActivity,
		};
	};

	const cleanup = () => {
		for (const taskId of subscriptions.keys()) {
			unsubscribeTask(taskId);
		}
		clearInterval(heartbeat);
		clearInterval(reconcilePoll);
	};

	try {
		const initialRuntimes =
			await findRunningSandboxAgentTaskRuntimesByScanJobId(scanJobId);
		const tasks = await Promise.all(initialRuntimes.map(subscribeTask));
		sendEvent(res, "snapshot", {
			scanJobId,
			tasks,
		});
	} catch (error) {
		sendEvent(res, "activity_error", {
			taskId: null,
			message: error instanceof Error ? error.message : "Unknown stream error",
		});
	}

	const heartbeat = setInterval(() => {
		res.write(": keepalive\n\n");
	}, 15000);

	const reconcilePoll = setInterval(async () => {
		try {
			const [latestScanJobStatus, latestRuntimes] = await Promise.all([
				findScanJobStatusById(scanJobId),
				findRunningSandboxAgentTaskRuntimesByScanJobId(scanJobId),
			]);
			const latestIds = new Set(
				latestRuntimes.map((runtime) => runtime.taskId),
			);

			for (const taskId of subscriptions.keys()) {
				if (latestIds.has(taskId)) {
					continue;
				}
				const latestRuntime = await findSandboxAgentTaskRuntimeByTaskId(taskId);
				const fallback = subscriptions.get(taskId);
				sendEvent(res, "done", {
					taskId,
					status: latestRuntime?.status || "missing",
					taskKind:
						latestRuntime?.taskKind || fallback?.runtime.taskKind || "unknown",
				});
				unsubscribeTask(taskId);
				const jsonlPath = latestRuntime?.jsonlPath || fallback?.runtime.jsonlPath;
				if (jsonlPath) {
					clearFileStreamBuffer(jsonlPath);
				}
			}

			for (const runtime of latestRuntimes) {
				if (subscriptions.has(runtime.taskId)) {
					continue;
				}
				const subscribed = await subscribeTask(runtime);
				sendEvent(res, "activity", subscribed);
			}

			if (
				latestScanJobStatus &&
				isTerminalScanStatus(latestScanJobStatus) &&
				latestRuntimes.length === 0
			) {
				sendEvent(res, "done", {
					taskId: null,
					status: latestScanJobStatus,
					taskKind: "scan_job",
				});
				cleanup();
				res.end();
			}
		} catch (error) {
			sendEvent(res, "activity_error", {
				taskId: null,
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
