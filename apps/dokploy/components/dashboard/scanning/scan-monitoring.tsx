import { useEffect, useMemo, useRef, useState } from "react";
import {
	Area,
	AreaChart,
	CartesianGrid,
	Legend,
	ResponsiveContainer,
	Tooltip,
	YAxis,
} from "recharts";
import {
	useSandboxAgentActivities,
	useSandboxAgentActivity,
} from "@/components/dashboard/scanning/use-sandbox-agent-activity";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import type { SandboxAgentActivity } from "@/lib/scan/sandbox-agent-activity";

type ScanMonitoringMode = "job" | "task";

type ScanMonitoringSample = {
	time: string;
	runningContainerCount: number;
	containers: {
		containerId: string;
		containerName: string;
		taskId?: string;
		status: "running";
	}[];
	cpu: {
		percent: number;
		capacityPercent: number;
	};
	memory: {
		usedBytes: number;
		limitBytes: number;
		percent: number;
	};
	block: {
		readBytes: number;
		writeBytes: number;
	};
	network: {
		rxBytes: number;
		txBytes: number;
	};
};

type ScanMonitoringMessage = {
	data?: ScanMonitoringSample;
	error?: string;
};

type TokenThroughputTaskRate = {
	taskId: string;
	label: string;
	tokensPerSecond: number;
	latestTokens: number;
	timestampMs: number;
	updatedAtMs: number;
};

type TokenThroughputSample = {
	time: string;
	aggregateTokensPerSecond: number;
};

type ScanMonitoringProps = {
	mode: ScanMonitoringMode;
	scanJobId: string;
	taskId?: string;
	title?: string;
	description?: string;
};

const emptySample: ScanMonitoringSample = {
	time: "",
	runningContainerCount: 0,
	containers: [],
	cpu: {
		percent: 0,
		capacityPercent: 100,
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
};

const clampProgress = (value: number) =>
	Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));

const formatPercent = (value: number) =>
	`${(Number.isFinite(value) ? value : 0).toFixed(2)}%`;

const formatVcpu = (value: number) =>
	`${(Number.isFinite(value) ? value : 0).toFixed(2)} vCPU`;

const formatBytes = (value: number) => {
	if (!Number.isFinite(value) || value <= 0) {
		return "0 B";
	}
	const units = ["B", "KB", "MB", "GB", "TB"];
	let size = value;
	let unitIndex = 0;
	while (size >= 1000 && unitIndex < units.length - 1) {
		size /= 1000;
		unitIndex += 1;
	}
	const precision = size >= 100 || unitIndex === 0 ? 0 : size >= 10 ? 1 : 2;
	return `${size.toFixed(precision)} ${units[unitIndex]}`;
};

type AxisUnitOption = {
	label: string;
	scale: number;
};

const BYTE_AXIS_UNITS: AxisUnitOption[] = [
	{ label: "B", scale: 1 },
	{ label: "KB", scale: 1000 },
	{ label: "MB", scale: 1000 ** 2 },
	{ label: "GB", scale: 1000 ** 3 },
	{ label: "TB", scale: 1000 ** 4 },
];

const TOKEN_RATE_AXIS_UNITS: AxisUnitOption[] = [
	{ label: "tokens/s", scale: 1 },
	{ label: "K tokens/s", scale: 1000 },
	{ label: "M tokens/s", scale: 1000 ** 2 },
	{ label: "B tokens/s", scale: 1000 ** 3 },
];

const formatCompactNumber = (value: number) => {
	const safeValue = Number.isFinite(value) ? value : 0;
	const units = [
		{ suffix: "T", scale: 1000 ** 4 },
		{ suffix: "B", scale: 1000 ** 3 },
		{ suffix: "M", scale: 1000 ** 2 },
		{ suffix: "K", scale: 1000 },
	];
	for (const unit of units) {
		if (Math.abs(safeValue) >= unit.scale) {
			return `${formatAxisDecimal(safeValue / unit.scale)}${unit.suffix}`;
		}
	}
	return formatAxisDecimal(safeValue);
};

const resolveAxisUnit = (value: number, units?: AxisUnitOption[]) => {
	if (!units?.length) {
		return { label: "", scale: 1 };
	}
	const safeValue = Math.abs(Number.isFinite(value) ? value : 0);
	let resolved = units[0] || { label: "", scale: 1 };
	for (const unit of units) {
		if (safeValue >= unit.scale) {
			resolved = unit;
		}
	}
	return resolved;
};

