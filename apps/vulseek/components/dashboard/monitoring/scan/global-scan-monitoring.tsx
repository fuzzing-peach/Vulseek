import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "next-i18next";
import {
	Area,
	AreaChart,
	CartesianGrid,
	Legend,
	ResponsiveContainer,
	Tooltip,
	YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { scanT } from "@/components/dashboard/scanning/scan-i18n";

type TaskTokenSnapshot = {
	taskId: string;
	label: string;
	totalTokens: number;
	cachedReadTokens: number;
};

type TokenSnapshot = {
	timestampMs: number;
	totalTokens: number;
	cachedReadTokens: number;
	tasks: TaskTokenSnapshot[];
};

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
	tokenSnapshot?: TokenSnapshot;
	activeJobCount?: number;
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
};

type TokenThroughputSample = {
	time: string;
	aggregateTokensPerSecond: number;
};

const emptySample: ScanMonitoringSample = {
	time: "",
	runningContainerCount: 0,
	containers: [],
	cpu: { percent: 0, capacityPercent: 100 },
	memory: { usedBytes: 0, limitBytes: 0, percent: 0 },
	block: { readBytes: 0, writeBytes: 0 },
	network: { rxBytes: 0, txBytes: 0 },
	tokenSnapshot: { timestampMs: 0, totalTokens: 0, cachedReadTokens: 0, tasks: [] },
	activeJobCount: 0,
};

const clampProgress = (value: number) =>
	Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));

const formatPercent = (value: number) =>
	`${(Number.isFinite(value) ? value : 0).toFixed(2)}%`;

const formatVcpu = (value: number) =>
	`${(Number.isFinite(value) ? value : 0).toFixed(2)} vCPU`;

const formatBytes = (value: number) => {
	if (!Number.isFinite(value) || value <= 0) return "0 B";
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

type AxisUnitOption = { label: string; scale: number };

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
	if (!units?.length) return { label: "", scale: 1 };
	const safeValue = Math.abs(Number.isFinite(value) ? value : 0);
	let resolved = units[0] || { label: "", scale: 1 };
	for (const unit of units) {
		if (safeValue >= unit.scale) resolved = unit;
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
		aggregateTokensPerSecond: Number(sample.aggregateTokensPerSecond.toFixed(2)),
	}));

const MONITORING_SAMPLE_LIMIT = 240;

