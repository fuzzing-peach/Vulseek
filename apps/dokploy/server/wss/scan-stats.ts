import type http from "node:http";
import {
	docker,
	execAsync,
	findApplicationById,
	findComposeById,
	findRunningSandboxAgentTaskRuntimesByScanJobId,
	findSandboxAgentTaskRuntimeByTaskId,
	findScanJobById,
	findTaskById,
	findTasksByScanJobId,
	listRunningScanJobsByOrganizationId,
	readTaskCurrentTokenUsage,
	validateRequest,
} from "@dokploy/server";
import { WebSocketServer } from "ws";

const ACTIVE_TASK_STATUSES = new Set([
	"launching",
	"launched",
	"starting",
	"running",
]);
let cachedCpuCapacityPercent: number | null = null;

type DockerStatsLine = {
	BlockIO: string;
	CPUPerc: string;
	Container: string;
	ID: string;
	MemPerc: string;
	MemUsage: string;
	Name: string;
	NetIO: string;
};

type ScanStatsContainer = {
	containerId: string;
	containerName: string;
	taskId?: string;
	status: "running";
};

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
		if (!scanJobId || (mode !== "job" && mode !== "task")) {
			return null;
		}
		return {
			mode,
			scanJobId,
			taskId,
		};
	}

	const taskMatch = url.pathname.match(scanTaskMonitoringPathPattern);
	if (taskMatch?.[1] && taskMatch?.[2]) {
		return {
			mode: "task",
			scanJobId: decodeURIComponent(taskMatch[1]),
			taskId: decodeURIComponent(taskMatch[2]),
		};
	}

	const jobMatch = url.pathname.match(scanJobMonitoringPathPattern);
	if (jobMatch?.[1]) {
		return {
			mode: "job",
			scanJobId: decodeURIComponent(jobMatch[1]),
		};
	}

	return null;
};

const emptyTokenSnapshot = () => ({
	timestampMs: Date.now(),
	totalTokens: 0,
	cachedReadTokens: 0,
	tasks: [] as Array<{
		taskId: string;
		label: string;
		totalTokens: number;
		cachedReadTokens: number;
	}>,
});

const emptyStatsSample = (
	containers: ScanStatsContainer[] = [],
	cpuCapacityPercent = 100,
) => ({
	time: new Date().toISOString(),
	runningContainerCount: containers.length,
	containers,
	cpu: {
		percent: 0,
		capacityPercent: cpuCapacityPercent,
	},
	memory: {
		usedBytes: 0,
		limitBytes: 0,
		percent: 0,
	},
	block: {
		readBytes: 0,
		writeBytes: 0,
	},
	network: {
		rxBytes: 0,
		txBytes: 0,
	},
	tokenSnapshot: emptyTokenSnapshot(),
	activeJobCount: 0,
});

const parsePercent = (value: string | undefined) => {
	if (!value) {
		return 0;
	}
	const number = Number.parseFloat(value.replace("%", ""));
	return Number.isFinite(number) ? number : 0;
};

const parseDockerSizeToBytes = (value: string | undefined) => {
	if (!value) {
		return 0;
	}
	const trimmed = value.trim();
	const match = trimmed.match(/^([0-9.]+)\s*([a-zA-Z]*)$/);
	if (!match) {
		return 0;
	}
	const number = Number.parseFloat(match[1] || "0");
	if (!Number.isFinite(number)) {
		return 0;
	}
	const unit = (match[2] || "B").toLowerCase();
	const multipliers: Record<string, number> = {
		b: 1,
		kb: 1000,
		mb: 1000 ** 2,
		gb: 1000 ** 3,
		tb: 1000 ** 4,
		kib: 1024,
		mib: 1024 ** 2,
		gib: 1024 ** 3,
		tib: 1024 ** 4,
	};
	return number * (multipliers[unit] ?? 1);
};