const formatAxisDecimal = (value: number) =>
	(Number.isFinite(value) ? value : 0)
		.toFixed(2)
		.replace(/\.00$/, "")
		.replace(/(\.\d)0$/, "$1");

const formatTokens = (value: number) =>
	`${formatCompactNumber(Number.isFinite(value) ? value : 0)} tokens`;

const formatTokensPerSecond = (value: number) =>
	`${formatCompactNumber(Number.isFinite(value) ? value : 0)} tokens/s`;

const buildChartData = (samples: ScanMonitoringSample[]) =>
	samples.map((sample, index) => ({
		name: `Point ${index + 1}`,
		time: sample.time,
		cpuPercent: Number(sample.cpu.percent.toFixed(2)),
		cpuVcpu: Number((sample.cpu.percent / 100).toFixed(2)),
		memoryBytes: sample.memory.usedBytes,
		blockReadBytes: sample.block.readBytes,
		blockWriteBytes: sample.block.writeBytes,
		networkRxBytes: sample.network.rxBytes,
		networkTxBytes: sample.network.txBytes,
	}));

const buildTokenChartData = (samples: TokenThroughputSample[]) =>
	samples.map((sample, index) => ({
		name: `Point ${index + 1}`,
		time: sample.time,
		aggregateTokensPerSecond: Number(
			sample.aggregateTokensPerSecond.toFixed(2),
		),
	}));

const getActivityUsage = (activity?: SandboxAgentActivity) => {
	const usage = activity?.tokenUsage;
	if (
		!usage ||
		typeof usage.used !== "number" ||
		!Number.isFinite(usage.used)
	) {
		return null;
	}
	const timestampMs = usage.timestamp
		? Date.parse(usage.timestamp)
		: Date.now();
	return {
		tokens: usage.used,
		timestampMs: Number.isFinite(timestampMs) ? timestampMs : Date.now(),
	};
};

const formatTaskRateLabel = (taskId: string, taskKind?: string | null) =>
	taskKind ? `${taskKind.replace(/_/g, " ")} ${taskId.slice(0, 8)}` : taskId;

const TOKEN_RATE_STALE_MS = 5000;
const MONITORING_SAMPLE_LIMIT = 240;

