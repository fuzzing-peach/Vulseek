import {
	AlertCircle,
	ArrowLeft,
	ChevronRight,
	FileIcon,
	Folder,
	Loader2,
	RefreshCw,
} from "lucide-react";
import { format } from "date-fns";
import Head from "next/head";
import Link from "next/link";
import { useRouter } from "next/router";
import { type ReactNode, useEffect, useState } from "react";
import JsonView from "react18-json-view";
import { toast } from "sonner";
import { FuzzingStatusPanel } from "@/components/dashboard/scanning/fuzzing-status-panel";
import { ScanMonitoring } from "@/components/dashboard/scanning/scan-monitoring";
import { BreadcrumbSidebar } from "@/components/shared/breadcrumb-sidebar";
import { CopyValueButton } from "@/components/shared/copy-value-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { api } from "@/utils/api";

interface Props {
	serviceType: "application" | "compose";
	routeSegment: "profiles" | "services";
}

const ACTIVE_TASK_STATUSES = new Set(["pending", "launching", "running"]);
const RERUNNABLE_TASK_STATUSES = new Set(["completed", "failed", "exited"]);
const ROOT_DIRECTORY_KEY = "__root__";

type ScanTaskTab = "details" | "monitoring" | "fuzzing" | "files";

type DirectoryListItem = {
	id: string;
	name: string;
	type: "file" | "directory";
	hasChildren?: boolean;
};

type DirectoryCacheEntry = {
	items: DirectoryListItem[];
	status: "idle" | "loading" | "loaded" | "error";
};

const getTaskStageLabel = (stage?: string | null) => {
	if (
		stage === "Scan Repository" ||
		stage === "repository-scan" ||
		stage === "repository_scanning"
	) {
		return "Scan Repository";
	}
	if (
		stage === "Scan Module" ||
		stage === "module-scan" ||
		stage === "module_scanning"
	) {
		return "Scan Module";
	}
	if (
		stage === "Scan Function" ||
		stage === "function-scan" ||
		stage === "function_scanning"
	) {
		return "Scan Function";
	}
	if (stage === "Analyze" || stage === "analyze" || stage === "analyzing") {
		return "Analyze";
	}
	if (
		stage === "Build Fuzzer" ||
		stage === "build-fuzzer" ||
		stage === "fuzz_building"
	) {
		return "Build Fuzzer";
	}
	if (stage === "Run Fuzzer" || stage === "run-fuzzer" || stage === "fuzzing") {
		return "Run Fuzzer";
	}
	if (
		stage === "Criticize" ||
		stage === "criticize" ||
		stage === "criticizing"
	) {
		return "Criticize";
	}
	if (stage === "Verify" || stage === "verify" || stage === "verifying") {
		return "Verify";
	}
	if (stage === "Triage" || stage === "triage" || stage === "triaging") {
		return "Triage";
	}
	return stage || "-";
};

const isRunFuzzerStage = (stage?: string | null) =>
	stage === "Run Fuzzer" || stage === "run-fuzzer" || stage === "fuzzing";

const getTaskStatusLabel = (status?: string | null) => {
	if (!status) {
		return "-";
	}
	return status.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
};

const getTaskStatusBadgeClassName = (status?: string | null) => {
	if (status === "completed") {
		return "border-emerald-200 bg-emerald-100 text-emerald-700";
	}
	if (status === "failed") {
		return "border-red-200 bg-red-100 text-red-700";
	}
	if (status === "running" || status === "launching") {
		return "border-sky-200 bg-sky-100 text-sky-700";
	}
	if (status === "pending") {
		return "border-amber-200 bg-amber-100 text-amber-700";
	}
	if (status === "exited") {
		return "border-muted-foreground/20 bg-muted text-muted-foreground";
	}
	return "border-muted-foreground/20 bg-muted text-muted-foreground";
};

const formatValue = (value?: string | number | null) => {
	if (value === null || value === undefined || value === "") {
		return "-";
	}
	return String(value);
};

const formatTokenUsage = (value?: number | null) => {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return "-";
	}
	return `${new Intl.NumberFormat().format(value)} tokens`;
};

const formatTokenCount = (value?: number | null) => {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return "-";
	}
	return new Intl.NumberFormat().format(value);
};

const formatTokenUsageWithCache = (
	total?: number | null,
	cached?: number | null,
	cacheLabel = "cache read",
) => {
	const totalValue = formatTokenCount(total);
	if (totalValue === "-") {
		return "-";
	}
	const cachedValue = formatTokenCount(cached);
	return cachedValue === "-"
		? `${totalValue} tokens`
		: `${totalValue} / ${cachedValue} ${cacheLabel}`;
};

