import { promises as fs } from "node:fs";
import path from "node:path";
import {
	findSandboxAgentTaskRuntimeByTaskId,
	findScanJobOrganizationId,
	validateRequest,
} from "@dokploy/server";
import type { NextApiRequest, NextApiResponse } from "next";
import { getFileStreamBuffer } from "@/server/utils/file-stream-buffer";

type ParseState = {
	nextLine: number;
	pending: string;
};

type FuzzProgressRecord = {
	line: number;
	raw: string;
	timestamp?: string;
	runTimeMs?: number;
	runTimePretty?: string;
	totalExecs?: number;
	execsPerSec?: number;
	corpusSize?: number;
	objectiveSize?: number;
	coverage?: {
		edgesHit?: number;
		edgesTotal?: number;
		edgeCoveragePercent?: number;
	};
	eventMsg?: string;
	userStats?: Record<string, unknown>;
	data?: Record<string, unknown>;
	parseError?: string;
};

const ACTIVE_TASK_STATUSES = new Set(["pending", "launching", "running"]);
const FUZZ_PROGRESS_FILE_NAME = "fuzz-progress.jsonl";

const sendEvent = (
	res: NextApiResponse,
	event: string,
	payload: Record<string, unknown>,
) => {
	res.write(`event: ${event}\n`);
	res.write(`data: ${JSON.stringify(payload)}\n\n`);
};

const asRecord = (value: unknown) =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;

const asNumber = (value: unknown) => {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
};

const asString = (value: unknown) =>
	typeof value === "string" && value ? value : undefined;

const normalizeTimestamp = (value: unknown) => {
	if (typeof value === "number" && Number.isFinite(value)) {
		const millis = value < 10_000_000_000 ? value * 1000 : value;
		return new Date(millis).toISOString();
	}
	if (typeof value === "string" && value) {
		const numeric = Number(value);
		if (Number.isFinite(numeric)) {
			return normalizeTimestamp(numeric);
		}
		const millis = Date.parse(value);
		return Number.isFinite(millis) ? new Date(millis).toISOString() : value;
	}
	return undefined;
};

const extractCoverage = (data: Record<string, unknown>) => {
	const coverage = asRecord(data.coverage);
	const edgesHit = asNumber(data.edgesHit ?? coverage?.edgesHit);
	const edgesTotal = asNumber(data.edgesTotal ?? coverage?.edgesTotal);
	const edgeCoveragePercent = asNumber(
		data.edgeCoveragePercent ??
			data.coveragePercent ??
			coverage?.edgeCoveragePercent ??
			coverage?.coveragePercent,
	);

	if (
		edgesHit === undefined &&
		edgesTotal === undefined &&
		edgeCoveragePercent === undefined
	) {
		return undefined;
	}

	return {
		edgesHit,
		edgesTotal,
		edgeCoveragePercent,
	};
};

const toFuzzProgressRecord = (
	line: number,
	raw: string,
): FuzzProgressRecord => {
	const trimmed = raw.trim();
	if (!trimmed) {
		return { line, raw };
	}

	try {
		const parsed = JSON.parse(trimmed) as unknown;
		const data = asRecord(parsed);
		if (!data) {
			return {
				line,
				raw,
				parseError: "Record is not a JSON object",
			};
		}

		return {
			line,
			raw,
			timestamp: normalizeTimestamp(data.timestamp ?? data.createdAt),
			runTimeMs: asNumber(data.runTimeMs),
			runTimePretty: asString(data.runTimePretty),
			totalExecs: asNumber(data.totalExecs ?? data.executions ?? data.execs),
			execsPerSec: asNumber(data.execsPerSec),
			corpusSize: asNumber(data.corpusSize),
			objectiveSize: asNumber(data.objectiveSize),
			coverage: extractCoverage(data),
			eventMsg: asString(data.eventMsg ?? data.event ?? data.message),
			userStats: asRecord(data.userStats) || undefined,
			data,
		};
	} catch (error) {
		return {
			line,
			raw,
			parseError: error instanceof Error ? error.message : "Invalid JSON",
		};
	}
};

