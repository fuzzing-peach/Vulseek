import {
	findApplicationById,
	findComposeById,
	findScanJobById,
	findTaskById,
	getFunctionScannerAppServerJsonlPath,
	getModuleScannerAppServerJsonlPath,
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

const resolveScannerStage = (
	value: string | string[] | undefined,
): "repository_scanning" | "module_scanning" | "function_scanning" | null => {
	if (value === "repository_scanning") {
		return value;
	}
	if (value === "module_scanning") {
		return value;
	}
	if (value === "function_scanning") {
		return value;
	}
	return null;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
	value && typeof value === "object" ? (value as Record<string, unknown>) : null;

const readString = (record: Record<string, unknown> | null, key: string) => {
	const value = record?.[key];
	return typeof value === "string" ? value : null;
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

	const requestedStage = resolveScannerStage(req.query.stage);
	if (!requestedStage) {
		res.status(400).json({ message: "Invalid scanner stage" });
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

	let filePath = await getScanJobAppServerJsonlPath(scanJobId);
	let scanModuleTaskId: string | null = null;
	let scanFunctionTaskId: string | null = null;
	let moduleId: string | null = null;
	let functionId: string | null = null;

	if (requestedStage === "module_scanning") {
		scanModuleTaskId =
			typeof req.query.scanModuleTaskId === "string"
				? req.query.scanModuleTaskId
				: null;
		if (!scanModuleTaskId) {
			res.status(400).json({ message: "Missing scanModuleTaskId" });
			return;
		}
		const moduleTask = await findTaskById(scanModuleTaskId).catch(() => null);
		if (
			!moduleTask ||
			moduleTask.scanJobId !== scanJobId ||
			moduleTask.stageName !== "ModuleScanningStage"
		) {
			res.status(404).json({ message: "Module task not found" });
			return;
		}
		moduleId = readString(asRecord(asRecord(moduleTask.input)?.module), "moduleId");
		if (!moduleId) {
			res.status(404).json({ message: "Module task metadata not found" });
			return;
		}
		filePath = await getModuleScannerAppServerJsonlPath(
			scanJobId,
			moduleId,
		);
	}

	if (requestedStage === "function_scanning") {
		scanFunctionTaskId =
			typeof req.query.scanFunctionTaskId === "string"
				? req.query.scanFunctionTaskId
				: null;
		if (!scanFunctionTaskId) {
			res.status(400).json({ message: "Missing scanFunctionTaskId" });
			return;
		}
		const functionTask = await findTaskById(scanFunctionTaskId).catch(() => null);
		if (
			!functionTask ||
			functionTask.scanJobId !== scanJobId ||
			functionTask.stageName !== "FunctionScanningStage"
		) {
			res.status(404).json({ message: "Function task not found" });
			return;
		}
		const input = asRecord(functionTask.input);
		const module = asRecord(input?.module);
		const func = asRecord(input?.function);
		scanModuleTaskId = functionTask.parentTaskId;
		moduleId = readString(func, "moduleId") || readString(module, "moduleId");
		functionId = readString(func, "functionId");
		if (!moduleId || !functionId) {
			res.status(404).json({ message: "Function task metadata not found" });
			return;
		}
		filePath = await getFunctionScannerAppServerJsonlPath(
			scanJobId,
			moduleId,
			functionId,
		);
	}

	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache, no-transform",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
	});
	res.flushHeaders?.();

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
			if (requestedStage === "repository_scanning") {
				const latestScanJob = await findScanJobById(scanJobId);
				if (latestScanJob.repositoryTaskStatus !== "running") {
					sendEvent(res, "done", {
						status: latestScanJob.repositoryTaskStatus,
						stage: requestedStage,
					});
					cleanup();
					res.end();
				}
				return;
			}

			if (requestedStage === "module_scanning" && scanModuleTaskId) {
				const latestTask = await findTaskById(scanModuleTaskId).catch(() => null);
				if (!latestTask || latestTask.status !== "running") {
					sendEvent(res, "done", {
						status: latestTask?.status || "completed",
						stage: requestedStage,
						scanModuleTaskId,
						moduleId,
					});
					cleanup();
					res.end();
				}
				return;
			}

			if (requestedStage === "function_scanning" && scanFunctionTaskId) {
				const latestTask = await findTaskById(scanFunctionTaskId).catch(() => null);
				if (!latestTask || latestTask.status !== "running") {
					sendEvent(res, "done", {
						status: latestTask?.status || "completed",
						stage: requestedStage,
						scanModuleTaskId,
						scanFunctionTaskId,
						moduleId,
						functionId,
					});
					cleanup();
					res.end();
				}
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