const stringifyJson = (value: unknown) => {
	if (value === null || value === undefined) {
		return "";
	}
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
};

const getJsonSummary = (value: unknown) => {
	if (Array.isArray(value)) {
		return `${value.length} item${value.length === 1 ? "" : "s"}`;
	}
	if (value && typeof value === "object") {
		const keyCount = Object.keys(value).length;
		return `${keyCount} key${keyCount === 1 ? "" : "s"}`;
	}
	return typeof value;
};

const formatDateTime = (value?: string | null) => {
	if (!value) {
		return "-";
	}
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) {
		return value;
	}
	return format(date, "yyyy-MM-dd HH:mm:ss");
};

const DetailField = ({
	label,
	value,
	copyLabel,
	date,
	href,
	badgeClassName,
}: {
	label: string;
	value?: string | number | null;
	copyLabel?: string;
	date?: string | null;
	href?: string;
	badgeClassName?: string;
}) => {
	const displayValue = date ? formatDateTime(date) : formatValue(value);
	const content = badgeClassName ? (
		<Badge variant="outline" className={badgeClassName}>
			{displayValue}
		</Badge>
	) : href && displayValue !== "-" ? (
		<Link
			href={href}
			className="min-w-0 flex-1 cursor-pointer rounded-sm transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
		>
			{displayValue}
		</Link>
	) : (
		<span className="min-w-0 flex-1">{displayValue}</span>
	);
	return (
		<div
			className={cn(
				"rounded-lg border p-3 transition-colors",
				href && "hover:bg-muted/40",
			)}
		>
			<div className="text-sm text-muted-foreground">{label}</div>
			<div className="mt-1 flex min-h-5 items-start gap-2 break-all font-medium">
				{content}
				{displayValue !== "-" ? (
					<CopyValueButton
						value={displayValue}
						label={copyLabel || label}
						className="size-6 shrink-0"
					/>
				) : null}
			</div>
		</div>
	);
};

const DetailSection = ({
	title,
	children,
}: {
	title: string;
	children: ReactNode;
}) => (
	<section className="rounded-lg border p-4">
		<div className="mb-4 text-lg font-semibold">{title}</div>
		{children}
	</section>
);

const JsonBlock = ({ label, value }: { label: string; value: unknown }) => {
	const json = stringifyJson(value);
	if (!json) {
		return null;
	}
	return (
		<div className="rounded-lg border">
			<div className="flex items-center justify-between gap-3 border-b px-3 py-2">
				<div className="min-w-0">
					<div className="text-sm font-medium">{label}</div>
					<div className="text-xs text-muted-foreground">
						{getJsonSummary(value)}
					</div>
				</div>
				<CopyValueButton
					value={json}
					label={label}
					className="size-7 shrink-0"
				/>
			</div>
			<div className="max-h-[420px] overflow-auto bg-muted/20 p-3 font-mono text-xs leading-5">
				<JsonView
					src={value}
					collapsed={false}
					displaySize="collapsed"
					enableClipboard={false}
				/>
			</div>
		</div>
	);
};

type LazyFileTreeProps = {
	rootItems: DirectoryListItem[];
	rootStatus: DirectoryCacheEntry["status"];
	expandedDirectories: Record<string, boolean>;
	selectedFilePath: string | null;
	directoryCache: Record<string, DirectoryCacheEntry>;
	onToggleDirectory: (directoryPath: string) => void;
	onSelectFile: (filePath: string) => void;
};