const parseJsonlLines = (
	content: string,
	parseState: ParseState,
): FuzzProgressRecord[] => {
	const combined = parseState.pending + content;
	const lines = combined.split("\n");
	parseState.pending = lines.pop() || "";
	const records: FuzzProgressRecord[] = [];

	for (const line of lines) {
		parseState.nextLine += 1;
		if (!line.trim()) {
			continue;
		}
		records.push(toFuzzProgressRecord(parseState.nextLine, line));
	}

	return records;
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

	const runtimeDir = path.dirname(runtime.jsonlPath);
	const progressPath = path.join(runtimeDir, FUZZ_PROGRESS_FILE_NAME);

	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache, no-transform",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
	});
	res.flushHeaders?.();

	let fileExists = false;
	let fileStatError: string | null = null;
	try {
		const stat = await fs.stat(progressPath);
		if (stat.isFile()) {
			fileExists = true;
		} else {
			fileStatError = "Fuzz progress path is not a file";
		}
	} catch (error) {
		fileStatError =
			error instanceof Error ? error.message : "Unable to stat fuzz progress";
	}
	const metadata = {
		taskId: runtime.taskId,
		scanJobId: runtime.scanJobId,
		taskKind: runtime.taskKind,
		status: runtime.status,
		containerName: runtime.containerName,
		provider: runtime.provider,
		progressFileName: FUZZ_PROGRESS_FILE_NAME,
		fileExists,
		fileStatError,
	};

	const buffer = getFileStreamBuffer(progressPath);
	const snapshot = await buffer.getSnapshot();
	const snapshotParseState: ParseState = { nextLine: 0, pending: "" };
	const snapshotRecords = parseJsonlLines(
		snapshot.content,
		snapshotParseState,
	);
	sendEvent(res, "snapshot", {
		metadata,
		records: snapshotRecords,
		waiting: !fileExists && snapshotRecords.length === 0,
	});

	if (!fileExists && snapshotRecords.length === 0) {
		sendEvent(res, "waiting", {
			metadata,
			message: `${FUZZ_PROGRESS_FILE_NAME} has not been created yet`,
		});
	}

	const parseState: ParseState = { nextLine: 0, pending: "" };
	parseJsonlLines(snapshot.content, parseState);

	let unsubscribe = () => {};
	let heartbeat: NodeJS.Timeout | null = null;
	let statusPoll: NodeJS.Timeout | null = null;
	const cleanup = () => {
		unsubscribe();
		if (heartbeat) {
			clearInterval(heartbeat);
		}
		if (statusPoll) {
			clearInterval(statusPoll);
		}
	};

	unsubscribe = buffer.subscribe((event) => {
		try {
			if (event.type === "append") {
				const records = parseJsonlLines(event.content, parseState);
				if (records.length > 0) {
					sendEvent(res, "delta", { records });
				}
				return;
			}

			parseState.nextLine = 0;
			parseState.pending = "";
			const records = parseJsonlLines(event.content, parseState);
			sendEvent(res, "snapshot", {
				metadata: {
					...metadata,
					fileExists: event.reason !== "missing",
				},
				records,
				waiting: event.reason === "missing" && records.length === 0,
			});
		} catch (error) {
			sendEvent(res, "fuzz_progress_error", {
				message:
					error instanceof Error ? error.message : "Unknown stream error",
			});
			cleanup();
			res.end();
		}
	});

	heartbeat = setInterval(() => {
		res.write(": keepalive\n\n");
	}, 15000);

	statusPoll = setInterval(async () => {
		try {
			const latest = await findSandboxAgentTaskRuntimeByTaskId(taskId);
			if (!latest || !ACTIVE_TASK_STATUSES.has(latest.status)) {
				sendEvent(res, "done", {
					status: latest?.status || "missing",
					taskId,
					taskKind: latest?.taskKind || runtime.taskKind,
				});
				cleanup();
				res.end();
			}
		} catch (error) {
			sendEvent(res, "fuzz_progress_error", {
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
