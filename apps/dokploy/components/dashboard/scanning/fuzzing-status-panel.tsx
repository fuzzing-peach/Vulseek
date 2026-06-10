import { useEffect, useMemo, useRef, useState } from "react";
import {
	CartesianGrid,
	Legend,
	Line,
	LineChart,
	ResponsiveContainer,
	Tooltip,
	YAxis,
} from "recharts";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

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

type FuzzProgressMetadata = {
	taskId: string;
	scanJobId: string;
	taskKind: string;
	status: string;
	containerName?: string | null;
	provider?: "codex" | "claude";
	progressFileName?: string;
	fileExists?: boolean;
	fileStatError?: string | null;
};

type ConnectionStatus = "connecting" | "connected" | "waiting" | "closed" | "error";

type FuzzingStatusPanelProps = {
	taskId: string;
};

const SAMPLE_LIMIT = 240;
const RAW_TAIL_LIMIT = 80;

const isFiniteNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);

const formatCompactNumber = (value?: number) => {
	const safeValue = isFiniteNumber(value) ? value : 0;
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

const formatAxisDecimal = (value: number) =>
	(Number.isFinite(value) ? value : 0)
		.toFixed(2)
		.replace(/\.00$/, "")
		.replace(/(\.\d)0$/, "$1");

const formatNumber = (value?: number) =>
	isFiniteNumber(value) ? new Intl.NumberFormat().format(value) : "-";

const formatRate = (value?: number) =>
	isFiniteNumber(value) ? `${formatCompactNumber(value)} exec/s` : "-";

const formatRuntime = (record?: FuzzProgressRecord) => {
	if (!record) {
		return "-";
	}
	if (record.runTimePretty) {
		return record.runTimePretty;
	}
	if (!isFiniteNumber(record.runTimeMs)) {
		return "-";
	}
	const totalSeconds = Math.floor(record.runTimeMs / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) {
		return `${hours}h ${minutes}m ${seconds}s`;
	}
	if (minutes > 0) {
		return `${minutes}m ${seconds}s`;
	}
	return `${seconds}s`;
};

const formatCoverage = (record?: FuzzProgressRecord) => {
	const coverage = record?.coverage;
	if (!coverage) {
		return "-";
	}
	const percent = isFiniteNumber(coverage.edgeCoveragePercent)
		? `${coverage.edgeCoveragePercent.toFixed(2)}%`
		: null;
	const edges =
		isFiniteNumber(coverage.edgesHit) && isFiniteNumber(coverage.edgesTotal)
			? `${formatNumber(coverage.edgesHit)} / ${formatNumber(coverage.edgesTotal)}`
			: null;
	return [percent, edges].filter(Boolean).join(" ") || "-";
};

const stringifyValue = (value: unknown) => {
	if (value === null || value === undefined) {
		return "";
	}
	if (typeof value === "string") {
		return value;
	}
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
};

const getRecordTime = (record: FuzzProgressRecord) => {
	if (record.timestamp) {
		return record.timestamp;
	}
	return "";
};

const buildChartData = (records: FuzzProgressRecord[]) =>
	records
		.filter(
			(record) =>
				isFiniteNumber(record.totalExecs) || isFiniteNumber(record.corpusSize),
		)
		.slice(-SAMPLE_LIMIT)
		.map((record, index) => ({
			name: `Point ${index + 1}`,
			time: getRecordTime(record),
			totalExecs: Number(record.totalExecs || 0),
			corpusSize: Number(record.corpusSize || 0),
		}));

const MetricCard = ({
	label,
	value,
}: {
	label: string;
	value: string;
}) => (
	<div className="rounded-lg border bg-background px-3 py-2">
		<div className="text-xs text-muted-foreground">{label}</div>
		<div className="mt-1 truncate text-sm font-medium">{value}</div>
	</div>
);

const FuzzLineChart = ({
	title,
	dataKey,
	color,
	data,
	formatter,
	axisLabel,
}: {
	title: string;
	dataKey: "totalExecs" | "corpusSize";
	color: string;
	data: Array<Record<string, number | string>>;
	formatter: (value: number) => string;
	axisLabel: string;
}) => (
	<Card className="bg-background">
		<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
			<CardTitle className="text-sm font-medium">{title}</CardTitle>
		</CardHeader>
		<CardContent>
			<div className="relative mt-2 h-44 w-full">
				<div className="pointer-events-none absolute left-0 top-0 z-10 w-[58px] text-right text-[11px] font-medium text-muted-foreground">
					{axisLabel}
				</div>
				<ResponsiveContainer>
					<LineChart
						data={data}
						margin={{ top: 22, right: 24, left: 0, bottom: 0 }}
					>
						<CartesianGrid
							strokeDasharray="3 3"
							stroke="#27272A"
							opacity={0.35}
						/>
						<YAxis
							stroke="#A1A1AA"
							tickFormatter={(value) => formatCompactNumber(Number(value))}
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
												{new Date(String(time)).toLocaleString()}
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
						<Line
							type="monotone"
							dataKey={dataKey}
							stroke={color}
							dot={false}
							name={title}
							strokeWidth={2}
						/>
					</LineChart>
				</ResponsiveContainer>
			</div>
		</CardContent>
	</Card>
);

export const FuzzingStatusPanel = ({ taskId }: FuzzingStatusPanelProps) => {
	const [records, setRecords] = useState<FuzzProgressRecord[]>([]);
	const [metadata, setMetadata] = useState<FuzzProgressMetadata | null>(null);
	const [connectionStatus, setConnectionStatus] =
		useState<ConnectionStatus>("connecting");
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [autoFollowTail, setAutoFollowTail] = useState(true);
	const rawTailRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (!taskId || typeof window === "undefined") {
			return;
		}

		setRecords([]);
		setMetadata(null);
		setConnectionStatus("connecting");
		setErrorMessage(null);
		setAutoFollowTail(true);

		const eventSource = new EventSource(
			`/api/scan/tasks/${encodeURIComponent(taskId)}/fuzz-progress`,
		);
		eventSource.onopen = () => {
			setConnectionStatus("connected");
		};
		eventSource.addEventListener("snapshot", (event) => {
			const payload = JSON.parse((event as MessageEvent).data) as {
				metadata?: FuzzProgressMetadata;
				records?: FuzzProgressRecord[];
				waiting?: boolean;
			};
			setMetadata(payload.metadata || null);
			setRecords(payload.records || []);
			setConnectionStatus(payload.waiting ? "waiting" : "connected");
			setErrorMessage(null);
		});
		eventSource.addEventListener("delta", (event) => {
			const payload = JSON.parse((event as MessageEvent).data) as {
				records?: FuzzProgressRecord[];
			};
			if (!payload.records?.length) {
				return;
			}
			setRecords((current) => [...current, ...(payload.records || [])]);
			setConnectionStatus("connected");
			setErrorMessage(null);
		});
		eventSource.addEventListener("waiting", (event) => {
			const payload = JSON.parse((event as MessageEvent).data) as {
				metadata?: FuzzProgressMetadata;
			};
			if (payload.metadata) {
				setMetadata(payload.metadata);
			}
			setConnectionStatus("waiting");
			setErrorMessage(null);
		});
		eventSource.addEventListener("done", (event) => {
			const payload = JSON.parse((event as MessageEvent).data) as {
				status?: string;
			};
			const status = payload.status;
			if (status) {
				setMetadata((current) =>
					current ? { ...current, status } : current,
				);
			}
			setConnectionStatus("closed");
			eventSource.close();
		});
		eventSource.addEventListener("fuzz_progress_error", (event) => {
			const payload = JSON.parse((event as MessageEvent).data) as {
				message?: string;
			};
			setConnectionStatus("error");
			setErrorMessage(payload.message || "Fuzz progress stream failed");
		});
		eventSource.onerror = () => {
			setConnectionStatus("error");
			setErrorMessage("Fuzz progress stream disconnected");
		};

		return () => {
			eventSource.close();
		};
	}, [taskId]);

	const chartData = useMemo(() => buildChartData(records), [records]);
	const latestRecord = useMemo(
		() =>
			[...records]
				.reverse()
				.find(
					(record) =>
						!record.parseError &&
						(record.eventMsg ||
							isFiniteNumber(record.totalExecs) ||
							isFiniteNumber(record.execsPerSec) ||
							isFiniteNumber(record.corpusSize) ||
							isFiniteNumber(record.objectiveSize) ||
							!!record.coverage ||
							!!record.userStats),
				),
		[records],
	);
	const rawTail = useMemo(() => records.slice(-RAW_TAIL_LIMIT), [records]);
	const statusLabel =
		connectionStatus === "waiting"
			? "Waiting"
			: connectionStatus === "connected"
				? "Connected"
				: connectionStatus === "closed"
					? "Closed"
					: connectionStatus === "error"
						? "Error"
						: "Connecting";

	useEffect(() => {
		const element = rawTailRef.current;
		if (!element || !autoFollowTail) {
			return;
		}
		element.scrollTop = element.scrollHeight;
	}, [autoFollowTail, rawTail]);

	const handleRawTailScroll = () => {
		const element = rawTailRef.current;
		if (!element) {
			return;
		}
		const distanceFromBottom =
			element.scrollHeight - element.scrollTop - element.clientHeight;
		setAutoFollowTail(distanceFromBottom < 24);
	};

	return (
		<div className="flex flex-col gap-4">
			<header className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
				<div className="space-y-1">
					<h2 className="text-2xl font-semibold tracking-tight">
						Fuzzing Status
					</h2>
					<p className="text-sm text-muted-foreground">
						Live LibAFL progress from the task runtime directory.
					</p>
				</div>
				<Badge
					variant="outline"
					className={cn(
						"w-fit",
						connectionStatus === "connected" &&
							"border-emerald-200 bg-emerald-100 text-emerald-700 dark:border-emerald-500/60 dark:bg-emerald-950/50 dark:text-emerald-100",
						connectionStatus === "waiting" &&
							"border-amber-200 bg-amber-100 text-amber-700 dark:border-amber-500/60 dark:bg-amber-950/50 dark:text-amber-100",
						connectionStatus === "error" &&
							"border-red-200 bg-red-100 text-red-700 dark:border-red-500/60 dark:bg-red-950/50 dark:text-red-100",
					)}
				>
					{statusLabel}
				</Badge>
			</header>

			{errorMessage ? (
				<div className="rounded-lg border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
					{errorMessage}
				</div>
			) : null}

			{connectionStatus === "waiting" ? (
				<div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-500/60 dark:bg-amber-950/50 dark:text-amber-100">
					Waiting for {metadata?.progressFileName || "fuzz-progress.jsonl"} in
					the task runtime directory.
				</div>
			) : null}

			<div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
				<MetricCard
					label="Execs / Sec"
					value={formatRate(latestRecord?.execsPerSec)}
				/>
				<MetricCard
					label="Objectives"
					value={formatNumber(latestRecord?.objectiveSize)}
				/>
				<MetricCard label="Coverage" value={formatCoverage(latestRecord)} />
				<MetricCard label="Runtime" value={formatRuntime(latestRecord)} />
				<MetricCard label="Log Records" value={formatNumber(records.length)} />
				<MetricCard label="Task State" value={metadata?.status || "-"} />
			</div>

			<div className="grid gap-6 lg:grid-cols-2">
				<FuzzLineChart
					title="Execs"
					dataKey="totalExecs"
					color="#27272A"
					data={chartData}
					formatter={(value) => `${formatCompactNumber(value)} execs`}
					axisLabel="execs"
				/>
				<FuzzLineChart
					title="Corpus"
					dataKey="corpusSize"
					color="#82CA9D"
					data={chartData}
					formatter={(value) => `${formatCompactNumber(value)} inputs`}
					axisLabel="inputs"
				/>
			</div>

			<Card className="bg-background">
				<CardHeader className="pb-2">
					<CardTitle className="text-sm font-medium">Latest Event</CardTitle>
				</CardHeader>
				<CardContent>
					<div className="space-y-3">
						<div className="whitespace-pre-wrap break-words text-sm">
							{latestRecord?.eventMsg || "No LibAFL event has been recorded yet."}
						</div>
						{latestRecord?.userStats &&
						Object.keys(latestRecord.userStats).length > 0 ? (
							<div className="grid gap-2 md:grid-cols-2">
								{Object.entries(latestRecord.userStats).map(([key, value]) => (
									<div key={key} className="rounded-md border bg-muted/10 px-3 py-2">
										<div className="text-xs text-muted-foreground">{key}</div>
										<div className="mt-1 break-words font-mono text-xs">
											{stringifyValue(value)}
										</div>
									</div>
								))}
							</div>
						) : null}
					</div>
				</CardContent>
			</Card>

			<Card className="bg-background">
				<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
					<CardTitle className="text-sm font-medium">Raw JSONL Tail</CardTitle>
					<span className="text-xs text-muted-foreground">
						{autoFollowTail ? "Following" : "Paused"}
					</span>
				</CardHeader>
				<CardContent>
					<div
						ref={rawTailRef}
						onScroll={handleRawTailScroll}
						className="max-h-72 overflow-auto rounded-md border bg-muted/20 p-3 font-mono text-xs"
					>
						{rawTail.length === 0 ? (
							<div className="text-muted-foreground">No records yet.</div>
						) : (
							rawTail.map((record) => (
								<div
									key={record.line}
									className={cn(
										"whitespace-pre-wrap break-words py-0.5",
										record.parseError && "text-red-600 dark:text-red-300",
									)}
								>
									<span className="select-none text-muted-foreground">
										{record.line}{" "}
									</span>
									{record.raw}
								</div>
							))
						)}
					</div>
				</CardContent>
			</Card>
		</div>
	);
};