const LazyFileTree = ({
	rootItems,
	rootStatus,
	expandedDirectories,
	selectedFilePath,
	directoryCache,
	onToggleDirectory,
	onSelectFile,
}: LazyFileTreeProps) => {
	const renderItems = (items: DirectoryListItem[], depth = 0): ReactNode =>
		items.map((item) => {
			const isDirectory = item.type === "directory";
			const isExpanded = !!expandedDirectories[item.id];
			const cacheEntry = directoryCache[item.id];
			const childStatus = cacheEntry?.status || "idle";
			const childItems = cacheEntry?.items || [];

			return (
				<div key={item.id}>
					<button
						type="button"
						onClick={() =>
							isDirectory ? onToggleDirectory(item.id) : onSelectFile(item.id)
						}
						className={cn(
							"flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
							!isDirectory && selectedFilePath === item.id
								? "bg-accent text-accent-foreground"
								: "hover:bg-muted/70",
						)}
						style={{ paddingLeft: `${depth * 14 + 10}px` }}
					>
						{isDirectory ? (
							<ChevronRight
								className={cn(
									"size-4 shrink-0 text-muted-foreground transition-transform",
									isExpanded && "rotate-90",
								)}
							/>
						) : (
							<span className="block size-4 shrink-0" />
						)}
						{isDirectory ? (
							<Folder className="size-4 shrink-0 text-muted-foreground" />
						) : (
							<FileIcon className="size-4 shrink-0 text-muted-foreground" />
						)}
						<span className="min-w-0 truncate font-mono text-sm">
							{item.name}
						</span>
					</button>
					{isDirectory && isExpanded ? (
						<div>
							{childStatus === "loading" ? (
								<div
									className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground"
									style={{ paddingLeft: `${(depth + 1) * 14 + 10}px` }}
								>
									<Loader2 className="size-4 animate-spin" />
									Loading...
								</div>
							) : childStatus === "error" ? (
								<div
									className="px-2 py-1.5 text-sm text-destructive"
									style={{ paddingLeft: `${(depth + 1) * 14 + 10}px` }}
								>
									Failed to load directory
								</div>
							) : childStatus === "loaded" && childItems.length === 0 ? (
								<div
									className="px-2 py-1.5 text-sm text-muted-foreground"
									style={{ paddingLeft: `${(depth + 1) * 14 + 10}px` }}
								>
									Empty
								</div>
							) : (
								renderItems(childItems, depth + 1)
							)}
						</div>
					) : null}
				</div>
			);
		});

	if (rootStatus === "loading") {
		return (
			<div className="flex h-full min-h-[320px] items-center justify-center gap-2 text-muted-foreground">
				<Loader2 className="size-4 animate-spin" />
				Loading files...
			</div>
		);
	}

	if (rootStatus === "error") {
		return (
			<div className="flex h-full min-h-[320px] items-center justify-center text-destructive">
				Failed to load files
			</div>
		);
	}

	if (rootItems.length === 0) {
		return (
			<div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-2 text-muted-foreground">
				<Folder className="size-6" />
				No files available
			</div>
		);
	}

	return (
		<div className="h-[65vh] overflow-auto p-2">{renderItems(rootItems)}</div>
	);
};