const useTokenThroughput = ({
	mode,
	scanJobId,
	taskId,
}: {
	mode: ScanMonitoringMode;
	scanJobId: string;
	taskId?: string;
}) => {
	const jobActivities = useSandboxAgentActivities({
		scanJobId,
		enabled: mode === "job" && !!scanJobId,
	});
	const taskActivity = useSandboxAgentActivity({
		taskId: taskId || "",
		enabled: mode === "task" && !!taskId,
	});
	const previousUsageRef = useRef(
		new Map<string, { tokens: number; timestampMs: number }>(),
	);
	const currentRatesRef = useRef(new Map<string, TokenThroughputTaskRate>());
	const [samples, setSamples] = useState<TokenThroughputSample[]>([]);
	const [taskRates, setTaskRates] = useState<TokenThroughputTaskRate[]>([]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset throughput state when the monitoring target changes.
	useEffect(() => {
		previousUsageRef.current.clear();
		currentRatesRef.current.clear();
		setSamples([]);
		setTaskRates([]);
	}, [mode, scanJobId, taskId]);

	useEffect(() => {
		if (mode !== "job") {
			return;
		}
		for (const existingTaskId of Array.from(currentRatesRef.current.keys())) {
			if (!jobActivities.connectedTaskIds.has(existingTaskId)) {
				currentRatesRef.current.delete(existingTaskId);
				previousUsageRef.current.delete(existingTaskId);
			}
		}
	}, [jobActivities.connectedTaskIds, mode]);

	useEffect(() => {
		const nextEntries =
			mode === "job"
				? Object.entries(jobActivities.activitiesByTaskId).map(
						([activityTaskId, activity]) => ({
							taskId: activityTaskId,
							label: formatTaskRateLabel(
								activityTaskId,
								jobActivities.metadataByTaskId[activityTaskId]?.taskKind,
							),
							activity,
						}),
					)
				: taskId
					? [
							{
								taskId,
								label: formatTaskRateLabel(
									taskId,
									taskActivity.metadata?.taskKind,
								),
								activity: taskActivity.activity,
							},
						]
					: [];

		let changed = false;
		for (const entry of nextEntries) {
			const usage = getActivityUsage(entry.activity);
			if (!usage) {
				continue;
			}
			const previous = previousUsageRef.current.get(entry.taskId);
			if (
				previous &&
				previous.tokens === usage.tokens &&
				previous.timestampMs === usage.timestampMs
			) {
				continue;
			}
			const elapsedSeconds =
				previous && usage.timestampMs > previous.timestampMs
					? (usage.timestampMs - previous.timestampMs) / 1000
					: 0;
			const tokensPerSecond =
				elapsedSeconds > 0 ? usage.tokens / elapsedSeconds : 0;
			previousUsageRef.current.set(entry.taskId, usage);
			currentRatesRef.current.set(entry.taskId, {
				taskId: entry.taskId,
				label: entry.label,
				tokensPerSecond,
				latestTokens: usage.tokens,
				timestampMs: usage.timestampMs,
				updatedAtMs: Date.now(),
			});
			changed = true;
		}
		if (changed) {
			setTaskRates(Array.from(currentRatesRef.current.values()));
		}
	}, [
		jobActivities.activitiesByTaskId,
		jobActivities.metadataByTaskId,
		mode,
		taskActivity.activity,
		taskActivity.metadata,
		taskId,
	]);

	useEffect(() => {
		if (!scanJobId || (mode === "task" && !taskId)) {
			return;
		}
		const intervalId = setInterval(() => {
			const now = Date.now();
			const nextTaskRates = Array.from(currentRatesRef.current.values()).map(
				(rate) =>
					now - rate.updatedAtMs > TOKEN_RATE_STALE_MS
						? { ...rate, tokensPerSecond: 0 }
						: rate,
			);
			const aggregateTokensPerSecond = nextTaskRates.reduce(
				(total, rate) => total + rate.tokensPerSecond,
				0,
			);
			setTaskRates(nextTaskRates);
			setSamples((previous) =>
				[
					...previous,
					{
						time: new Date(now).toISOString(),
						aggregateTokensPerSecond,
					},
				].slice(-MONITORING_SAMPLE_LIMIT),
			);
		}, 1300);
		return () => clearInterval(intervalId);
	}, [mode, scanJobId, taskId]);

	return {
		samples,
		taskRates: [...taskRates].sort((left, right) =>
			right.tokensPerSecond === left.tokensPerSecond
				? right.latestTokens - left.latestTokens
				: right.tokensPerSecond - left.tokensPerSecond,
		),
		aggregateTokensPerSecond: taskRates.reduce(
			(total, rate) => total + rate.tokensPerSecond,
			0,
		),
		latestTokens: taskRates.reduce(
			(total, rate) => total + rate.latestTokens,
			0,
		),
	};
};

const UsageChart = ({
	data,
	keys,
	max,
	formatter,
	axisUnitLabel,
	axisUnits,
}: {
	data: Array<Record<string, number | string>>;
	keys: {
		key: string;
		name: string;
		color: string;
	}[];
	max?: number;
	formatter: (value: number) => string;
	axisUnitLabel?: string;
	axisUnits?: AxisUnitOption[];
}) => {
	const dataMax = data.reduce((largest, row) => {
		const rowMax = keys.reduce((current, item) => {
			const value = row[item.key];
			return typeof value === "number" && Number.isFinite(value)
				? Math.max(current, Math.abs(value))
				: current;
		}, 0);
		return Math.max(largest, rowMax);
	}, 0);
	const axisUnit = axisUnits
		? resolveAxisUnit(max ?? dataMax, axisUnits)
		: { label: axisUnitLabel || "", scale: 1 };
	const formatAxisTick = (value: number) =>
		formatAxisDecimal(value / axisUnit.scale);

	return (
		<div className="relative mt-6 h-40 w-full">
			{axisUnit.label ? (
				<div className="pointer-events-none absolute left-0 top-0 z-10 w-[58px] text-right text-[11px] font-medium text-muted-foreground">
					{axisUnit.label}
				</div>
			) : null}
			<ResponsiveContainer>
				<AreaChart
					data={data}
					margin={{
						top: axisUnit.label ? 22 : 10,
						right: 24,
						left: 0,
						bottom: 0,
					}}
				>
					<CartesianGrid
						strokeDasharray="3 3"
						stroke="#27272A"
						opacity={0.35}
					/>
					<YAxis
						stroke="#A1A1AA"
						domain={max ? [0, max] : undefined}
						tickFormatter={(value) => formatAxisTick(Number(value))}
						width={58}
					/>
					<Tooltip
						content={({ active, payload }) => {
							if (!active || !payload?.length) {
								return null;
							}
							const time = payload[0]?.payload?.time;
							return (
								<div className="rounded-md border bg-background p-2 text-xs shadow-lg">
									{time ? (
										<div className="mb-1 text-muted-foreground">
											{new Date(time).toLocaleString()}
										</div>
									) : null}
									{payload.map((item) => (
										<div
											key={String(item.dataKey)}
											style={{ color: item.color }}
										>
											{item.name}: {formatter(Number(item.value))}
										</div>
									))}
								</div>
							);
						}}
					/>
					<Legend />
					{keys.map((item) => (
						<Area
							key={String(item.key)}
							type="monotone"
							dataKey={String(item.key)}
							stroke={item.color}
							fill={item.color}
							fillOpacity={0.12}
							name={item.name}
						/>
					))}
				</AreaChart>
			</ResponsiveContainer>
		</div>
	);
};

export const ScanMonitoring = ({
	mode,
	scanJobId,
	taskId,
	title = "Monitoring",
	description,
}: ScanMonitoringProps) => {
	const [samples, setSamples] = useState<ScanMonitoringSample[]>([]);
	const [currentData, setCurrentData] =
		useState<ScanMonitoringSample>(emptySample);
	const [error, setError] = useState<string | null>(null);
	const [hasReceivedSample, setHasReceivedSample] = useState(false);

	useEffect(() => {
		setSamples([]);
		setCurrentData(emptySample);
		setError(null);
		setHasReceivedSample(false);

		if (!scanJobId || (mode === "task" && !taskId)) {
			return;
		}

		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const pagePath = window.location.pathname.replace(/\/+$/, "");
		const monitoringPath = `${pagePath}/monitoring`;
		const ws = new WebSocket(
			`${protocol}//${window.location.host}${monitoringPath}`,
		);

		ws.onmessage = (event) => {
			const message = JSON.parse(event.data) as ScanMonitoringMessage;
			if (message.error) {
				setError(message.error);
			}
			if (!message.data) {
				return;
			}
			setCurrentData(message.data);
			setHasReceivedSample(true);
			setSamples((previous) =>
				[...previous, message.data as ScanMonitoringSample].slice(-240),
			);
		};

		ws.onclose = (event) => {
			if (event.reason) {
				setError(event.reason);
			}
		};

		return () => ws.close();
	}, [mode, scanJobId, taskId]);

	const chartData = useMemo(() => buildChartData(samples), [samples]);
	const tokenThroughput = useTokenThroughput({ mode, scanJobId, taskId });
	const tokenChartData = useMemo(
		() => buildTokenChartData(tokenThroughput.samples),
		[tokenThroughput.samples],
	);
	const maxTaskTokensPerSecond = Math.max(
		1,
		...tokenThroughput.taskRates.map((rate) => rate.tokensPerSecond),
	);
	const memoryLimit = currentData.memory.limitBytes || undefined;
	const cpuCapacityPercent = currentData.cpu.capacityPercent || 100;
	const cpuCapacityVcpu = cpuCapacityPercent / 100;
	const cpuUsedVcpu = currentData.cpu.percent / 100;
	const noRunningContainers =
		hasReceivedSample && currentData.runningContainerCount === 0;

	return (
		<div className="flex flex-col gap-4">
			<header className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
				<div className="space-y-1">
					<h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
					<p className="text-sm text-muted-foreground">
						{description ||
							(mode === "job"
								? "Aggregated live usage for currently running scan tasks."
								: "Live usage for this scan task container.")}
					</p>
				</div>
				<div className="rounded-lg border px-3 py-2 text-sm">
					<span className="text-muted-foreground">Running containers: </span>
					<span className="font-medium">
						{currentData.runningContainerCount}
					</span>
				</div>
			</header>

			{error ? (
				<div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
					{error}
				</div>
			) : null}

			{noRunningContainers ? (
				<div className="rounded-lg border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
					No running container is currently available for this {mode}.
				</div>
			) : null}

			{!hasReceivedSample && !error ? (
				<div className="rounded-lg border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
					Connecting to live container stats...
				</div>
			) : null}

			<div className="grid gap-6 lg:grid-cols-2">
				<Card className="bg-background lg:col-span-2">
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="text-sm font-medium">
							Token Throughput
						</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="flex w-full flex-col gap-4">
							<div className="flex flex-col gap-1 text-sm text-muted-foreground md:flex-row md:items-center md:justify-between">
								<span>
									Current:{" "}
									<span className="font-medium text-foreground">
										{formatTokensPerSecond(
											tokenThroughput.aggregateTokensPerSecond,
										)}
									</span>
								</span>
								<span>
									Latest usage: {formatTokens(tokenThroughput.latestTokens)}
								</span>
							</div>
							<UsageChart
								data={tokenChartData}
								keys={[
									{
										key: "aggregateTokensPerSecond",
										name: mode === "job" ? "Job" : "Task",
										color: "#7C3AED",
									},
								]}
								formatter={formatTokensPerSecond}
								axisUnits={TOKEN_RATE_AXIS_UNITS}
							/>
							{mode === "job" ? (
								<div className="grid gap-2 md:grid-cols-2">
									{tokenThroughput.taskRates.length === 0 ? (
										<div className="text-sm text-muted-foreground">
											Waiting for token usage updates from running tasks.
										</div>
									) : (
										tokenThroughput.taskRates.map((rate) => (
											<div
												key={rate.taskId}
												className="rounded-md border bg-muted/10 px-3 py-2"
											>
												<div className="flex items-center justify-between gap-3 text-sm">
													<span className="min-w-0 truncate capitalize">
														{rate.label}
													</span>
													<span className="shrink-0 font-medium">
														{formatTokensPerSecond(rate.tokensPerSecond)}
													</span>
												</div>
												<div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
													<div
														className="h-full rounded-full bg-violet-600"
														style={{
															width: `${clampProgress(
																(rate.tokensPerSecond /
																	maxTaskTokensPerSecond) *
																	100,
															)}%`,
														}}
													/>
												</div>
												<div className="mt-1 text-xs text-muted-foreground">
													Latest: {formatTokens(rate.latestTokens)}
												</div>
											</div>
										))
									)}
								</div>
							) : null}
						</div>
					</CardContent>
				</Card>

				<Card className="bg-background">
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="text-sm font-medium">CPU Usage</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="flex w-full flex-col gap-2">
							<span className="text-sm text-muted-foreground">
								Used: {formatVcpu(cpuUsedVcpu)} / Capacity:{" "}
								{formatVcpu(cpuCapacityVcpu)} (
								{formatPercent(currentData.cpu.percent)})
							</span>
							<Progress
								value={clampProgress(
									(currentData.cpu.percent / cpuCapacityPercent) * 100,
								)}
								className="w-full"
							/>
							<UsageChart
								data={chartData}
								keys={[{ key: "cpuVcpu", name: "CPU", color: "#27272A" }]}
								max={cpuCapacityVcpu}
								formatter={formatVcpu}
								axisUnitLabel="vCPU"
							/>
						</div>
					</CardContent>
				</Card>

				<Card className="bg-background">
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="text-sm font-medium">Memory Usage</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="flex w-full flex-col gap-2">
							<span className="text-sm text-muted-foreground">
								Used: {formatBytes(currentData.memory.usedBytes)} / Limit:{" "}
								{formatBytes(currentData.memory.limitBytes)}
							</span>
							<Progress
								value={clampProgress(currentData.memory.percent)}
								className="w-full"
							/>
							<UsageChart
								data={chartData}
								keys={[
									{ key: "memoryBytes", name: "Memory", color: "#27272A" },
								]}
								max={memoryLimit}
								formatter={formatBytes}
								axisUnits={BYTE_AXIS_UNITS}
							/>
						</div>
					</CardContent>
				</Card>

				<Card className="bg-background">
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="text-sm font-medium">Block I/O</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="flex w-full flex-col gap-2">
							<span className="text-sm text-muted-foreground">
								Read: {formatBytes(currentData.block.readBytes)} / Write:{" "}
								{formatBytes(currentData.block.writeBytes)}
							</span>
							<UsageChart
								data={chartData}
								keys={[
									{ key: "blockReadBytes", name: "Read", color: "#27272A" },
									{ key: "blockWriteBytes", name: "Write", color: "#82CA9D" },
								]}
								formatter={formatBytes}
								axisUnits={BYTE_AXIS_UNITS}
							/>
						</div>
					</CardContent>
				</Card>

				<Card className="bg-background">
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="text-sm font-medium">Network I/O</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="flex w-full flex-col gap-2">
							<span className="text-sm text-muted-foreground">
								In: {formatBytes(currentData.network.rxBytes)} / Out:{" "}
								{formatBytes(currentData.network.txBytes)}
							</span>
							<UsageChart
								data={chartData}
								keys={[
									{ key: "networkRxBytes", name: "In", color: "#8884D8" },
									{ key: "networkTxBytes", name: "Out", color: "#82CA9D" },
								]}
								formatter={formatBytes}
								axisUnits={BYTE_AXIS_UNITS}
							/>
						</div>
					</CardContent>
				</Card>
			</div>
		</div>
	);
};
