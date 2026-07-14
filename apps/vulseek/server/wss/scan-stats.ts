import type http from "node:http";
import {
	findApplicationById,
	findComposeById,
	findScanJobById,
	findTaskById,
	validateRequest,
} from "@vulseek/server";
import {
	monitoringHub,
	type ScanMonitoringSample,
} from "../monitoring/scan-monitoring-hub";
import { WebSocketServer } from "ws";

type ScanStatsMonitoringRoute =
	| {
			mode: "job" | "task";
			scanJobId: string;
			taskId?: string;
	  }
	| {
			mode: "global";
	  };

const SCAN_MONITORING_LEGACY_PATH = "/listen-scan-stats-monitoring";
const GLOBAL_SCAN_MONITORING_PATH = "/dashboard/monitoring/scan-stats";
const scanJobMonitoringPathPattern =
	/^\/dashboard\/project\/[^/]+\/environment\/[^/]+\/(?:profiles|services)\/(?:application|compose)\/[^/]+\/jobs\/([^/]+)\/monitoring$/;
const scanTaskMonitoringPathPattern =
	/^\/dashboard\/project\/[^/]+\/environment\/[^/]+\/(?:profiles|services)\/(?:application|compose)\/[^/]+\/jobs\/([^/]+)\/tasks\/([^/]+)\/monitoring$/;

const parseScanStatsMonitoringRoute = (
	url: URL,
): ScanStatsMonitoringRoute | null => {
	if (url.pathname === GLOBAL_SCAN_MONITORING_PATH) {
		return { mode: "global" };
	}

	if (url.pathname === SCAN_MONITORING_LEGACY_PATH) {
		const mode = url.searchParams.get("mode");
		const scanJobId = url.searchParams.get("scanJobId");
		const taskId = url.searchParams.get("taskId") || undefined;
		if (!scanJobId || (mode !== "job" && mode !== "task")) return null;
		return { mode, scanJobId, taskId };
	}

	const taskMatch = url.pathname.match(scanTaskMonitoringPathPattern);
	if (taskMatch?.[1] && taskMatch[2]) {
		return {
			mode: "task",
			scanJobId: decodeURIComponent(taskMatch[1]),
			taskId: decodeURIComponent(taskMatch[2]),
		};
	}

	const jobMatch = url.pathname.match(scanJobMonitoringPathPattern);
	if (jobMatch?.[1]) {
		return { mode: "job", scanJobId: decodeURIComponent(jobMatch[1]) };
	}

	return null;
};

const authorizeScanJob = async (
	scanJobId: string,
	activeOrganizationId: string | null | undefined,
) => {
	const scanJob = await findScanJobById(scanJobId);
	let organizationId: string | undefined;
	if (scanJob.applicationId) {
		const application = await findApplicationById(scanJob.applicationId);
		organizationId = application.environment.project.organizationId;
	}
	if (scanJob.composeId) {
		const compose = await findComposeById(scanJob.composeId);
		organizationId = compose.environment.project.organizationId;
	}
	if (!organizationId || organizationId !== activeOrganizationId) {
		throw new Error("Unauthorized scan monitoring request");
	}
	return scanJob;
};

const sendSnapshot = (ws: import("ws").WebSocket, sample: ScanMonitoringSample) => {
	if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ data: sample }));
};

export const setupScanStatsMonitoringSocketServer = (
	server: http.Server<typeof http.IncomingMessage, typeof http.ServerResponse>,
) => {
	const wss = new WebSocketServer({ noServer: true });

	server.on("upgrade", (req, socket, head) => {
		const url = new URL(req.url || "", `http://${req.headers.host}`);
		if (parseScanStatsMonitoringRoute(url)) {
			wss.handleUpgrade(req, socket, head, (ws) => {
				wss.emit("connection", ws, req);
			});
		}
	});

	wss.on("connection", async (ws, req) => {
		const route = parseScanStatsMonitoringRoute(
			new URL(req.url || "", `http://${req.headers.host}`),
		);
		const { user, session } = await validateRequest(req);
		if (!user || !session) {
			ws.close(4000, "Unauthorized");
			return;
		}
		if (!route) {
			ws.close(4000, "Invalid scan monitoring request");
			return;
		}

		try {
			if (route.mode === "global") {
				if (!session.activeOrganizationId) throw new Error("Unauthorized scan monitoring request");
			} else {
				await authorizeScanJob(route.scanJobId, session.activeOrganizationId);
				if (route.mode === "task") {
					if (!route.taskId) throw new Error("taskId is required");
					const task = await findTaskById(route.taskId);
					if (task.scanJobId !== route.scanJobId) throw new Error("Task not found for this scan job");
				}
				if (route.mode === "task" && !route.taskId) throw new Error("taskId is required");
			}
		} catch (error) {
			ws.close(4000, error instanceof Error ? error.message : "Unauthorized scan monitoring request");
			return;
		}

		try {
			const subscription =
				route.mode === "global"
					? monitoringHub.acquireOrganization(session.activeOrganizationId as string, (sample) => sendSnapshot(ws, sample))
					: route.mode === "job"
						? monitoringHub.acquireJob(route.scanJobId, (sample) => sendSnapshot(ws, sample))
						: await monitoringHub.acquireTask(route.taskId as string, (sample) => sendSnapshot(ws, sample));
			ws.on("close", subscription.release);
		} catch (error) {
			ws.close(1011, error instanceof Error ? error.message : "Failed to start scan monitoring");
		}
	});
};