export const ShowScanTaskDetail = ({ serviceType, routeSegment }: Props) => {
	const router = useRouter();
	const utils = api.useUtils();
	const projectId = typeof router.query.projectId === "string" ? router.query.projectId : "";
	const environmentId =
		typeof router.query.environmentId === "string" ? router.query.environmentId : "";
	const serviceId =
		typeof router.query.applicationId === "string"
			? router.query.applicationId
			: typeof router.query.composeId === "string"
				? router.query.composeId
				: "";
	const scanJobId = typeof router.query.scanJobId === "string" ? router.query.scanJobId : "";
	const taskId = typeof router.query.taskId === "string" ? router.query.taskId : "";

	const jobTasksHref = `/dashboard/project/${projectId}/environment/${environmentId}/${routeSegment}/${serviceType}/${serviceId}/jobs/${scanJobId}?tab=tasks`;

	const serviceQuery =
		serviceType === "application"
			? api.application.one.useQuery({ applicationId: serviceId })
			: api.compose.one.useQuery({ composeId: serviceId });
	const serviceData = serviceQuery.data;

	const { data, isLoading, isError, error } = api.scan.task.useQuery(
		{ taskId, scanJobId },
		{
			enabled: !!taskId && !!scanJobId,
			refetchInterval: (result) =>
				result?.task.status && ACTIVE_TASK_STATUSES.has(result.task.status)
					? 2000
					: false,
		},
	);
	const rerunTaskMutation = api.scan.rerunTask.useMutation();
	const [activeTab, setActiveTab] = useState<ScanTaskTab>("details");
	const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
	const [expandedDirectories, setExpandedDirectories] = useState<
		Record<string, boolean>
	>({});
	const [directoryCache, setDirectoryCache] = useState<
		Record<string, DirectoryCacheEntry>
	>({});
	const rootDirectoryQuery = api.scan.listTaskDirectory.useQuery(
		{ scanJobId, taskId },
		{
			enabled: !!scanJobId && !!taskId && activeTab === "files",
			refetchInterval: activeTab === "files" ? 4000 : false,
		},
	);
	const { data: selectedFile, isLoading: isLoadingSelectedFile } =
		api.scan.readTaskFile.useQuery(
			{ scanJobId, taskId, filePath: selectedFilePath || "" },
			{ enabled: !!scanJobId && !!taskId && !!selectedFilePath },
		);

	const task = data?.task;
	const showFuzzingStatus = isRunFuzzerStage(task?.stageName);
	const title = task?.name || `Task ${taskId.slice(0, 6)}`;
	const canRerunTask = task ? RERUNNABLE_TASK_STATUSES.has(task.status) : false;
	const buildTaskHref = (targetTaskId?: string | null) =>
		targetTaskId
			? `/dashboard/project/${projectId}/environment/${environmentId}/${routeSegment}/${serviceType}/${serviceId}/jobs/${scanJobId}/tasks/${encodeURIComponent(targetTaskId)}`
			: undefined;
	const handleRerunTask = async () => {
		if (!task) {
			return;
		}
		try {
			const result = await rerunTaskMutation.mutateAsync({ taskId: task.taskId });
			toast.success(`Created rerun task ${result.task.taskId}`);
			await Promise.all([
				utils.scan.task.invalidate({ taskId, scanJobId }),
				utils.scan.one.invalidate({ scanJobId }),
				utils.scan.statusView.invalidate({ scanJobId }),
				utils.scan.listTaskDirectory.invalidate({ taskId, scanJobId }),
			]);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to rerun task",
			);
		}
	};

	useEffect(() => {
		setSelectedFilePath(null);
		setExpandedDirectories({});
		setDirectoryCache({});
	}, [taskId, scanJobId]);

	useEffect(() => {
		if (activeTab === "fuzzing" && task && !showFuzzingStatus) {
			setActiveTab("details");
		}
	}, [activeTab, showFuzzingStatus, task]);

	useEffect(() => {
		if (activeTab !== "files") {
			return;
		}

		if (rootDirectoryQuery.isLoading) {
			setDirectoryCache((current) => ({
				...current,
				[ROOT_DIRECTORY_KEY]: {
					items: current[ROOT_DIRECTORY_KEY]?.items || [],
					status: "loading",
				},
			}));
			return;
		}

		if (rootDirectoryQuery.isError) {
			setDirectoryCache((current) => ({
				...current,
				[ROOT_DIRECTORY_KEY]: { items: [], status: "error" },
			}));
			setSelectedFilePath(null);
			return;
		}

		const items = rootDirectoryQuery.data || [];
		setDirectoryCache((current) => ({
			...current,
			[ROOT_DIRECTORY_KEY]: { items, status: "loaded" },
		}));

		if (!items.length) {
			setSelectedFilePath(null);
		}
	}, [
		activeTab,
		rootDirectoryQuery.data,
		rootDirectoryQuery.isError,
		rootDirectoryQuery.isLoading,
	]);

	const handleToggleDirectory = async (directoryPath: string) => {
		const nextExpanded = !expandedDirectories[directoryPath];
		setExpandedDirectories((current) => ({
			...current,
			[directoryPath]: nextExpanded,
		}));

		if (!nextExpanded) {
			return;
		}

		const existing = directoryCache[directoryPath];
		if (existing?.status === "loading" || existing?.status === "loaded") {
			return;
		}

		setDirectoryCache((current) => ({
			...current,
			[directoryPath]: {
				items: current[directoryPath]?.items || [],
				status: "loading",
			},
		}));

		try {
			const items = await utils.scan.listTaskDirectory.fetch({
				scanJobId,
				taskId,
				directoryPath,
			});
			setDirectoryCache((current) => ({
				...current,
				[directoryPath]: { items, status: "loaded" },
			}));
		} catch {
			setDirectoryCache((current) => ({
				...current,
				[directoryPath]: { items: [], status: "error" },
			}));
		}
	};

	return (
		<div className="pb-10">
			<BreadcrumbSidebar
				list={[
					{ name: "Projects", href: "/dashboard/projects" },
					{ name: serviceData?.environment.project.name || "" },
					{
						name: serviceData?.environment.name || "",
						href: `/dashboard/project/${projectId}/environment/${environmentId}`,
					},
					{
						name: serviceData?.name || "",
						href: `/dashboard/project/${projectId}/environment/${environmentId}/${routeSegment}/${serviceType}/${serviceId}?tab=deployments`,
					},
					{
						name: "Jobs",
						href: `/dashboard/project/${projectId}/environment/${environmentId}/${routeSegment}/${serviceType}/${serviceId}?tab=deployments`,
					},
					{
						name: `Job ${scanJobId.slice(0, 6)}`,
						href: jobTasksHref,
					},
					{ name: `Task ${taskId.slice(0, 6)}` },
				]}
			/>
			<Head>
				<title>Task {taskId.slice(0, 6)} | Dokploy</title>
			</Head>

			<Card className="bg-background">
				<CardHeader>
					<div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
						<div className="min-w-0">
							<CardTitle className="text-xl">{title}</CardTitle>
							<CardDescription className="mt-2 flex items-center gap-2 break-all">
								<span>{taskId}</span>
								{taskId ? (
									<CopyValueButton
										value={taskId}
										label="Task ID"
										className="size-7 shrink-0"
									/>
								) : null}
							</CardDescription>
						</div>
						<div className="flex shrink-0 flex-wrap items-center gap-2">
							<Button
								type="button"
								variant="outline"
								isLoading={rerunTaskMutation.isLoading}
								disabled={!canRerunTask || rerunTaskMutation.isLoading}
								title={
									canRerunTask
										? "Rerun task"
										: "Task can be rerun after it reaches a terminal state"
								}
								onClick={() => void handleRerunTask()}
							>
								<RefreshCw className="mr-2 size-4" />
								Rerun
							</Button>
							<Button asChild variant="outline">
								<Link href={jobTasksHref}>
									<ArrowLeft className="mr-2 size-4" />
									Back to Tasks
								</Link>
							</Button>
						</div>
					</div>
				</CardHeader>
				<CardContent>
					{isLoading ? (
						<div className="flex items-center gap-2 text-muted-foreground">
							<Loader2 className="size-4 animate-spin" />
							Loading task...
						</div>
					) : isError ? (
						<div className="flex items-center gap-2 text-muted-foreground">
							<AlertCircle className="size-4" />
							{error?.message || "Task not found"}
						</div>
					) : !task ? (
						<div className="flex items-center gap-2 text-muted-foreground">
							<AlertCircle className="size-4" />
							Task not found
						</div>
					) : (
						<Tabs
							value={activeTab}
							onValueChange={(value) => setActiveTab(value as ScanTaskTab)}
							className="w-full"
						>
							<TabsList className="flex gap-4 justify-start">
								<TabsTrigger value="details">Details</TabsTrigger>
								<TabsTrigger value="monitoring">Monitoring</TabsTrigger>
								{showFuzzingStatus ? (
									<TabsTrigger value="fuzzing">Fuzzing Status</TabsTrigger>
								) : null}
								<TabsTrigger value="files">Files</TabsTrigger>
							</TabsList>

							<TabsContent value="details" className="pt-4">
								<div className="grid gap-6">
									<div className="flex flex-wrap items-center gap-2">
										<Badge
											variant="outline"
											className={getTaskStatusBadgeClassName(task.status)}
										>
											{getTaskStatusLabel(task.status)}
										</Badge>
										<Badge variant="outline">
											{getTaskStageLabel(task.stageName)}
										</Badge>
									</div>

									<DetailSection title="General">
										<div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
											<DetailField label="Task ID" value={task.taskId} />
											<DetailField
												label="Scan Job ID"
												value={task.scanJobId}
												href={jobTasksHref}
											/>
											<DetailField label="Name" value={task.name} />
											<DetailField
												label="Stage"
												value={getTaskStageLabel(task.stageName)}
											/>
											<DetailField
												label="Status"
												value={getTaskStatusLabel(task.status)}
												badgeClassName={getTaskStatusBadgeClassName(task.status)}
											/>
											<DetailField label="Priority" value={task.priority} />
											<DetailField label="Attempt" value={task.attempt} />
											<DetailField label="Runtime Mode" value={task.runtimeMode} />
											<DetailField
												label="Parent Task ID"
												value={task.parentTaskId}
												href={buildTaskHref(task.parentTaskId)}
											/>
											<DetailField
												label="Forked From Task ID"
												value={task.forkedFromTaskId}
												href={buildTaskHref(task.forkedFromTaskId)}
											/>
											<DetailField
												label="Forked From Thread ID"
												value={task.forkedFromThreadId}
											/>
											<DetailField
												label="Stage Group Instance ID"
												value={task.stageGroupInstanceId}
											/>
											<DetailField label="Thread ID" value={task.threadId} />
											<DetailField
												label="Container Name"
												value={task.containerName}
											/>
											<DetailField label="Exit Reason" value={task.exitReason} />
											<DetailField label="Exit Note" value={task.exitNote} />
											<DetailField
												label="Created"
												value={task.createdAt}
												date={task.createdAt}
											/>
											<DetailField
												label="Updated"
												value={task.updatedAt}
												date={task.updatedAt}
											/>
											<DetailField
												label="Started"
												value={task.startedAt}
												date={task.startedAt}
											/>
											<DetailField
												label="Completed"
												value={task.completedAt}
												date={task.completedAt}
											/>
										</div>
									</DetailSection>

									<DetailSection title="Usage">
										<div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
											<DetailField
												label="Input / Cache Read"
												value={formatTokenUsageWithCache(
													task.inputTokens,
													task.cachedReadTokens,
												)}
												copyLabel="Input / Cache Read"
											/>
											<DetailField
												label="Output / Cache Write"
												value={formatTokenUsageWithCache(
													task.outputTokens,
													task.cachedWriteTokens,
													"write cache",
												)}
												copyLabel="Output / Cache Write"
											/>
											<DetailField
												label="Total Tokens"
												value={formatTokenUsage(task.totalTokens)}
												copyLabel="Total Tokens"
											/>
											<DetailField
												label="Thought Tokens"
												value={formatTokenUsage(task.thoughtTokens)}
												copyLabel="Thought Tokens"
											/>
										</div>
									</DetailSection>

									{task.errorMessage ? (
										<div className="rounded-lg border p-3">
											<div className="text-sm text-muted-foreground">
												Error Message
											</div>
											<div className="mt-1 whitespace-pre-wrap break-words text-sm">
												{task.errorMessage}
											</div>
										</div>
									) : null}

									<DetailSection title="Output">
										<div className="grid gap-4 xl:grid-cols-2">
											<JsonBlock label="Agent Profile" value={task.agentProfile} />
											<JsonBlock label="Input" value={task.input} />
											<JsonBlock label="Output" value={task.output} />
										</div>
									</DetailSection>
								</div>
							</TabsContent>

							<TabsContent value="monitoring" className="pt-4">
								<ScanMonitoring
									mode="task"
									scanJobId={scanJobId}
									taskId={task.taskId}
								/>
							</TabsContent>

							{showFuzzingStatus ? (
								<TabsContent value="fuzzing" className="pt-4">
									<FuzzingStatusPanel taskId={task.taskId} />
								</TabsContent>
							) : null}

							<TabsContent value="files" className="pt-4">
								<div className="rounded-lg border">
									<div className="border-b px-4 py-3">
										<div className="font-medium">Files</div>
										<div className="text-sm text-muted-foreground">
											Browse this task runtime directory.
										</div>
									</div>
									<div className="grid min-h-[65vh] grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)]">
										<div className="border-b lg:border-b-0 lg:border-r">
											<LazyFileTree
												rootItems={
													directoryCache[ROOT_DIRECTORY_KEY]?.items || []
												}
												rootStatus={
													directoryCache[ROOT_DIRECTORY_KEY]?.status ||
													(rootDirectoryQuery.isLoading ? "loading" : "idle")
												}
												expandedDirectories={expandedDirectories}
												selectedFilePath={selectedFilePath}
												directoryCache={directoryCache}
												onToggleDirectory={handleToggleDirectory}
												onSelectFile={setSelectedFilePath}
											/>
										</div>

										<div className="min-w-0">
											<div className="border-b px-4 py-3">
												<div className="flex items-center gap-2 text-sm text-muted-foreground">
													<FileIcon className="size-4" />
													<span className="truncate">
														{selectedFile?.relativePath ||
															selectedFilePath ||
															"No file selected"}
													</span>
												</div>
											</div>
											<div className="max-h-[calc(65vh-49px)] overflow-auto px-4 py-3">
												{!selectedFilePath ? (
													<div className="flex min-h-[280px] flex-col items-center justify-center gap-2 text-muted-foreground">
														<FileIcon className="size-6" />
														No file selected
													</div>
												) : isLoadingSelectedFile ? (
													<div className="flex min-h-[280px] items-center justify-center gap-2 text-muted-foreground">
														<Loader2 className="size-4 animate-spin" />
														Loading file...
													</div>
												) : (
													<pre className="whitespace-pre-wrap break-words font-mono text-sm">
														{selectedFile?.content || "(empty)"}
													</pre>
												)}
											</div>
										</div>
									</div>
								</div>
							</TabsContent>
						</Tabs>
					)}
				</CardContent>
			</Card>
		</div>
	);
};