const parsePair = (value: string | undefined) => {
	const [left, right] = (value || "").split("/").map((part) => part.trim());
	return {
		leftBytes: parseDockerSizeToBytes(left),
		rightBytes: parseDockerSizeToBytes(right),
	};
};

const normalizeContainerName = (name: string) => name.replace(/^\//, "");

const getCpuCapacityPercent = async () => {
	if (cachedCpuCapacityPercent !== null) {
		return cachedCpuCapacityPercent;
	}
	const info = await docker.info();
	const ncpu = typeof info.NCPU === "number" && info.NCPU > 0 ? info.NCPU : 1;
	cachedCpuCapacityPercent = ncpu * 100;
	return cachedCpuCapacityPercent;
};

const aggregateMemoryLimitBytes = (limits: number[]) => {
	const validLimits = limits.filter(
		(limit) => Number.isFinite(limit) && limit > 0,
	);
	if (validLimits.length === 0) {
		return 0;
	}
	const uniqueLimits = new Set(validLimits.map((limit) => Math.round(limit)));
	if (uniqueLimits.size === 1) {
		return validLimits[0] || 0;
	}
	return validLimits.reduce((total, limit) => total + limit, 0);
};

const aggregateDockerStats = (
	stats: DockerStatsLine[],
	containers: ScanStatsContainer[],
	cpuCapacityPercent: number,
) => {
	const aggregate = emptyStatsSample(containers, cpuCapacityPercent);
	const memoryLimits: number[] = [];
	for (const stat of stats) {
		aggregate.cpu.percent += parsePercent(stat.CPUPerc);

		const memory = parsePair(stat.MemUsage);
		aggregate.memory.usedBytes += memory.leftBytes;
		memoryLimits.push(memory.rightBytes);

		const block = parsePair(stat.BlockIO);
		aggregate.block.readBytes += block.leftBytes;
		aggregate.block.writeBytes += block.rightBytes;

		const network = parsePair(stat.NetIO);
		aggregate.network.rxBytes += network.leftBytes;
		aggregate.network.txBytes += network.rightBytes;
	}
	aggregate.memory.limitBytes = aggregateMemoryLimitBytes(memoryLimits);
	aggregate.memory.percent =
		aggregate.memory.limitBytes > 0
			? (aggregate.memory.usedBytes / aggregate.memory.limitBytes) * 100
			: 0;
	return aggregate;
};

const readDockerStats = async (containers: ScanStatsContainer[]) => {
	const cpuCapacityPercent = await getCpuCapacityPercent();
	if (containers.length === 0) {
		return emptyStatsSample([], cpuCapacityPercent);
	}
	const format = [
		'{"BlockIO":"{{.BlockIO}}"',
		'"CPUPerc":"{{.CPUPerc}}"',
		'"Container":"{{.Container}}"',
		'"ID":"{{.ID}}"',
		'"MemPerc":"{{.MemPerc}}"',
		'"MemUsage":"{{.MemUsage}}"',
		'"Name":"{{.Name}}"',
		'"NetIO":"{{.NetIO}}"}',
	].join(",");
	const samples = await Promise.all(
		containers.map(async (container) => {
			try {
				const { stdout, stderr } = await execAsync(
					`docker stats ${container.containerId} --no-stream --format '${format}'`,
				);
				if (stderr) {
					console.error("Scan docker stats error:", stderr);
				}
				const line = stdout.trim().split("\n").find(Boolean);
				if (!line) {
					return null;
				}
				return {
					container,
					stat: JSON.parse(line) as DockerStatsLine,
				};
			} catch (error) {
				console.warn(
					"Skipping scan container stats sample:",
					container.containerName,
					error instanceof Error ? error.message : error,
				);
				return null;
			}
		}),
	);
	const successfulSamples = samples.filter(
		(sample): sample is NonNullable<typeof sample> => Boolean(sample),
	);
	return aggregateDockerStats(
		successfulSamples.map((sample) => sample.stat),
		successfulSamples.map((sample) => sample.container),
		cpuCapacityPercent,
	);
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

const resolveRunningContainers = async (
	containerNames: string[],
	taskIdsByContainerName: Map<string, string>,
) => {
	const uniqueContainerNames = Array.from(
		new Set(containerNames.map(normalizeContainerName)),
	).filter(Boolean);
	if (uniqueContainerNames.length === 0) {
		return [];
	}
	const normalizedTaskIdsByContainerName = new Map(
		Array.from(taskIdsByContainerName.entries()).map(([name, taskId]) => [
			normalizeContainerName(name),
			taskId,
		]),
	);

	const containers = await docker.listContainers({
		filters: JSON.stringify({
			status: ["running"],
			name: uniqueContainerNames,
		}),
	});

	return containers
		.map((container) => {
			const containerName =
				container.Names?.map(normalizeContainerName).find((name) =>
					uniqueContainerNames.includes(name),
				) || normalizeContainerName(container.Names?.[0] || container.Id);
			return {
				containerId: container.Id,
				containerName,
				taskId: normalizedTaskIdsByContainerName.get(containerName),
				status: "running" as const,
			};
		})
		.filter((container) =>
			uniqueContainerNames.includes(container.containerName),
		);
};

export const setupScanStatsMonitoringSocketServer = (
	server: http.Server<typeof http.IncomingMessage, typeof http.ServerResponse>,
) => {
	const wss = new WebSocketServer({
		noServer: true,
	});

	server.on("upgrade", (req, socket, head) => {
		const url = new URL(req.url || "", `http://${req.headers.host}`);
		if (parseScanStatsMonitoringRoute(url)) {
			wss.handleUpgrade(req, socket, head, function done(ws) {
				wss.emit("connection", ws, req);
			});
		}
	});

	wss.on("connection", async (ws, req) => {
		const url = new URL(req.url || "", `http://${req.headers.host}`);
		const route = parseScanStatsMonitoringRoute(url);
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
				if (!session.activeOrganizationId) {
					ws.close(4000, "Unauthorized scan monitoring request");
					return;
				}
			} else {
				await authorizeScanJob(route.scanJobId, session.activeOrganizationId);
				if (route.mode === "task") {
					if (!route.taskId) {
						ws.close(4000, "taskId is required");
						return;
					}
					const task = await findTaskById(route.taskId);
					if (task.scanJobId !== route.scanJobId) {
						ws.close(4000, "Task not found for this scan job");
						return;
					}
				}
			}
		} catch (error) {
			ws.close(
				4000,
				error instanceof Error
					? error.message
					: "Unauthorized scan monitoring request",
			);
			return;
		}

		const formatTaskLabel = (taskKind: string, taskId: string) =>
			`${taskKind.replace(/_/g, " ")} ${taskId.slice(0, 8)}`;

		let isSampling = false;
		const sampleAndSend = async () => {
			if (isSampling || ws.readyState !== ws.OPEN) {
				return;
			}
			isSampling = true;
			try {
				if (route.mode === "global") {
					const organizationId = session.activeOrganizationId;
					if (!organizationId) {
						ws.send(
							JSON.stringify({
								error: "Unauthorized",
								data: emptyStatsSample(),
							}),
						);
						return;
					}
					const runningJobs =
						await listRunningScanJobsByOrganizationId(organizationId);
					const activeJobCount = runningJobs.length;

					const allRuntimes = (
						await Promise.all(
							runningJobs.map((job) =>
								findRunningSandboxAgentTaskRuntimesByScanJobId(job.scanJobId),
							),
						)
					).flat();

					const containerNames: string[] = [];
					const taskIdsByContainerName = new Map<string, string>();
					for (const runtime of allRuntimes) {
						if (runtime.containerName) {
							containerNames.push(runtime.containerName);
							taskIdsByContainerName.set(runtime.containerName, runtime.taskId);
						}
					}
					const containers = await resolveRunningContainers(
						containerNames,
						taskIdsByContainerName,
					);
					const dockerData = await readDockerStats(containers);

					const taskUsages = await Promise.all(
						allRuntimes.map(async (runtime) => ({
							taskId: runtime.taskId,
							label: formatTaskLabel(runtime.taskKind, runtime.taskId),
							...(await readTaskCurrentTokenUsage(runtime.jsonlPath)),
						})),
					);
					const tokenSnapshot = {
						timestampMs: Date.now(),
						totalTokens: taskUsages.reduce((s, t) => s + t.totalTokens, 0),
						cachedReadTokens: taskUsages.reduce(
							(s, t) => s + t.cachedReadTokens,
							0,
						),
						tasks: taskUsages,
					};

					ws.send(
						JSON.stringify({
							data: { ...dockerData, tokenSnapshot, activeJobCount },
						}),
					);
					return;
				}

				let containerNames: string[] = [];
				const taskIdsByContainerName = new Map<string, string>();

				if (route.mode === "task") {
					const runtime = route.taskId
						? await findSandboxAgentTaskRuntimeByTaskId(route.taskId)
						: null;
					const task = route.taskId
						? await findTaskById(route.taskId).catch(() => null)
						: null;
					if (task?.containerName) {
						containerNames = [task.containerName];
						taskIdsByContainerName.set(task.containerName, task.taskId);
					}
					const containers = await resolveRunningContainers(
						containerNames,
						taskIdsByContainerName,
					);
					const dockerData = await readDockerStats(containers);
					const taskUsage = runtime
						? await readTaskCurrentTokenUsage(runtime.jsonlPath)
						: { totalTokens: 0, cachedReadTokens: 0 };
					const tokenSnapshot = {
						timestampMs: Date.now(),
						totalTokens: taskUsage.totalTokens,
						cachedReadTokens: taskUsage.cachedReadTokens,
						tasks: route.taskId
							? [
									{
										taskId: route.taskId,
										label: runtime
											? formatTaskLabel(runtime.taskKind, runtime.taskId)
											: route.taskId.slice(0, 8),
										...taskUsage,
									},
								]
							: [],
					};
					ws.send(JSON.stringify({ data: { ...dockerData, tokenSnapshot, activeJobCount: 1 } }));
				} else {
					const runtimes =
						await findRunningSandboxAgentTaskRuntimesByScanJobId(
							route.scanJobId,
						);
					const tasks = await findTasksByScanJobId(route.scanJobId);
					for (const task of tasks) {
						if (task.containerName && ACTIVE_TASK_STATUSES.has(task.status)) {
							containerNames.push(task.containerName);
							taskIdsByContainerName.set(task.containerName, task.taskId);
						}
					}
					const containers = await resolveRunningContainers(
						containerNames,
						taskIdsByContainerName,
					);
					const dockerData = await readDockerStats(containers);
					const taskUsages = await Promise.all(
						runtimes.map(async (runtime) => ({
							taskId: runtime.taskId,
							label: formatTaskLabel(runtime.taskKind, runtime.taskId),
							...(await readTaskCurrentTokenUsage(runtime.jsonlPath)),
						})),
					);
					const tokenSnapshot = {
						timestampMs: Date.now(),
						totalTokens: taskUsages.reduce((s, t) => s + t.totalTokens, 0),
						cachedReadTokens: taskUsages.reduce(
							(s, t) => s + t.cachedReadTokens,
							0,
						),
						tasks: taskUsages,
					};
					ws.send(
						JSON.stringify({
							data: { ...dockerData, tokenSnapshot, activeJobCount: 1 },
						}),
					);
				}
			} catch (error) {
				ws.send(
					JSON.stringify({
						error:
							error instanceof Error
								? error.message
								: "Failed to read scan monitoring stats",
						data: emptyStatsSample(),
					}),
				);
			} finally {
				isSampling = false;
			}
		};

		const intervalId = setInterval(() => {
			void sampleAndSend();
		}, 1300);
		void sampleAndSend();

		ws.on("close", () => {
			clearInterval(intervalId);
		});
	});
};