const UsageChart = ({
	data,
	keys,
	max,
	formatter,
	axisUnitLabel,
	axisUnits,
}: {
	data: Array<Record<string, number | string>>;
	keys: { key: string; name: string; color: string }[];
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
					margin={{ top: axisUnit.label ? 22 : 10, right: 24, left: 0, bottom: 0 }}
				>
					<CartesianGrid strokeDasharray="3 3" stroke="#27272A" opacity={0.35} />
					<YAxis
						stroke="#A1A1AA"
						domain={max ? [0, max] : undefined}
						tickFormatter={(value) => formatAxisTick(Number(value))}
						width={58}
					/>
					<Tooltip
						content={({ active, payload }) => {
							if (!active || !payload?.length) return null;
							const time = payload[0]?.payload?.time;
							return (
								<div className="rounded-md border bg-background p-2 text-xs shadow-lg">
									{time ? (
										<div className="mb-1 text-muted-foreground">
											{new Date(time).toLocaleString()}
										</div>
									) : null}
									{payload.map((item) => (
										<div key={String(item.dataKey)} style={{ color: item.color }}>
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

export const GlobalScanMonitoring = () => {
	const { t } = useTranslation("scan");
	const [samples, setSamples] = useState<ScanMonitoringSample[]>([]);
	const [currentData, setCurrentData] = useState<ScanMonitoringSample>(emptySample);
	const [error, setError] = useState<string | null>(null);
	const [hasReceivedSample, setHasReceivedSample] = useState(false);

	useEffect(() => {
		setSamples([]);
		setCurrentData(emptySample);
		setError(null);
		setHasReceivedSample(false);

		let ws: WebSocket | null = null;
		let disposed = false;
		const connectTimer = window.setTimeout(() => {
			if (disposed) return;
			const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
			ws = new WebSocket(
				`${protocol}//${window.location.host}/dashboard/monitoring/scan-stats`,
			);

			ws.onmessage = (event) => {
				const message = JSON.parse(event.data) as ScanMonitoringMessage;
				if (disposed) return;
				if (message.error) setError(message.error);
				if (!message.data) return;
				setCurrentData(message.data);
				setHasReceivedSample(true);
				setSamples((previous) =>
					[...previous, message.data as ScanMonitoringSample].slice(-240),
				);
			};

			ws.onclose = (event) => {
				if (!disposed && event.reason) setError(event.reason);
			};
		}, 0);

		return () => {
			disposed = true;
			window.clearTimeout(connectTimer);
			ws?.close();
		};
	}, []);

	const prevSnapshotRef = useRef<TokenSnapshot | null>(null);
	const [tokenSamples, setTokenSamples] = useState<TokenThroughputSample[]>([]);
	const [tokenRates, setTokenRates] = useState<TokenThroughputTaskRate[]>([]);
	const [aggregateTokensPerSecond, setAggregateTokensPerSecond] = useState(0);
	const [latestTokens, setLatestTokens] = useState(0);

	useEffect(() => {
		const snap = currentData.tokenSnapshot;
		if (!snap || snap.timestampMs === 0) return;
		const prev = prevSnapshotRef.current;
		const elapsedSeconds =
			prev && snap.timestampMs > prev.timestampMs
				? (snap.timestampMs - prev.timestampMs) / 1000
				: 0;
		const aggRate =
			elapsedSeconds > 0
				? (snap.totalTokens - (prev?.totalTokens ?? 0)) / elapsedSeconds
				: 0;
		const nextTaskRates: TokenThroughputTaskRate[] = snap.tasks.map((task) => {
			const prevTask = prev?.tasks.find((t) => t.taskId === task.taskId);
			const taskRate =
				elapsedSeconds > 0 && prevTask
					? (task.totalTokens - prevTask.totalTokens) / elapsedSeconds
					: 0;
			return {
				taskId: task.taskId,
				label: task.label,
				tokensPerSecond: Math.max(0, taskRate),
				latestTokens: task.totalTokens,
			};
		});
		setAggregateTokensPerSecond(Math.max(0, aggRate));
		setLatestTokens(snap.totalTokens);
		setTokenRates(
			[...nextTaskRates].sort((a, b) =>
				b.tokensPerSecond === a.tokensPerSecond
					? b.latestTokens - a.latestTokens
					: b.tokensPerSecond - a.tokensPerSecond,
			),
		);
		setTokenSamples((prev) =>
			[
				...prev,
				{
					time: new Date(snap.timestampMs).toISOString(),
					aggregateTokensPerSecond: Math.max(0, aggRate),
				},
			].slice(-MONITORING_SAMPLE_LIMIT),
		);
		prevSnapshotRef.current = snap;
	}, [currentData.tokenSnapshot]);

	const chartData = useMemo(() => buildChartData(samples), [samples]);
	const tokenChartData = useMemo(() => buildTokenChartData(tokenSamples), [tokenSamples]);
	const maxTaskTokensPerSecond = Math.max(
		1,
		...tokenRates.map((rate) => rate.tokensPerSecond),
	);
	const cpuCapacityPercent = currentData.cpu.capacityPercent || 100;
	const cpuCapacityVcpu = cpuCapacityPercent / 100;
	const cpuUsedVcpu = currentData.cpu.percent / 100;
	const noRunningContainers = hasReceivedSample && currentData.runningContainerCount === 0;
	const activeJobCount = currentData.activeJobCount ?? 0;

	return (
		<div className="flex flex-col gap-4">
			<header className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
				<div className="space-y-1">
					<h2 className="text-2xl font-semibold tracking-tight">
						{scanT(t, "scan.monitoring.globalTitle", "Global Scan Activity")}
					</h2>
					<p className="text-sm text-muted-foreground">
						{scanT(
							t,
							"scan.monitoring.globalDescription",
							"Aggregated live usage across all running scan tasks.",
						)}
					</p>
				</div>
				<div className="flex flex-row gap-2">
					<div className="rounded-lg border px-3 py-2 text-sm">
						<span className="text-muted-foreground">
							{scanT(t, "scan.monitoring.activeJobs", "Active jobs:")}{" "}
						</span>
						<span className="font-medium">{activeJobCount}</span>
					</div>
					<div className="rounded-lg border px-3 py-2 text-sm">
						<span className="text-muted-foreground">
							{scanT(t, "scan.monitoring.runningContainers", "Running containers:")}{" "}
						</span>
						<span className="font-medium">{currentData.runningContainerCount}</span>
					</div>
				</div>
			</header>

			{error ? (
				<div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-500/60 dark:bg-amber-950/50 dark:text-amber-100">
					{error}
				</div>
			) : null}

			{noRunningContainers ? (
				<div className="rounded-lg border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
					{scanT(
						t,
						"scan.monitoring.noRunningContainer",
						"No running container is currently available for this {{mode}}.",
						{ mode: "global" },
					)}
				</div>
			) : null}

			{!hasReceivedSample && !error ? (
				<div className="rounded-lg border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
					{scanT(
						t,
						"scan.monitoring.connectingStats",
						"Connecting to live container stats...",
					)}
				</div>
			) : null}

			<div className="grid gap-6 lg:grid-cols-2">
				<Card className="bg-background lg:col-span-2">
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="text-sm font-medium">
							{scanT(t, "scan.monitoring.tokenThroughput", "Token Throughput")}
						</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="flex w-full flex-col gap-4">
							<div className="flex flex-col gap-1 text-sm text-muted-foreground md:flex-row md:items-center md:justify-between">
								<span>
									{scanT(t, "scan.monitoring.current", "Current:")}{" "}
									<span className="font-medium text-foreground">
										{formatTokensPerSecond(aggregateTokensPerSecond)}
									</span>
								</span>
								<span>
									{scanT(t, "scan.monitoring.latestUsage", "Latest usage:")}{" "}
									{formatTokens(latestTokens)}
								</span>
							</div>
							<UsageChart
								data={tokenChartData}
								keys={[
									{
										key: "aggregateTokensPerSecond",
										name: scanT(t, "scan.monitoring.globalTitle", "Global Scan Activity"),
										color: "#7C3AED",
									},
								]}
								formatter={formatTokensPerSecond}
								axisUnits={TOKEN_RATE_AXIS_UNITS}
							/>
							<div className="grid gap-2 md:grid-cols-2">
								{tokenRates.length === 0 ? (
									<div className="text-sm text-muted-foreground">
										{scanT(
											t,
											"scan.monitoring.waitingTokens",
											"Waiting for token usage updates from running tasks.",
										)}
									</div>
								) : (
									tokenRates.map((rate) => (
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
															(rate.tokensPerSecond / maxTaskTokensPerSecond) * 100,
														)}%`,
													}}
												/>
											</div>
											<div className="mt-1 text-xs text-muted-foreground">
												{scanT(t, "scan.monitoring.latest", "Latest:")}{" "}
												{formatTokens(rate.latestTokens)}
											</div>
										</div>
									))
								)}
							</div>
						</div>
					</CardContent>
				</Card>

				<Card className="bg-background">
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="text-sm font-medium">
							{scanT(t, "scan.monitoring.cpuUsage", "CPU Usage")}
						</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="flex w-full flex-col gap-2">
							<span className="text-sm text-muted-foreground">
								{scanT(t, "scan.monitoring.used", "Used:")}{" "}
								{formatVcpu(cpuUsedVcpu)} /{" "}
								{scanT(t, "scan.monitoring.capacity", "Capacity:")}{" "}
								{formatVcpu(cpuCapacityVcpu)} (
								{formatPercent(currentData.cpu.percent)})
							</span>
							<Progress
								value={clampProgress((currentData.cpu.percent / cpuCapacityPercent) * 100)}
								className="w-full"
							/>
							<UsageChart
								data={chartData}
								keys={[{ key: "cpuVcpu", name: scanT(t, "scan.monitoring.cpu", "CPU"), color: "#27272A" }]}
								formatter={formatVcpu}
								axisUnitLabel="vCPU"
							/>
						</div>
					</CardContent>
				</Card>

				<Card className="bg-background">
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="text-sm font-medium">
							{scanT(t, "scan.monitoring.memoryUsage", "Memory Usage")}
						</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="flex w-full flex-col gap-2">
							<span className="text-sm text-muted-foreground">
								{scanT(t, "scan.monitoring.used", "Used:")}{" "}
								{formatBytes(currentData.memory.usedBytes)} /{" "}
								{scanT(t, "scan.monitoring.limit", "Limit:")}{" "}
								{formatBytes(currentData.memory.limitBytes)}
							</span>
							<Progress
								value={clampProgress(currentData.memory.percent)}
								className="w-full"
							/>
							<UsageChart
								data={chartData}
								keys={[{ key: "memoryBytes", name: scanT(t, "scan.monitoring.memory", "Memory"), color: "#27272A" }]}
								formatter={formatBytes}
								axisUnits={BYTE_AXIS_UNITS}
							/>
						</div>
					</CardContent>
				</Card>

				<Card className="bg-background">
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="text-sm font-medium">
							{scanT(t, "scan.monitoring.blockIo", "Block I/O")}
						</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="flex w-full flex-col gap-2">
							<span className="text-sm text-muted-foreground">
								{scanT(t, "scan.monitoring.read", "Read:")}{" "}
								{formatBytes(currentData.block.readBytes)} /{" "}
								{scanT(t, "scan.monitoring.write", "Write:")}{" "}
								{formatBytes(currentData.block.writeBytes)}
							</span>
							<UsageChart
								data={chartData}
								keys={[
									{ key: "blockReadBytes", name: scanT(t, "scan.monitoring.read", "Read:"), color: "#27272A" },
									{ key: "blockWriteBytes", name: scanT(t, "scan.monitoring.write", "Write:"), color: "#82CA9D" },
								]}
								formatter={formatBytes}
								axisUnits={BYTE_AXIS_UNITS}
							/>
						</div>
					</CardContent>
				</Card>

				<Card className="bg-background">
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="text-sm font-medium">
							{scanT(t, "scan.monitoring.networkIo", "Network I/O")}
						</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="flex w-full flex-col gap-2">
							<span className="text-sm text-muted-foreground">
								{scanT(t, "scan.monitoring.in", "In:")}{" "}
								{formatBytes(currentData.network.rxBytes)} /{" "}
								{scanT(t, "scan.monitoring.out", "Out:")}{" "}
								{formatBytes(currentData.network.txBytes)}
							</span>
							<UsageChart
								data={chartData}
								keys={[
									{ key: "networkRxBytes", name: scanT(t, "scan.monitoring.in", "In:"), color: "#8884D8" },
									{ key: "networkTxBytes", name: scanT(t, "scan.monitoring.out", "Out:"), color: "#82CA9D" },
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
