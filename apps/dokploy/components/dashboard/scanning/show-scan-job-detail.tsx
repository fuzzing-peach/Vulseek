import { motion } from "framer-motion";
import {
	AlertCircle,
	ChevronRight,
	ChevronsUpDown,
	FileIcon,
	FileSearch,
	Folder,
	Loader2,
	RefreshCw,
	Search,
} from "lucide-react";
import Head from "next/head";
import Link from "next/link";
import { useRouter } from "next/router";
import {
	type KeyboardEvent,
	type ReactNode,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import {
	ANALYSIS_RESULT_OPTIONS,
	VERIFY_RESULT_OPTIONS,
	applyCandidateListQueryState,
	buildCandidateListStateHref,
	parseCandidateListQueryState,
	serializeCandidateListQueryState,
	type CandidateSortDirection,
	type CandidateSortKey,
} from "@/components/dashboard/scanning/candidate-list-query-state";
import {
	LiveTaskActivity,
	LiveTaskActivityBadge,
	LiveTaskActivityButton,
} from "@/components/dashboard/scanning/live-task-activity";
import { useSandboxAgentActivities } from "@/components/dashboard/scanning/use-sandbox-agent-activity";
import { BreadcrumbSidebar } from "@/components/shared/breadcrumb-sidebar";
import { CopyValueButton } from "@/components/shared/copy-value-button";
import { DateTooltip } from "@/components/shared/date-tooltip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
	idleSandboxAgentActivity,
	type SandboxAgentActivity,
} from "@/lib/scan/sandbox-agent-activity";
import { api } from "@/utils/api";

interface Props {
	projectId: string;
	environmentId: string;
	serviceId: string;
	scanJobId: string;
	serviceType: "application" | "compose";
	routeSegment: "profiles" | "services";
}

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

type ScanJobTab =
	| "overview"
	| "tasks"
	| "analysis"
	| "verify"
	| "candidates"
	| "files";

const RESULT_SORT_RANK: Record<string, number> = {
	real_vulnerability: 4,
	likely_vulnerability: 3,
	plausible_but_unproven: 2,
	api_misuse: 1,
	false_positive: 0,
};

const RESULT_SHORT_LABELS: Record<string, string> = {
	real_vulnerability: "Real",
	likely_vulnerability: "Likely",
	plausible_but_unproven: "Plausible",
	false_positive: "False",
	api_misuse: "Misuse",
};

const formatResultLabel = (value: string) =>
	value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());

const formatTaskRuntime = (
	startedAt: string | null | undefined,
	nowMs: number,
) => {
	if (!startedAt) {
		return "-";
	}
	const startedAtMs = new Date(startedAt).getTime();
	if (!Number.isFinite(startedAtMs)) {
		return "-";
	}
	const totalSeconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) {
		return `${hours}h ${minutes}m`;
	}
	if (minutes > 0) {
		return `${minutes}m ${seconds}s`;
	}
	return `${seconds}s`;
};

const resolveRequestedTab = (value: string | string[] | undefined): ScanJobTab => {
	const rawTab = typeof value === "string" ? value : Array.isArray(value) ? value[0] : "";
	if (
		rawTab === "overview" ||
		rawTab === "tasks" ||
		rawTab === "analysis" ||
		rawTab === "verify" ||
		rawTab === "candidates" ||
		rawTab === "files"
	) {
		return rawTab;
	}
	if (rawTab === "stream") {
		return "tasks";
	}
	if (rawTab === "status") {
		return "analysis";
	}
	return "overview";
};

const getShortResultLabel = (value?: string | null) => {
	if (!value) {
		return "-";
	}
	return RESULT_SHORT_LABELS[value] || formatResultLabel(value);
};

const ROOT_DIRECTORY_KEY = "__root__";

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
						className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
							!isDirectory && selectedFilePath === item.id
								? "bg-accent text-accent-foreground"
								: "hover:bg-muted/70"
						}`}
						style={{ paddingLeft: `${depth * 14 + 10}px` }}
					>
						{isDirectory ? (
							<ChevronRight
								className={`size-4 shrink-0 text-muted-foreground transition-transform ${
									isExpanded ? "rotate-90" : ""
								}`}
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

	return <div className="h-[65vh] overflow-auto p-2">{renderItems(rootItems)}</div>;
};

const CandidateWorkflowSection = ({
	title,
	description,
	summaryCards,
	inProgressCandidates,
	activitiesByTaskId,
	activityConnectedTaskIds,
}: {
	title: string;
	description: string;
	summaryCards: Array<{
		title: string;
		value: ReactNode;
		progress?: number;
		progressClassName?: string;
	}>;
	inProgressCandidates: Array<{
		taskId: string;
		vulnerabilityCandidateId: string;
		title: string;
		filePath: string | null;
		line: number | null;
		stage: string;
	}>;
	activitiesByTaskId: Record<string, SandboxAgentActivity>;
	activityConnectedTaskIds: Set<string>;
}) => (
	<div className="flex flex-col gap-6">
		<div className="grid grid-cols-1 gap-3 md:grid-cols-3">
			{summaryCards.map((card, index) => (
				<motion.div
					key={card.title}
					layout
					initial={{ opacity: 0, y: 10 }}
					animate={{ opacity: 1, y: 0 }}
					whileHover={{ y: -2, scale: 1.01 }}
					transition={{
						duration: 0.18,
						ease: "easeOut",
						delay: index * 0.03,
					}}
					className="rounded-lg border p-4"
				>
					<div className="text-sm text-muted-foreground">{card.title}</div>
					<div className="mt-2 text-2xl font-semibold">{card.value}</div>
					{typeof card.progress === "number" ? (
						<div className="mt-3">
							<Progress
								value={card.progress}
								className={`h-3 bg-secondary/70 ${card.progressClassName || "[&>div]:bg-emerald-500"}`}
							/>
						</div>
					) : null}
				</motion.div>
			))}
		</div>

		<div className="rounded-lg border">
			<div className="border-b px-4 py-3">
				<div className="font-medium">{title} In Progress</div>
				<div className="text-sm text-muted-foreground">{description}</div>
			</div>
			<div className="overflow-x-auto">
				<table className="w-full text-sm">
					<thead className="border-b bg-muted/30 text-left">
						<tr>
							<th className="w-[24%] px-4 py-3 font-medium">Candidate</th>
							<th className="w-[10%] px-4 py-3 font-medium">Stage</th>
							<th className="w-[66%] px-4 py-3 font-medium">
								Current Activity
							</th>
						</tr>
					</thead>
					<tbody>
						{inProgressCandidates.length === 0 ? (
							<tr>
								<td
									colSpan={3}
									className="px-4 py-6 text-center text-muted-foreground"
								>
									No active candidates
								</td>
							</tr>
						) : (
							inProgressCandidates.map((candidate) => (
								<tr
									key={candidate.vulnerabilityCandidateId}
									className="border-b last:border-b-0"
								>
									<td className="w-[24%] px-4 py-3 align-top">
										<div className="line-clamp-2 font-medium">
											{candidate.title}
										</div>
										<div className="text-xs text-muted-foreground break-all">
											{candidate.filePath || "-"}
											{candidate.line ? `:${candidate.line}` : ""}
										</div>
									</td>
									<td className="w-[10%] px-4 py-3 align-top capitalize">
										{candidate.stage}
									</td>
									<td className="w-[66%] px-4 py-3 align-top">
										<LiveTaskActivity
											taskId={candidate.taskId}
											title={candidate.title}
											subtitle={
												candidate.filePath
													? `${candidate.filePath}${candidate.line ? `:${candidate.line}` : ""}`
													: "Live candidate task operations"
											}
											activity={
												activitiesByTaskId[candidate.taskId] ||
												idleSandboxAgentActivity
											}
											isConnected={activityConnectedTaskIds.has(
												candidate.taskId,
											)}
										/>
									</td>
								</tr>
							))
						)}
					</tbody>
				</table>
			</div>
		</div>
	</div>
);

const getScanJobStatusLabel = (status?: string) => {
	if (status === "pending") {
		return "Pending";
	}

	if (status === "running") {
		return "Running";
	}

	if (status === "finished") {
		return "Finished";
	}

	if (status === "canceled") {
		return "Canceled";
	}

	return "Pending";
};

const getScanJobStatusClassName = (status?: string) => {
	if (status === "finished") {
		return "text-green-600";
	}

	if (status === "canceled") {
		return "text-destructive";
	}

	if (status === "running") {
		return "text-amber-600";
	}

	return "text-muted-foreground";
};

const formatTriggerSourceLabel = (triggerSource?: string) =>
	triggerSource === "schedule" ? "auto" : triggerSource || "manual";

const getAnalysisResultBadgeClassName = (result?: string | null) => {
	if (result === "real_vulnerability") {
		return "border-red-200 bg-red-100 text-red-700";
	}

	if (result === "likely_vulnerability") {
		return "border-orange-200 bg-orange-100 text-orange-700";
	}

	if (result === "plausible_but_unproven") {
		return "border-yellow-200 bg-yellow-100 text-yellow-700";
	}

	if (result === "false_positive") {
		return "border-muted-foreground/20 bg-muted text-muted-foreground";
	}

	if (result === "api_misuse") {
		return "border-slate-200 bg-slate-100 text-slate-700";
	}

	return "border-muted-foreground/20 bg-muted text-muted-foreground";
};

const getVerificationTruthBadge = (
	result?: string | null,
): { label: string; className: string } | null => {
	if (!result) {
		return null;
	}

	if (result === "real_vulnerability") {
		return {
			label: "Real",
			className: "border-red-200 bg-red-100 text-red-700",
		};
	}

	return {
		label: getShortResultLabel(result),
		className: "border-muted-foreground/20 bg-muted text-muted-foreground",
	};
};

const getTaskStageLabel = (stage?: string) => {
	if (stage === "repository_scanning") {
		return "Repository";
	}
	if (stage === "module_scanning") {
		return "Module";
	}
	if (stage === "function_scanning") {
		return "Function";
	}
	if (stage === "analyzing") {
		return "Analysis";
	}
	if (stage === "fuzz_building") {
		return "Fuzz Build";
	}
	if (stage === "fuzzing") {
		return "Fuzz";
	}
	if (stage === "criticizing") {
		return "Critic";
	}
	if (stage === "verifying") {
		return "Verification";
	}
	return "Task";
};

const TERMINAL_CANDIDATE_STATUSES = new Set(["completed", "failed", "exited"]);
const RERUNNABLE_TASK_STATUSES = new Set(["completed", "failed", "exited"]);

const getTaskStatusLabel = (status?: string) => {
	if (!status) {
		return "-";
	}
	return status.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
};

const getTaskStatusBadgeClassName = (status?: string) => {
	if (status === "completed") {
		return "border-emerald-200 bg-emerald-100 text-emerald-700";
	}
	if (status === "failed") {
		return "border-red-200 bg-red-100 text-red-700";
	}
	if (status === "canceled") {
		return "border-amber-200 bg-amber-100 text-amber-700";
	}
	return "border-muted-foreground/20 bg-muted text-muted-foreground";
};

const RUNNING_TASK_STAGE_ORDER: Record<string, number> = {
	repository_scanning: 0,
	module_scanning: 1,
	function_scanning: 2,
	analyzing: 3,
	fuzz_building: 4,
	fuzzing: 5,
	criticizing: 6,
	verifying: 7,
};

const TASK_PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

const getQueueProgressClassName = (queueId: string) => {
	if (queueId === "repository") {
		return "h-3 bg-secondary/70 [&>div]:bg-sky-500";
	}
	if (queueId === "module") {
		return "h-3 bg-secondary/70 [&>div]:bg-amber-500";
	}
	if (queueId === "function") {
		return "h-3 bg-secondary/70 [&>div]:bg-zinc-500";
	}
	if (queueId === "analysis") {
		return "h-3 bg-secondary/70 [&>div]:bg-emerald-500";
	}
	if (queueId === "fuzz-build") {
		return "h-3 bg-secondary/70 [&>div]:bg-cyan-500";
	}
	if (queueId === "fuzz-run") {
		return "h-3 bg-secondary/70 [&>div]:bg-orange-500";
	}
	if (queueId === "analysis-critic") {
		return "h-3 bg-secondary/70 [&>div]:bg-rose-500";
	}
	if (queueId === "verification") {
		return "h-3 bg-secondary/70 [&>div]:bg-violet-500";
	}
	return "h-3 bg-secondary/70 [&>div]:bg-primary";
};

export const ShowScanJobDetail = ({
	projectId,
	environmentId,
	serviceId,
	scanJobId,
	serviceType,
	routeSegment,
}: Props) => {
	const router = useRouter();
	const utils = api.useUtils();
	const initialCandidateListQueryState = parseCandidateListQueryState(router.query);
	const [activeTab, setActiveTab] = useState<ScanJobTab>(() =>
		resolveRequestedTab(router.query.tab),
	);
	const [candidateQuery, setCandidateQuery] = useState(
		() => initialCandidateListQueryState.candidateQuery,
	);
	const [analysisFilters, setAnalysisFilters] = useState<string[]>(
		() => initialCandidateListQueryState.analysisFilters,
	);
	const [verifyFilters, setVerifyFilters] = useState<string[]>(
		() => initialCandidateListQueryState.verifyFilters,
	);
	const [candidateSortKey, setCandidateSortKey] =
		useState<CandidateSortKey>(() => initialCandidateListQueryState.candidateSortKey);
	const [candidateSortDirection, setCandidateSortDirection] =
		useState<CandidateSortDirection>(
			() => initialCandidateListQueryState.candidateSortDirection,
		);
	const [candidatePage, setCandidatePage] = useState(
		() => initialCandidateListQueryState.candidatePage,
	);
	const [candidatePageSize, setCandidatePageSize] = useState(
		() => initialCandidateListQueryState.candidatePageSize,
	);
	const [taskSearchQuery, setTaskSearchQuery] = useState("");
	const [taskStageFilter, setTaskStageFilter] = useState("all");
	const [taskStatusFilter, setTaskStatusFilter] = useState("all");
	const [runningTaskPage, setRunningTaskPage] = useState(1);
	const [runningTaskPageSize, setRunningTaskPageSize] = useState(10);
	const [finishedTaskPage, setFinishedTaskPage] = useState(1);
	const [finishedTaskPageSize, setFinishedTaskPageSize] = useState(20);
	const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
	const [noteDraft, setNoteDraft] = useState("");
	const [expandedDirectories, setExpandedDirectories] = useState<Record<string, boolean>>(
		{},
	);
	const [directoryCache, setDirectoryCache] = useState<
		Record<string, DirectoryCacheEntry>
	>({});
	const [runtimeNowMs, setRuntimeNowMs] = useState(() => Date.now());
	const restoredCandidateScrollKeyRef = useRef<string | null>(null);
	const isApplyingQueryStateRef = useRef(false);

	const serviceQuery =
		serviceType === "application"
			? api.application.one.useQuery({ applicationId: serviceId })
			: api.compose.one.useQuery({ composeId: serviceId });
	const serviceData = serviceQuery.data;

	const { data: scanJob, isLoading: isLoadingJob } = api.scan.one.useQuery(
		{ scanJobId },
		{ enabled: !!scanJobId, refetchInterval: 2000 },
	);
	const { data: candidates, isLoading: isLoadingCandidates } =
		api.scan.candidates.useQuery(
			{ scanJobId },
			{ enabled: !!scanJobId, refetchInterval: 2000 },
		);
	const {
		data: statusView,
		isLoading: isLoadingStatusView,
		error: statusViewError,
	} =
		api.scan.statusView.useQuery(
			{ scanJobId },
			{ enabled: !!scanJobId, refetchInterval: 2000 },
		);
	const {
		activitiesByTaskId,
		connectedTaskIds: activityConnectedTaskIds,
	} = useSandboxAgentActivities({
		scanJobId,
		enabled: !!scanJobId,
	});
	const { data: selectedFile, isLoading: isLoadingSelectedFile } =
		api.scan.readFile.useQuery(
			{ scanJobId, filePath: selectedFilePath || "" },
			{ enabled: !!scanJobId && !!selectedFilePath },
		);
	const retryFailedTasksMutation = api.scan.retryFailedTasks.useMutation();
	const rerunTaskMutation = api.scan.rerunTask.useMutation();
	const cancelScanJobMutation = api.scan.cancel.useMutation();
	const updateNoteMutation = api.scan.updateNote.useMutation();
	const analyzeCandidateMutation = api.scan.analyzeCandidate.useMutation();
	const [reanalyzingCandidateId, setReanalyzingCandidateId] =
		useState<string | null>(null);
	const [rerunningTaskId, setRerunningTaskId] = useState<string | null>(null);
	const rootDirectoryQuery = api.scan.listDirectory.useQuery(
		{ scanJobId },
		{
			enabled: !!scanJobId && activeTab === "files",
			refetchInterval: activeTab === "files" ? 4000 : false,
		},
	);

	useEffect(() => {
		setSelectedFilePath(null);
		setExpandedDirectories({});
		setDirectoryCache({});
	}, [scanJobId]);

	useEffect(() => {
		setNoteDraft(scanJob?.note ?? "");
	}, [scanJob?.note]);

	const requestedTab = useMemo(
		() => resolveRequestedTab(router.query.tab),
		[router.query.tab],
	);

	const isNoteDirty = (scanJob?.note ?? "") !== noteDraft;
	const canCancelScanJob =
		scanJob?.status === "pending" || scanJob?.status === "running";

	const candidateListQueryState = useMemo(
		() => parseCandidateListQueryState(router.query),
		[router.query],
	);
	const candidateListQueryStateSerialized = useMemo(
		() => serializeCandidateListQueryState(candidateListQueryState),
		[candidateListQueryState],
	);
	const currentCandidateListState = useMemo(
		() => ({
			candidateQuery,
			analysisFilters,
			verifyFilters,
			candidateSortKey,
			candidateSortDirection,
			candidatePage,
			candidatePageSize,
		}),
		[
			analysisFilters,
			candidateQuery,
			candidatePage,
			candidatePageSize,
			candidateSortDirection,
			candidateSortKey,
			verifyFilters,
		],
	);
	const currentCandidateListStateSerialized = useMemo(
		() => serializeCandidateListQueryState(currentCandidateListState),
		[currentCandidateListState],
	);

	useEffect(() => {
		if (!router.isReady) {
			return;
		}

		isApplyingQueryStateRef.current = true;
		setActiveTab(requestedTab);
		setCandidateQuery(candidateListQueryState.candidateQuery);
		setAnalysisFilters(candidateListQueryState.analysisFilters);
		setVerifyFilters(candidateListQueryState.verifyFilters);
		setCandidateSortKey(candidateListQueryState.candidateSortKey);
		setCandidateSortDirection(candidateListQueryState.candidateSortDirection);
		setCandidatePage(candidateListQueryState.candidatePage);
		setCandidatePageSize(candidateListQueryState.candidatePageSize);
	}, [
		requestedTab,
		router.isReady,
		candidateListQueryStateSerialized,
		candidateListQueryState,
	]);

	useEffect(() => {
		if (!router.isReady) {
			return;
		}

		const hasCaughtUp =
			activeTab === requestedTab &&
			currentCandidateListStateSerialized === candidateListQueryStateSerialized;
		if (hasCaughtUp) {
			isApplyingQueryStateRef.current = false;
		}
	}, [
		activeTab,
		requestedTab,
		router.isReady,
		currentCandidateListStateSerialized,
		candidateListQueryStateSerialized,
	]);

	useEffect(() => {
		if (!router.isReady) {
			return;
		}

		if (isApplyingQueryStateRef.current) {
			return;
		}

		if (
			currentCandidateListStateSerialized ===
			candidateListQueryStateSerialized
		) {
			return;
		}

		void router.replace(
			{
				pathname: router.pathname,
				query: applyCandidateListQueryState(
					router.query,
					currentCandidateListState,
					activeTab,
				),
			},
			undefined,
			{ shallow: true },
		);
	}, [
		activeTab,
		candidateListQueryStateSerialized,
		currentCandidateListState,
		currentCandidateListStateSerialized,
		router,
	]);
	const repositoryScanningProgress = useMemo(() => {
		const completed = statusView?.scan.repositoryTaskStatus === "completed" ? 1 : 0;
		return {
			completed,
			total: 1,
			percent: completed * 100,
			status: statusView?.scan.repositoryTaskStatus || "pending",
		};
	}, [statusView?.scan.repositoryTaskStatus]);
	const moduleScanningProgress = useMemo(() => {
		const completed = statusView?.summary.moduleTasksCompleted || 0;
		const total = statusView?.summary.moduleTasksTotal || 0;
		const failed = statusView?.summary.moduleTasksFailed || 0;
		return {
			completed,
			total,
			percent: total > 0 ? Math.max(0, Math.min(100, (completed / total) * 100)) : 0,
			status:
				total > 0 && completed >= total
					? "completed"
					: failed > 0
						? "failed"
						: total > 0
							? "running"
							: "pending",
		};
	}, [
		statusView?.summary.moduleTasksCompleted,
		statusView?.summary.moduleTasksFailed,
		statusView?.summary.moduleTasksTotal,
	]);
	const functionScanningProgress = useMemo(() => {
		const completed = statusView?.summary.functionTasksCompleted || 0;
		const total = statusView?.summary.functionTasksTotal || 0;
		const failed = statusView?.summary.functionTasksFailed || 0;
		return {
			completed,
			total,
			percent: total > 0 ? Math.max(0, Math.min(100, (completed / total) * 100)) : 0,
			status:
				total > 0 && completed >= total
					? "completed"
					: failed > 0
						? "failed"
						: total > 0
							? "running"
							: "pending",
		};
	}, [
		statusView?.summary.functionTasksCompleted,
		statusView?.summary.functionTasksFailed,
		statusView?.summary.functionTasksTotal,
	]);
	const totalFailedTasks = useMemo(
		() =>
			(statusView?.queuePendingCounts ?? []).reduce(
				(total, queue) => total + queue.failedCount,
				0,
			),
		[statusView?.queuePendingCounts],
	);
	const canRetryFailedTasks =
		scanJob?.scanType === "full" &&
		totalFailedTasks > 0 &&
		(statusView?.inProgressTasks.length || 0) === 0 &&
		scanJob?.status === "finished";
	const shouldShowRetryFailedTasks = totalFailedTasks > 0;
	const queuePendingCounts = statusView?.queuePendingCounts ?? [];
	const getQueueTerminalProgressValue = (queue: (typeof queuePendingCounts)[number]) =>
		queue.totalCount > 0
			? ((queue.completedCount + queue.failedCount + (queue.exitedCount ?? 0)) /
					queue.totalCount) *
				100
			: 0;
	const getQueueTaskMetrics = (queue: (typeof queuePendingCounts)[number]) => {
		const queued =
			(queue.queuedCount ?? queue.pendingCount ?? 0) +
			(queue.launchingCount ?? 0);
		const running = queue.runningCount ?? 0;
		const failed = queue.failedCount ?? 0;
		const done = queue.completedCount + (queue.exitedCount ?? 0);
		const terminal = done + failed;
		return {
			queued,
			running,
			failed,
			done,
			terminal,
			total: queue.totalCount,
			title: `Queued ${queued}, Running ${running}, Failed ${failed}, Done ${done}, Total ${queue.totalCount}`,
		};
	};
	const analysisInProgressCandidates = useMemo(
		() =>
			(statusView?.inProgressCandidates || []).filter(
				(candidate) => candidate.stage === "analyzing",
			),
		[statusView?.inProgressCandidates],
	);
	const verifyInProgressCandidates = useMemo(
		() =>
			(statusView?.inProgressCandidates || []).filter(
				(candidate) => candidate.stage === "verifying",
			),
		[statusView?.inProgressCandidates],
	);
	const sortedInProgressTasks = useMemo(() => {
		return [...(statusView?.inProgressTasks || [])].sort((left, right) => {
			const stageRankDiff =
				(RUNNING_TASK_STAGE_ORDER[left.stage] ?? Number.MAX_SAFE_INTEGER) -
				(RUNNING_TASK_STAGE_ORDER[right.stage] ?? Number.MAX_SAFE_INTEGER);
			if (stageRankDiff !== 0) {
				return stageRankDiff;
			}
			return right.updatedAt.localeCompare(left.updatedAt);
		});
	}, [statusView?.inProgressTasks]);
	const sortedTerminalTasks = useMemo(() => {
		return [...(statusView?.terminalTasks || [])].sort((left, right) => {
			const rightCompletedAt = right.completedAt || right.updatedAt;
			const leftCompletedAt = left.completedAt || left.updatedAt;
			const completedAtDiff = rightCompletedAt.localeCompare(leftCompletedAt);
			if (completedAtDiff !== 0) {
				return completedAtDiff;
			}
			const stageRankDiff =
				(RUNNING_TASK_STAGE_ORDER[left.stage] ?? Number.MAX_SAFE_INTEGER) -
				(RUNNING_TASK_STAGE_ORDER[right.stage] ?? Number.MAX_SAFE_INTEGER);
			if (stageRankDiff !== 0) {
				return stageRankDiff;
			}
			return right.updatedAt.localeCompare(left.updatedAt);
		});
	}, [statusView?.terminalTasks]);
	const taskStageOptions = useMemo(() => {
		const stages = new Set<string>();
		for (const task of [...sortedInProgressTasks, ...sortedTerminalTasks]) {
			if (task.stage) {
				stages.add(task.stage);
			}
		}
		return [...stages].sort((left, right) => {
			const rankDiff =
				(RUNNING_TASK_STAGE_ORDER[left] ?? Number.MAX_SAFE_INTEGER) -
				(RUNNING_TASK_STAGE_ORDER[right] ?? Number.MAX_SAFE_INTEGER);
			if (rankDiff !== 0) {
				return rankDiff;
			}
			return getTaskStageLabel(left).localeCompare(getTaskStageLabel(right));
		});
	}, [sortedInProgressTasks, sortedTerminalTasks]);
	const terminalTaskStatusOptions = useMemo(() => {
		const statuses = new Set<string>();
		for (const task of sortedTerminalTasks) {
			if (task.status) {
				statuses.add(task.status);
			}
		}
		return [...statuses].sort((left, right) =>
			getTaskStatusLabel(left).localeCompare(getTaskStatusLabel(right)),
		);
	}, [sortedTerminalTasks]);
	const filteredInProgressTasks = useMemo(() => {
		const query = taskSearchQuery.trim().toLowerCase();
		return sortedInProgressTasks.filter((task) => {
			if (taskStageFilter !== "all" && task.stage !== taskStageFilter) {
				return false;
			}
			if (!query) {
				return true;
			}
			return [
				task.title,
				task.subtitle || "",
				task.stage || "",
				getTaskStageLabel(task.stage),
				task.taskId,
			]
				.join("\n")
				.toLowerCase()
				.includes(query);
		});
	}, [sortedInProgressTasks, taskSearchQuery, taskStageFilter]);
	const filteredTerminalTasks = useMemo(() => {
		const query = taskSearchQuery.trim().toLowerCase();
		return sortedTerminalTasks.filter((task) => {
			if (taskStageFilter !== "all" && task.stage !== taskStageFilter) {
				return false;
			}
			if (taskStatusFilter !== "all" && task.status !== taskStatusFilter) {
				return false;
			}
			if (!query) {
				return true;
			}
			return [
				task.title,
				task.subtitle || "",
				task.stage || "",
				getTaskStageLabel(task.stage),
				task.status || "",
				getTaskStatusLabel(task.status),
				task.errorMessage || "",
				task.taskId,
			]
				.join("\n")
				.toLowerCase()
				.includes(query);
		});
	}, [
		sortedTerminalTasks,
		taskSearchQuery,
		taskStageFilter,
		taskStatusFilter,
	]);
	const runningTaskPagination = useMemo(() => {
		const totalItems = filteredInProgressTasks.length;
		const totalPages = Math.max(1, Math.ceil(totalItems / runningTaskPageSize));
		const page = Math.min(Math.max(1, runningTaskPage), totalPages);
		const startIndex = (page - 1) * runningTaskPageSize;
		const endIndex = Math.min(totalItems, startIndex + runningTaskPageSize);
		return {
			page,
			pageSize: runningTaskPageSize,
			totalItems,
			totalPages,
			startIndex,
			endIndex,
			items: filteredInProgressTasks.slice(startIndex, endIndex),
		};
	}, [filteredInProgressTasks, runningTaskPage, runningTaskPageSize]);
	const finishedTaskPagination = useMemo(() => {
		const totalItems = filteredTerminalTasks.length;
		const totalPages = Math.max(1, Math.ceil(totalItems / finishedTaskPageSize));
		const page = Math.min(Math.max(1, finishedTaskPage), totalPages);
		const startIndex = (page - 1) * finishedTaskPageSize;
		const endIndex = Math.min(totalItems, startIndex + finishedTaskPageSize);
		return {
			page,
			pageSize: finishedTaskPageSize,
			totalItems,
			totalPages,
			startIndex,
			endIndex,
			items: filteredTerminalTasks.slice(startIndex, endIndex),
		};
	}, [filteredTerminalTasks, finishedTaskPage, finishedTaskPageSize]);

	useEffect(() => {
		if (runningTaskPage !== runningTaskPagination.page) {
			setRunningTaskPage(runningTaskPagination.page);
		}
	}, [runningTaskPage, runningTaskPagination.page]);

	useEffect(() => {
		if (finishedTaskPage !== finishedTaskPagination.page) {
			setFinishedTaskPage(finishedTaskPagination.page);
		}
	}, [finishedTaskPage, finishedTaskPagination.page]);

	useEffect(() => {
		if (sortedInProgressTasks.length === 0) {
			return;
		}
		const timer = window.setInterval(() => {
			setRuntimeNowMs(Date.now());
		}, 1000);
		return () => window.clearInterval(timer);
	}, [sortedInProgressTasks.length]);

	const analysisQueuedCount = useMemo(
		() =>
			(statusView?.queuedCandidates || []).filter(
				(candidate) => (candidate.stage || "analyzing") === "analyzing",
			).length,
		[statusView?.queuedCandidates],
	);
	const verifyQueuedCount = useMemo(
		() =>
			(statusView?.queuedCandidates || []).filter(
				(candidate) => candidate.stage === "verifying",
			).length,
		[statusView?.queuedCandidates],
	);
	const analysisCompletedCandidates = useMemo(
		() =>
			(candidates || []).filter((candidate) => !!candidate.latestAnalysisResult).length,
		[candidates],
	);
	const failedAnalysisCandidatesCount = useMemo(
		() =>
			(candidates || []).filter(
				(candidate) =>
					candidate.status === "failed" && candidate.currentStage === "analyzing",
			).length,
		[candidates],
	);
	const verifyEligibleCandidates = useMemo(
		() =>
			(candidates || []).filter((candidate) => {
				const result = candidate.latestAnalysisResult?.result;
				return (
					result === "real_vulnerability" ||
					result === "likely_vulnerability"
				);
			}).length,
		[candidates],
	);
	const verifyCompletedCandidates = useMemo(
		() =>
			(candidates || []).filter((candidate) => !!candidate.latestVerificationResult)
				.length,
		[candidates],
	);
	const failedVerificationCandidatesCount = useMemo(
		() =>
			(candidates || []).filter(
				(candidate) =>
					candidate.status === "failed" && candidate.currentStage === "verifying",
			).length,
		[candidates],
	);
	const handleRetryFailedTasks = async () => {
		try {
			const result = await retryFailedTasksMutation.mutateAsync({
				scanJobId,
			});
			toast.success(`Requeued ${result.retriedTaskCount} failed tasks`);
			await Promise.all([
				utils.scan.one.invalidate({ scanJobId }),
				utils.scan.statusView.invalidate({ scanJobId }),
				utils.scan.candidates.invalidate({ scanJobId }),
			]);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to retry failed tasks",
			);
		}
	};
	const handleAnalyzeCandidate = async (vulnerabilityCandidateId: string) => {
		setReanalyzingCandidateId(vulnerabilityCandidateId);
		try {
			await analyzeCandidateMutation.mutateAsync({
				vulnerabilityCandidateId,
			});
			toast.success("Analysis requeued");
			await Promise.all([
				utils.scan.one.invalidate({ scanJobId }),
				utils.scan.statusView.invalidate({ scanJobId }),
				utils.scan.candidates.invalidate({ scanJobId }),
			]);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to requeue analysis",
			);
		} finally {
			setReanalyzingCandidateId((current) =>
				current === vulnerabilityCandidateId ? null : current,
			);
		}
	};
	const handleRerunTask = async (taskId: string) => {
		setRerunningTaskId(taskId);
		try {
			const result = await rerunTaskMutation.mutateAsync({ taskId });
			toast.success(`Created rerun task ${result.task.taskId}`);
			await Promise.all([
				utils.scan.one.invalidate({ scanJobId }),
				utils.scan.statusView.invalidate({ scanJobId }),
			]);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to rerun task",
			);
		} finally {
			setRerunningTaskId((current) => (current === taskId ? null : current));
		}
	};
	const filteredCandidates = useMemo(() => {
		if (!candidates) {
			return [];
		}
		const query = candidateQuery.trim().toLowerCase();
		return candidates.filter((candidate) => {
			const latestAnalysisResult = candidate.latestAnalysisResult?.result || "";
			const latestVerifyResult = candidate.latestVerificationResult?.result || "";
			if (
				analysisFilters.length > 0 &&
				!analysisFilters.includes(latestAnalysisResult)
			) {
				return false;
			}
			if (
				verifyFilters.length > 0 &&
				!verifyFilters.includes(latestVerifyResult)
			) {
				return false;
			}
			if (!query) {
				return true;
			}
			const haystack = [
				candidate.title,
				candidate.description || "",
				candidate.filePath || "",
				candidate.status,
				typeof candidate.line === "number" ? String(candidate.line) : "",
				candidate.latestAnalysisResult?.result || "",
				candidate.latestAnalysisResult?.reportPath || "",
				candidate.latestAnalysisResult?.threadId || "",
				candidate.latestVerificationResult?.result || "",
				typeof candidate.latestVerificationResult?.isBug === "boolean"
					? String(candidate.latestVerificationResult.isBug)
					: "",
				typeof candidate.latestVerificationResult?.isSecurity === "boolean"
					? String(candidate.latestVerificationResult.isSecurity)
					: "",
				typeof candidate.latestVerificationResult?.confidence === "number"
					? String(candidate.latestVerificationResult.confidence)
					: "",
				typeof candidate.latestVerificationResult?.score === "number"
					? String(candidate.latestVerificationResult.score)
					: "",
				typeof candidate.latestAnalysisResult?.score === "number"
					? String(candidate.latestAnalysisResult.score)
					: "",
				typeof candidate.score === "number" ? String(candidate.score) : "",
				candidate.latestVerificationResult?.reportPath || "",
				candidate.latestVerificationResult?.issueDraftPath || "",
				candidate.latestVerificationResult?.threadId || "",
			]
				.join("\n")
				.toLowerCase();
			return haystack.includes(query);
		});
	}, [analysisFilters, candidateQuery, candidates, verifyFilters]);

	const sortedCandidates = useMemo(() => {
		const items = [...filteredCandidates];
		items.sort((left, right) => {
			const direction = candidateSortDirection === "asc" ? 1 : -1;

			if (candidateSortKey === "candidate") {
				return direction * left.title.localeCompare(right.title);
			}

			if (candidateSortKey === "analysis") {
				const leftRank =
					RESULT_SORT_RANK[left.latestAnalysisResult?.result || ""] ?? -1;
				const rightRank =
					RESULT_SORT_RANK[right.latestAnalysisResult?.result || ""] ?? -1;
				if (leftRank !== rightRank) {
					return direction * (leftRank - rightRank);
				}
				return direction * left.title.localeCompare(right.title);
			}

			if (candidateSortKey === "verify") {
				const leftRank =
					RESULT_SORT_RANK[left.latestVerificationResult?.result || ""] ?? -1;
				const rightRank =
					RESULT_SORT_RANK[right.latestVerificationResult?.result || ""] ?? -1;
				if (leftRank !== rightRank) {
					return direction * (leftRank - rightRank);
				}
				return direction * left.title.localeCompare(right.title);
			}

			const leftScore = typeof left.score === "number" ? left.score : -1;
			const rightScore = typeof right.score === "number" ? right.score : -1;
			if (leftScore !== rightScore) {
				return direction * (leftScore - rightScore);
			}
			return direction * left.title.localeCompare(right.title);
		});
		return items;
	}, [candidateSortDirection, candidateSortKey, filteredCandidates]);

	const candidatePagination = useMemo(() => {
		const totalItems = sortedCandidates.length;
		const totalPages = Math.max(1, Math.ceil(totalItems / candidatePageSize));
		const safePage = Math.min(Math.max(1, candidatePage), totalPages);
		const startIndex = (safePage - 1) * candidatePageSize;
		const endIndex = Math.min(totalItems, startIndex + candidatePageSize);
		return {
			page: safePage,
			pageSize: candidatePageSize,
			totalItems,
			totalPages,
			startIndex,
			endIndex,
			items: sortedCandidates.slice(startIndex, endIndex),
		};
	}, [candidatePage, candidatePageSize, sortedCandidates]);

	useEffect(() => {
		if (candidatePage !== candidatePagination.page) {
			setCandidatePage(candidatePagination.page);
		}
	}, [candidatePage, candidatePagination.page]);

	const toggleCandidateSort = (key: CandidateSortKey) => {
		if (candidateSortKey === key) {
			setCandidateSortDirection((current) =>
				current === "asc" ? "desc" : "asc",
			);
			return;
		}
		setCandidateSortKey(key);
		setCandidateSortDirection("asc");
	};

	const toggleAnalysisFilter = (value: string) => {
		setCandidatePage(1);
		setAnalysisFilters((current) =>
			current.includes(value)
				? current.filter((item) => item !== value)
				: [...current, value],
		);
	};

	const toggleVerifyFilter = (value: string) => {
		setCandidatePage(1);
		setVerifyFilters((current) =>
			current.includes(value)
				? current.filter((item) => item !== value)
				: [...current, value],
		);
	};

	const candidateListPageBasePath = `/dashboard/project/${projectId}/environment/${environmentId}/${routeSegment}/${serviceType}/${serviceId}/jobs/${scanJobId}`;

	const candidateScrollStorageKey = useMemo(
		() =>
			`scan-candidates-scroll:${buildCandidateListStateHref(
				candidateListPageBasePath,
				currentCandidateListState,
				"candidates",
			)}`,
		[candidateListPageBasePath, currentCandidateListState],
	);

	useEffect(() => {
		if (
			typeof window === "undefined" ||
			!router.isReady ||
			activeTab !== "candidates"
		) {
			return;
		}

		if (restoredCandidateScrollKeyRef.current === candidateScrollStorageKey) {
			return;
		}

		const rawScrollY = window.sessionStorage.getItem(candidateScrollStorageKey);
		if (!rawScrollY) {
			restoredCandidateScrollKeyRef.current = candidateScrollStorageKey;
			return;
		}

		const scrollY = Number.parseFloat(rawScrollY);
		if (!Number.isFinite(scrollY) || scrollY < 0) {
			window.sessionStorage.removeItem(candidateScrollStorageKey);
			restoredCandidateScrollKeyRef.current = candidateScrollStorageKey;
			return;
		}

		requestAnimationFrame(() => {
			window.scrollTo({ top: scrollY, behavior: "auto" });
			restoredCandidateScrollKeyRef.current = candidateScrollStorageKey;
			window.sessionStorage.removeItem(candidateScrollStorageKey);
		});
	}, [
		activeTab,
		candidatePagination.page,
		candidateScrollStorageKey,
		router.isReady,
	]);

	const buildCandidateDetailHref = (candidateId: string) =>
		buildCandidateListStateHref(
			`${candidateListPageBasePath}/candidates/${encodeURIComponent(candidateId)}`,
			currentCandidateListState,
			"candidates",
		);
	const buildTaskDetailHref = (taskId: string) =>
		`${candidateListPageBasePath}/tasks/${encodeURIComponent(taskId)}`;
	const handleTaskRowKeyDown = (
		event: KeyboardEvent<HTMLTableRowElement>,
		taskId: string,
	) => {
		if (event.key !== "Enter" && event.key !== " ") {
			return;
		}
		event.preventDefault();
		void router.push(buildTaskDetailHref(taskId));
	};
	const handleCandidateLinkClick = () => {
		if (typeof window === "undefined") {
			return;
		}
		window.sessionStorage.setItem(
			candidateScrollStorageKey,
			String(window.scrollY),
		);
	};

	useEffect(() => {
		if (activeTab !== "files") {
			return;
		}

		if (rootDirectoryQuery.isLoading) {
			setDirectoryCache((current) => ({
				...current,
				[ROOT_DIRECTORY_KEY]: { items: current[ROOT_DIRECTORY_KEY]?.items || [], status: "loading" },
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
			return;
		}

		const firstFile = items.find((item) => item.type === "file")?.id || null;
		if (!firstFile) {
			return;
		}
		setSelectedFilePath((current) => current || firstFile);
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
		if (existing?.status === "loading") {
			return;
		}

		setDirectoryCache((current) => ({
			...current,
			[directoryPath]: { items: current[directoryPath]?.items || [], status: "loading" },
		}));

		try {
			const items = await utils.scan.listDirectory.fetch({
				scanJobId,
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
					{ name: `Job ${scanJobId.slice(0, 6)}` },
				]}
			/>
			<Head>
				<title>Scan Job {scanJobId.slice(0, 6)} | Dokploy</title>
			</Head>

			<Card className="bg-background">
				<CardHeader>
					<CardTitle className="text-xl">Scan Job {scanJobId.slice(0, 6)}</CardTitle>
					<CardDescription className="flex items-center gap-2 break-all">
						<span>{scanJobId}</span>
						<CopyValueButton
							value={scanJobId}
							label="Job ID"
							className="size-7 shrink-0"
						/>
					</CardDescription>
				</CardHeader>
				<CardContent>
					<Tabs
						value={activeTab}
						onValueChange={(value) => {
							setActiveTab(value as ScanJobTab);
						}}
						className="w-full"
					>
						<TabsList className="flex gap-4 justify-start">
							<TabsTrigger value="overview">Overview</TabsTrigger>
							<TabsTrigger value="tasks">Tasks</TabsTrigger>
							<TabsTrigger value="analysis">Analysis</TabsTrigger>
							<TabsTrigger value="verify">Verify</TabsTrigger>
							<TabsTrigger value="candidates">Candidates</TabsTrigger>
							<TabsTrigger value="files">Files</TabsTrigger>
						</TabsList>

						<TabsContent value="overview" className="pt-4">
							{isLoadingJob ? (
								<div className="flex items-center gap-2 text-muted-foreground">
									<Loader2 className="size-4 animate-spin" />
									Loading job...
								</div>
							) : !scanJob ? (
								<div className="flex items-center gap-2 text-muted-foreground">
									<AlertCircle className="size-4" />
									Job not found
								</div>
							) : (
								<div className="flex flex-col gap-3">
									{canCancelScanJob ? (
										<div className="flex items-center justify-between gap-3 rounded-lg border px-4 py-3">
											<div>
												<div className="font-medium">Cancel Running Job</div>
												<div className="text-sm text-muted-foreground">
													Stop all running tasks and clear pending work for this job.
												</div>
											</div>
											<Button
												type="button"
												variant="destructive"
												disabled={cancelScanJobMutation.isLoading}
												onClick={async () => {
													try {
														const result =
															await cancelScanJobMutation.mutateAsync({
																scanJobId,
															});
														toast.success(
															`Cancelled job. Stopped ${result.stoppedContainers} containers.`,
														);
														await Promise.all([
															utils.scan.one.invalidate({ scanJobId }),
															utils.scan.statusView.invalidate({ scanJobId }),
															utils.scan.candidates.invalidate({ scanJobId }),
															serviceType === "application"
																? utils.scan.allByApplication.invalidate({
																		applicationId: serviceId,
																	})
																: utils.scan.allByCompose.invalidate({
																		composeId: serviceId,
																	}),
														]);
													} catch (error) {
														toast.error(
															error instanceof Error
																? error.message
																: "Failed to cancel scan job",
														);
													}
												}}
											>
												{cancelScanJobMutation.isLoading ? (
													<>
														<Loader2 className="mr-2 size-4 animate-spin" />
														Cancelling...
													</>
												) : (
													"Cancel"
												)}
											</Button>
										</div>
									) : null}
								<div className="grid grid-cols-1 md:grid-cols-2 gap-3">
									<div className="border rounded-lg p-3">
										<div className="text-sm text-muted-foreground">Status</div>
										<div
											className={`font-medium ${getScanJobStatusClassName(scanJob.status)}`}
										>
											{getScanJobStatusLabel(scanJob.status)}
										</div>
									</div>
									<div className="border rounded-lg p-3">
										<div className="text-sm text-muted-foreground">Scan Type</div>
										<div className="font-medium">
											{scanJob.scanType === "delta" ? "Delta Scan" : "Full Scan"}
										</div>
									</div>
									<div className="border rounded-lg p-3">
										<div className="text-sm text-muted-foreground">Trigger</div>
										<div className="font-medium">
											{formatTriggerSourceLabel(scanJob.triggerSource)}
										</div>
									</div>
									{scanJob.scanType === "delta" ? (
										<div className="border rounded-lg p-3">
											<div className="text-sm text-muted-foreground">Commit Window</div>
											<div className="font-medium">k={scanJob.commitWindow}</div>
										</div>
									) : null}
									<div className="border rounded-lg p-3">
										<div className="text-sm text-muted-foreground">Created</div>
										<div className="font-medium">
											<DateTooltip date={scanJob.createdAt} />
										</div>
									</div>
									<div className="border rounded-lg p-3">
										<div className="text-sm text-muted-foreground">Finished</div>
										<div className="font-medium">
											{scanJob.finishedAt ? (
												<DateTooltip date={scanJob.finishedAt} />
											) : (
												"-"
											)}
										</div>
									</div>
									{scanJob.errorMessage && (
										<div className="border rounded-lg p-3 md:col-span-2">
											<div className="text-sm text-muted-foreground">Error</div>
											<div className="font-medium text-destructive break-all">
												{scanJob.errorMessage}
											</div>
										</div>
									)}
									<div className="border rounded-lg p-3 md:col-span-2">
										<div className="flex items-start justify-between gap-3">
											<div>
												<div className="text-sm text-muted-foreground">Note</div>
												<div className="text-xs text-muted-foreground">
													Internal note for this scan job
												</div>
											</div>
											<Button
												type="button"
												size="sm"
												disabled={
													updateNoteMutation.isLoading ||
													!isNoteDirty ||
													!scanJob
												}
												onClick={async () => {
													try {
														await updateNoteMutation.mutateAsync({
															scanJobId,
															note: noteDraft,
														});
														toast.success("Note saved");
														await Promise.all([
															utils.scan.one.invalidate({ scanJobId }),
															serviceType === "application"
																? utils.scan.allByApplication.invalidate({
																		applicationId: serviceId,
																	})
																: utils.scan.allByCompose.invalidate({
																		composeId: serviceId,
																	}),
														]);
													} catch (error) {
														toast.error(
															error instanceof Error
																? error.message
																: "Failed to save note",
														);
													}
												}}
											>
												{updateNoteMutation.isLoading ? (
													<>
														<Loader2 className="mr-2 size-4 animate-spin" />
														Saving...
													</>
												) : (
													"Save"
												)}
											</Button>
										</div>
										<Textarea
											value={noteDraft}
											onChange={(event) => setNoteDraft(event.target.value)}
											placeholder="Add a note for this scan job..."
											className="mt-3 min-h-[96px] resize-y"
										/>
									</div>
								</div>
								</div>
							)}
						</TabsContent>

						<TabsContent value="analysis" className="pt-4">
							{isLoadingStatusView || isLoadingCandidates ? (
								<div className="flex items-center gap-2 text-muted-foreground">
									<Loader2 className="size-4 animate-spin" />
									Loading status...
								</div>
							) : !statusView ? (
								<div className="flex items-center gap-2 text-muted-foreground">
									<AlertCircle className="size-4" />
									Status not available
								</div>
								) : (
									<div className="flex flex-col gap-4">
										{failedAnalysisCandidatesCount > 0 ? (
											<div className="flex items-center justify-between gap-3 rounded-lg border px-4 py-3">
												<div>
													<div className="font-medium">Failed Analysis Tasks</div>
													<div className="text-sm text-muted-foreground">
														{failedAnalysisCandidatesCount} failed candidate analysis
														tasks were detected. Retry will requeue every failed task in
														this job.
													</div>
												</div>
												<Button
													type="button"
													disabled={retryFailedTasksMutation.isLoading}
													onClick={handleRetryFailedTasks}
												>
													{retryFailedTasksMutation.isLoading ? (
														<>
															<Loader2 className="mr-2 size-4 animate-spin" />
															Retrying...
														</>
													) : (
														`Retry All Failed Tasks (${totalFailedTasks})`
													)}
												</Button>
											</div>
										) : null}
									<CandidateWorkflowSection
										title="Analysis"
										description="Candidates currently being analyzed and pending analysis."
										summaryCards={[
											{
												title: "Candidate Analysis",
												value: `${analysisCompletedCandidates} / ${statusView.summary.totalCandidates}`,
												progress:
													statusView.summary.totalCandidates > 0
														? Math.max(
																0,
																Math.min(
																	100,
																	(analysisCompletedCandidates /
																		statusView.summary.totalCandidates) *
																		100,
																),
															)
														: 0,
												progressClassName: "[&>div]:bg-emerald-500",
											},
											{
												title: "Analysis Likely / Confirmed",
												value: statusView.summary.analysisLikelyOrConfirmedCandidates,
											},
											{
												title: "Queued / Running",
												value: `${analysisQueuedCount} / ${analysisInProgressCandidates.length}`,
											},
										]}
										inProgressCandidates={analysisInProgressCandidates}
										activitiesByTaskId={activitiesByTaskId}
										activityConnectedTaskIds={activityConnectedTaskIds}
									/>
									</div>
							)}
						</TabsContent>

						<TabsContent value="verify" className="pt-4">
							{isLoadingStatusView || isLoadingCandidates ? (
								<div className="flex items-center gap-2 text-muted-foreground">
									<Loader2 className="size-4 animate-spin" />
									Loading status...
								</div>
							) : !statusView ? (
								<div className="flex items-center gap-2 text-muted-foreground">
									<AlertCircle className="size-4" />
									Status not available
								</div>
							) : (
								<div className="flex flex-col gap-4">
									{failedVerificationCandidatesCount > 0 ? (
										<div className="flex items-center justify-between gap-3 rounded-lg border px-4 py-3">
											<div>
												<div className="font-medium">Failed Verification Tasks</div>
												<div className="text-sm text-muted-foreground">
													{failedVerificationCandidatesCount} failed candidate
													verification tasks were detected. Retry will requeue every
													failed task in this job.
												</div>
											</div>
											<Button
												type="button"
												disabled={retryFailedTasksMutation.isLoading}
												onClick={handleRetryFailedTasks}
											>
												{retryFailedTasksMutation.isLoading ? (
													<>
														<Loader2 className="mr-2 size-4 animate-spin" />
														Retrying...
													</>
												) : (
													`Retry All Failed Tasks (${totalFailedTasks})`
												)}
											</Button>
										</div>
									) : null}
								<CandidateWorkflowSection
									title="Verify"
									description="Candidates currently being verified and pending verification."
									summaryCards={[
										{
											title: "Candidate Verify",
											value: `${verifyCompletedCandidates} / ${verifyEligibleCandidates}`,
											progress:
												verifyEligibleCandidates > 0
													? Math.max(
															0,
															Math.min(
																100,
																(verifyCompletedCandidates / verifyEligibleCandidates) *
																	100,
															),
														)
													: 0,
											progressClassName: "[&>div]:bg-sky-500",
										},
										{
											title: "Verified 0day",
											value: statusView.summary.verifiedZeroDayCandidates,
										},
										{
											title: "Queued / Running",
											value: `${verifyQueuedCount} / ${verifyInProgressCandidates.length}`,
										},
									]}
									inProgressCandidates={verifyInProgressCandidates}
									activitiesByTaskId={activitiesByTaskId}
									activityConnectedTaskIds={activityConnectedTaskIds}
								/>
								</div>
							)}
						</TabsContent>

						<TabsContent value="candidates" className="pt-4">
							{isLoadingCandidates ? (
								<div className="flex items-center gap-2 text-muted-foreground">
									<Loader2 className="size-4 animate-spin" />
									Loading candidates...
								</div>
							) : !candidates || candidates.length === 0 ? (
								<div className="flex items-center gap-2 text-muted-foreground">
									<FileSearch className="size-4" />
									No Candidates yet
								</div>
							) : (
								<div className="flex flex-col gap-3">
									<div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_220px_220px]">
										<div className="relative">
											<Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
											<input
												type="text"
												value={candidateQuery}
												onChange={(event) => {
													setCandidatePage(1);
													setCandidateQuery(event.target.value);
												}}
												placeholder="Search candidates"
												className="flex h-10 w-full rounded-md border border-input bg-background pl-9 pr-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
											/>
										</div>
										<Popover>
											<PopoverTrigger asChild>
												<Button variant="outline" className="justify-between">
													<span>
														Analysis Result
														{analysisFilters.length > 0
															? ` (${analysisFilters.length})`
															: ""}
													</span>
													<ChevronsUpDown className="size-4 text-muted-foreground" />
												</Button>
											</PopoverTrigger>
											<PopoverContent align="end" className="w-72 p-3">
												<div className="mb-3 flex items-center justify-between">
													<div className="text-sm font-medium">Analysis Result</div>
													<Button
														type="button"
														variant="ghost"
														size="sm"
														className="h-auto px-2 py-1 text-xs"
														onClick={() => setAnalysisFilters([])}
													>
														Clear
													</Button>
												</div>
												<div className="space-y-2">
													{ANALYSIS_RESULT_OPTIONS.map((value) => (
														<label
															key={value}
															className="flex items-center gap-2 text-sm"
														>
															<Checkbox
																checked={analysisFilters.includes(value)}
																onCheckedChange={() => toggleAnalysisFilter(value)}
															/>
															<span>{formatResultLabel(value)}</span>
														</label>
													))}
												</div>
											</PopoverContent>
										</Popover>
										<Popover>
											<PopoverTrigger asChild>
												<Button variant="outline" className="justify-between">
													<span>
														Verify Result
														{verifyFilters.length > 0
															? ` (${verifyFilters.length})`
															: ""}
													</span>
													<ChevronsUpDown className="size-4 text-muted-foreground" />
												</Button>
											</PopoverTrigger>
											<PopoverContent align="end" className="w-72 p-3">
												<div className="mb-3 flex items-center justify-between">
													<div className="text-sm font-medium">Verify Result</div>
													<Button
														type="button"
														variant="ghost"
														size="sm"
														className="h-auto px-2 py-1 text-xs"
														onClick={() => setVerifyFilters([])}
													>
														Clear
													</Button>
												</div>
												<div className="space-y-2">
													{VERIFY_RESULT_OPTIONS.map((value) => (
														<label
															key={value}
															className="flex items-center gap-2 text-sm"
														>
															<Checkbox
																checked={verifyFilters.includes(value)}
																onCheckedChange={() => toggleVerifyFilter(value)}
															/>
															<span>{formatResultLabel(value)}</span>
														</label>
													))}
												</div>
											</PopoverContent>
										</Popover>
									</div>
									{sortedCandidates.length === 0 ? (
										<div className="flex items-center gap-2 text-muted-foreground">
											<FileSearch className="size-4" />
											No matching candidates
										</div>
									) : (
										<div className="rounded-lg border">
											<div className="flex flex-col gap-3 border-b px-4 py-3 text-sm md:flex-row md:items-center md:justify-between">
												<div className="text-muted-foreground">
													Showing {candidatePagination.startIndex + 1}-
													{candidatePagination.endIndex} of{" "}
													{candidatePagination.totalItems}
												</div>
												<div className="flex flex-wrap items-center gap-2">
													<label className="text-muted-foreground">
														Page size
													</label>
													<select
														value={candidatePageSize}
														onChange={(event) => {
															setCandidatePage(1);
															setCandidatePageSize(
																Number.parseInt(event.target.value, 10) || 20,
															);
														}}
														className="h-9 rounded-md border border-input bg-background px-2 text-sm"
													>
														{[10, 20, 50, 100].map((size) => (
															<option key={size} value={size}>
																{size}
															</option>
														))}
													</select>
													<Button
														type="button"
														variant="outline"
														size="sm"
														onClick={() =>
															setCandidatePage((current) => Math.max(1, current - 1))
														}
														disabled={candidatePagination.page <= 1}
													>
														Previous
													</Button>
													<div className="min-w-[96px] text-center text-muted-foreground">
														Page {candidatePagination.page} /{" "}
														{candidatePagination.totalPages}
													</div>
													<Button
														type="button"
														variant="outline"
														size="sm"
														onClick={() =>
															setCandidatePage((current) =>
																Math.min(
																	candidatePagination.totalPages,
																	current + 1,
																),
															)
														}
														disabled={
															candidatePagination.page >=
															candidatePagination.totalPages
														}
													>
														Next
													</Button>
												</div>
											</div>
											<div className="overflow-x-auto">
												<table className="w-full text-sm">
													<thead className="border-b bg-muted/30 text-left">
														<tr>
															<th className="w-[10%] px-4 py-3 font-medium">Status</th>
															<th className="w-[38%] px-4 py-3 font-medium">
																<button
																	type="button"
																	onClick={() => toggleCandidateSort("candidate")}
																	className="inline-flex items-center gap-1 hover:text-foreground"
																>
																	<span>Candidate</span>
																	<ChevronsUpDown className="size-3.5" />
																</button>
															</th>
															<th className="w-[18%] px-4 py-3 font-medium">
																<button
																	type="button"
																	onClick={() => toggleCandidateSort("analysis")}
																	className="inline-flex items-center gap-1 hover:text-foreground"
																>
																	<span>Analysis Result</span>
																	<ChevronsUpDown className="size-3.5" />
																</button>
															</th>
															<th className="w-[18%] px-4 py-3 font-medium">
																<button
																	type="button"
																	onClick={() => toggleCandidateSort("verify")}
																	className="inline-flex items-center gap-1 hover:text-foreground"
																>
																	<span>Verify Result</span>
																	<ChevronsUpDown className="size-3.5" />
																</button>
															</th>
															<th className="w-[14%] px-4 py-3 font-medium">
																<button
																	type="button"
																	onClick={() => toggleCandidateSort("score")}
																	className="inline-flex items-center gap-1 hover:text-foreground"
																>
																	<span>Score</span>
																	<ChevronsUpDown className="size-3.5" />
																</button>
															</th>
															<th className="w-[8%] px-4 py-3 font-medium">
																Actions
															</th>
														</tr>
													</thead>
													<tbody>
														{candidatePagination.items.map((candidate) => {
															const verificationTruthBadge = getVerificationTruthBadge(
																candidate.latestVerificationResult?.result,
															);
															const isTerminalCandidate =
																TERMINAL_CANDIDATE_STATUSES.has(candidate.status);
															const isReanalyzingCandidate =
																reanalyzingCandidateId ===
																candidate.vulnerabilityCandidateId;
															return (
																						<tr
																							key={candidate.vulnerabilityCandidateId}
																							className="border-b last:border-b-0 transition-colors hover:bg-muted/40"
																						>
																							<td className="px-4 py-3 align-top text-xs text-muted-foreground capitalize">
																								<Link
																									href={buildCandidateDetailHref(
																										candidate.vulnerabilityCandidateId,
																									)}
																									onClick={handleCandidateLinkClick}
																									className="block"
																								>
																									{candidate.status}
																								</Link>
																							</td>
																							<td className="px-4 py-3 align-top">
																								<Link
																									href={buildCandidateDetailHref(
																										candidate.vulnerabilityCandidateId,
																									)}
																									onClick={handleCandidateLinkClick}
																									className="block"
																								>
																									<div className="font-medium">{candidate.title}</div>
																			<div className="mt-1 text-xs text-muted-foreground break-all">
																				{candidate.filePath || "-"}
																				{candidate.line ? `:${candidate.line}` : ""}
																			</div>
																		</Link>
																	</td>
																							<td className="px-4 py-3 align-top">
																								<Link
																									href={buildCandidateDetailHref(
																										candidate.vulnerabilityCandidateId,
																									)}
																									onClick={handleCandidateLinkClick}
																									className="block"
																								>
																									{candidate.latestAnalysisResult?.result ? (
																				<Badge
																					variant="outline"
																					className={getAnalysisResultBadgeClassName(
																						candidate.latestAnalysisResult.result,
																					)}
																				>
																					{getShortResultLabel(
																						candidate.latestAnalysisResult.result,
																					)}
																				</Badge>
																			) : (
																				<span className="text-xs text-muted-foreground">-</span>
																			)}
																		</Link>
																	</td>
																							<td className="px-4 py-3 align-top">
																								<Link
																									href={buildCandidateDetailHref(
																										candidate.vulnerabilityCandidateId,
																									)}
																									onClick={handleCandidateLinkClick}
																									className="block"
																								>
																									{verificationTruthBadge ? (
																				<Badge
																					variant="outline"
																					className={verificationTruthBadge.className}
																				>
																					{verificationTruthBadge.label}
																				</Badge>
																			) : (
																				<span className="text-xs text-muted-foreground">-</span>
																			)}
																		</Link>
																	</td>
																							<td className="px-4 py-3 align-top text-xs text-muted-foreground">
																								<Link
																									href={buildCandidateDetailHref(
																										candidate.vulnerabilityCandidateId,
																									)}
																									onClick={handleCandidateLinkClick}
																									className="block"
																								>
																									{typeof candidate.score === "number"
																				? candidate.score.toFixed(1)
																				: "-"}
																		</Link>
																	</td>
																							<td className="px-4 py-3 align-top">
																								<Button
																									type="button"
																									variant="outline"
																									size="icon"
																									title={
																										isTerminalCandidate
																											? "Re-run analysis"
																											: "Analysis can be re-run after the candidate reaches a terminal state"
																									}
																									aria-label={
																										isTerminalCandidate
																											? "Re-run analysis"
																											: "Analysis can be re-run after the candidate reaches a terminal state"
																									}
																									disabled={
																										!isTerminalCandidate ||
																										isReanalyzingCandidate
																									}
																									onClick={() =>
																										handleAnalyzeCandidate(
																											candidate.vulnerabilityCandidateId,
																										)
																									}
																								>
																									{isReanalyzingCandidate ? (
																										<Loader2 className="size-4 animate-spin" />
																									) : (
																										<RefreshCw className="size-4" />
																									)}
																								</Button>
																							</td>
																</tr>
															);
														})}
													</tbody>
												</table>
											</div>
										</div>
								)}
								</div>
							)}
						</TabsContent>


						<TabsContent value="files" className="pt-4">
							<div className="rounded-lg border">
								<div className="border-b px-4 py-3">
									<div className="font-medium">Files</div>
									<div className="text-sm text-muted-foreground">
										Browse scan job context files.
									</div>
								</div>
								<div className="grid min-h-[65vh] grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)]">
									<div className="border-b lg:border-b-0 lg:border-r">
										<LazyFileTree
											rootItems={directoryCache[ROOT_DIRECTORY_KEY]?.items || []}
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
													{selectedFile?.relativePath || selectedFilePath || "No file selected"}
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

						<TabsContent value="tasks" className="pt-4">
							<div className="flex flex-col gap-4">
								{shouldShowRetryFailedTasks ? (
									<div className="flex items-center justify-between gap-3 rounded-lg border px-4 py-3">
										<div>
											<div className="font-medium">Failed Tasks</div>
											<div className="text-sm text-muted-foreground">
												{totalFailedTasks} failed tasks were found across scan stages.
											</div>
											{!canRetryFailedTasks ? (
												<div className="mt-1 text-xs text-muted-foreground">
													Retry becomes available after the full scan job finishes and
													all running tasks stop.
												</div>
											) : null}
										</div>
										<Button
											type="button"
											disabled={
												retryFailedTasksMutation.isLoading || !canRetryFailedTasks
											}
											onClick={handleRetryFailedTasks}
										>
											{retryFailedTasksMutation.isLoading ? (
												<>
													<Loader2 className="mr-2 size-4 animate-spin" />
													Retrying...
												</>
											) : (
												`Retry All Failed Tasks (${totalFailedTasks})`
											)}
										</Button>
									</div>
								) : null}

								<div className="rounded-lg border">
									<div className="border-b px-4 py-3">
										<div className="font-medium">Task Queues</div>
										<div className="text-sm text-muted-foreground">
											Per-queue task progress for this job.
										</div>
									</div>
									<div className="overflow-x-auto">
										{statusViewError ? (
											<div className="px-4 py-6 text-sm text-destructive">
												Failed to load queue status.
											</div>
										) : !statusView ? (
											<div className="px-4 py-6 text-sm text-muted-foreground">
												Loading queue status...
											</div>
										) : queuePendingCounts.length === 0 ? (
											<div className="px-4 py-6 text-sm text-muted-foreground">
												No task queues
											</div>
										) : (
												<table className="w-full text-sm">
													<thead className="border-b bg-muted/30 text-left">
															<tr>
																<th className="w-[22%] px-4 py-3 font-medium">Queue</th>
																<th className="w-[30%] px-4 py-3 font-medium">BullMQ Name</th>
																<th className="w-[26%] px-4 py-3 font-medium">
																	Tasks
																</th>
																<th className="w-[22%] px-4 py-3 font-medium">Progress</th>
															</tr>
														</thead>
													<tbody>
														{queuePendingCounts.map((queue) => {
															const metrics = getQueueTaskMetrics(queue);
															return (
																<tr key={queue.id} className="border-b last:border-b-0">
																	<td className="px-4 py-3 align-top font-medium">
																		{queue.title}
																	</td>
																	<td className="px-4 py-3 align-top font-mono text-xs text-muted-foreground break-all">
																		{queue.queueName}
																	</td>
																	<td className="px-4 py-3 align-top" title={metrics.title}>
																		<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
																			<span className="whitespace-nowrap">
																				<span className="font-medium tabular-nums text-foreground">
																					{metrics.queued}
																				</span>{" "}
																				<span className="text-muted-foreground">
																					queued
																				</span>
																			</span>
																			<span className="whitespace-nowrap">
																				<span className="font-medium tabular-nums text-foreground">
																					{metrics.running}
																				</span>{" "}
																				<span className="text-muted-foreground">
																					running
																				</span>
																			</span>
																			{metrics.failed > 0 ? (
																				<span className="whitespace-nowrap">
																					<span className="font-medium tabular-nums text-red-600">
																						{metrics.failed}
																					</span>{" "}
																					<span className="text-red-600">failed</span>
																				</span>
																			) : null}
																		</div>
																	</td>
																	<td className="px-4 py-3 align-top" title={metrics.title}>
																		<div className="flex items-center gap-3">
																			<Progress
																				value={getQueueTerminalProgressValue(queue)}
																				className={getQueueProgressClassName(queue.id)}
																			/>
																			<span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
																				{metrics.terminal} / {metrics.total}
																			</span>
																		</div>
																	</td>
																</tr>
															);
														})}
													</tbody>
												</table>
										)}
									</div>
								</div>

								<div className="rounded-lg border">
									<div className="border-b px-4 py-3">
										<div className="font-medium">Running Tasks</div>
										<div className="text-sm text-muted-foreground">
											All running scanning, analysis, and verification agents for this job.
										</div>
									</div>
									{statusView && sortedInProgressTasks.length > 0 ? (
										<div className="flex flex-col gap-3 border-b px-4 py-3 text-sm xl:flex-row xl:items-center xl:justify-between">
											<div className="grid min-w-0 flex-1 grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_180px]">
												<div className="relative">
													<Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
													<input
														type="text"
														value={taskSearchQuery}
														onChange={(event) => {
															setTaskSearchQuery(event.target.value);
															setRunningTaskPage(1);
															setFinishedTaskPage(1);
														}}
														placeholder="Search tasks"
														className="flex h-9 w-full rounded-md border border-input bg-background py-2 pl-9 pr-3 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
													/>
												</div>
												<select
													value={taskStageFilter}
													onChange={(event) => {
														setTaskStageFilter(event.target.value);
														setRunningTaskPage(1);
														setFinishedTaskPage(1);
													}}
													className="h-9 rounded-md border border-input bg-background px-2 text-sm"
												>
													<option value="all">All stages</option>
													{taskStageOptions.map((stage) => (
														<option key={stage} value={stage}>
															{getTaskStageLabel(stage)}
														</option>
													))}
												</select>
											</div>
											<div className="flex flex-wrap items-center gap-2">
												<div className="text-muted-foreground">
													Showing{" "}
													{runningTaskPagination.totalItems > 0
														? runningTaskPagination.startIndex + 1
														: 0}
													-{runningTaskPagination.endIndex} of{" "}
													{runningTaskPagination.totalItems}
												</div>
												<span className="text-muted-foreground">Page size</span>
												<select
													value={runningTaskPageSize}
													onChange={(event) => {
														setRunningTaskPage(1);
														setRunningTaskPageSize(
															Number.parseInt(event.target.value, 10) || 10,
														);
													}}
													className="h-9 rounded-md border border-input bg-background px-2 text-sm"
												>
													{TASK_PAGE_SIZE_OPTIONS.map((size) => (
														<option key={size} value={size}>
															{size}
														</option>
													))}
												</select>
												<Button
													type="button"
													variant="outline"
													size="sm"
													onClick={() =>
														setRunningTaskPage((current) =>
															Math.max(1, current - 1),
														)
													}
													disabled={runningTaskPagination.page <= 1}
												>
													Previous
												</Button>
												<div className="min-w-[88px] text-center text-muted-foreground">
													Page {runningTaskPagination.page} /{" "}
													{runningTaskPagination.totalPages}
												</div>
												<Button
													type="button"
													variant="outline"
													size="sm"
													onClick={() =>
														setRunningTaskPage((current) =>
															Math.min(
																runningTaskPagination.totalPages,
																current + 1,
															),
														)
													}
													disabled={
														runningTaskPagination.page >=
														runningTaskPagination.totalPages
													}
												>
													Next
												</Button>
											</div>
										</div>
									) : null}
									<div className="overflow-x-auto">
										{!statusView || sortedInProgressTasks.length === 0 ? (
											<div className="px-4 py-6 text-sm text-muted-foreground">
												No running tasks
											</div>
										) : filteredInProgressTasks.length === 0 ? (
											<div className="px-4 py-6 text-sm text-muted-foreground">
												No matching tasks
											</div>
										) : (
											<table className="w-full text-sm">
												<thead className="border-b bg-muted/30 text-left">
													<tr>
														<th className="w-[22%] px-4 py-3 font-medium">Task</th>
														<th className="w-[10%] px-4 py-3 font-medium">Stage</th>
														<th className="w-[10%] px-4 py-3 font-medium">Runtime</th>
														<th className="w-[50%] px-4 py-3 font-medium">
															Current Activity
														</th>
														<th className="w-[8%] px-4 py-3 font-medium">Actions</th>
													</tr>
												</thead>
												<tbody>
													{runningTaskPagination.items.map((task) => (
														<tr
															key={task.id}
															className="border-b last:border-b-0"
														>
															<td className="w-[22%] px-4 py-3 align-top">
																<div className="line-clamp-2 font-medium">
																	{task.title}
																</div>
																<div className="text-xs text-muted-foreground break-all">
																	{task.subtitle || "-"}
																</div>
															</td>
															<td className="w-[10%] px-4 py-3 align-top capitalize">
																{getTaskStageLabel(task.stage)}
															</td>
															<td className="w-[10%] whitespace-nowrap px-4 py-3 align-top tabular-nums">
																{formatTaskRuntime(task.startedAt, runtimeNowMs)}
															</td>
															<td className="w-[50%] px-4 py-3 align-top">
																<LiveTaskActivityBadge
																	activity={
																		activitiesByTaskId[task.taskId] ||
																		idleSandboxAgentActivity
																	}
																	isConnected={activityConnectedTaskIds.has(
																		task.taskId,
																	)}
																/>
															</td>
															<td className="w-[8%] px-4 py-3 align-top">
																<LiveTaskActivityButton
																	taskId={task.taskId}
																	title={task.title}
																	subtitle={task.subtitle}
																	activity={
																		activitiesByTaskId[task.taskId] ||
																		idleSandboxAgentActivity
																	}
																	variant="outline"
																	size="icon"
																	iconOnly
																/>
															</td>
														</tr>
													))}
												</tbody>
											</table>
										)}
									</div>
								</div>

								<div className="rounded-lg border">
									<div className="border-b px-4 py-3">
										<div className="font-medium">Finished Tasks</div>
										<div className="text-sm text-muted-foreground">
											Completed, failed, and canceled tasks for this job.
										</div>
									</div>
									{statusView && sortedTerminalTasks.length > 0 ? (
										<div className="flex flex-col gap-3 border-b px-4 py-3 text-sm xl:flex-row xl:items-center xl:justify-between">
											<div className="grid min-w-0 flex-1 grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_180px_180px]">
												<div className="relative">
													<Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
													<input
														type="text"
														value={taskSearchQuery}
														onChange={(event) => {
															setTaskSearchQuery(event.target.value);
															setRunningTaskPage(1);
															setFinishedTaskPage(1);
														}}
														placeholder="Search tasks"
														className="flex h-9 w-full rounded-md border border-input bg-background py-2 pl-9 pr-3 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
													/>
												</div>
												<select
													value={taskStageFilter}
													onChange={(event) => {
														setTaskStageFilter(event.target.value);
														setRunningTaskPage(1);
														setFinishedTaskPage(1);
													}}
													className="h-9 rounded-md border border-input bg-background px-2 text-sm"
												>
													<option value="all">All stages</option>
													{taskStageOptions.map((stage) => (
														<option key={stage} value={stage}>
															{getTaskStageLabel(stage)}
														</option>
													))}
												</select>
												<select
													value={taskStatusFilter}
													onChange={(event) => {
														setTaskStatusFilter(event.target.value);
														setFinishedTaskPage(1);
													}}
													className="h-9 rounded-md border border-input bg-background px-2 text-sm"
												>
													<option value="all">All statuses</option>
													{terminalTaskStatusOptions.map((status) => (
														<option key={status} value={status}>
															{getTaskStatusLabel(status)}
														</option>
													))}
												</select>
											</div>
											<div className="flex flex-wrap items-center gap-2">
												<div className="text-muted-foreground">
													Showing{" "}
													{finishedTaskPagination.totalItems > 0
														? finishedTaskPagination.startIndex + 1
														: 0}
													-{finishedTaskPagination.endIndex} of{" "}
													{finishedTaskPagination.totalItems}
												</div>
												<span className="text-muted-foreground">Page size</span>
												<select
													value={finishedTaskPageSize}
													onChange={(event) => {
														setFinishedTaskPage(1);
														setFinishedTaskPageSize(
															Number.parseInt(event.target.value, 10) || 20,
														);
													}}
													className="h-9 rounded-md border border-input bg-background px-2 text-sm"
												>
													{TASK_PAGE_SIZE_OPTIONS.map((size) => (
														<option key={size} value={size}>
															{size}
														</option>
													))}
												</select>
												<Button
													type="button"
													variant="outline"
													size="sm"
													onClick={() =>
														setFinishedTaskPage((current) =>
															Math.max(1, current - 1),
														)
													}
													disabled={finishedTaskPagination.page <= 1}
												>
													Previous
												</Button>
												<div className="min-w-[88px] text-center text-muted-foreground">
													Page {finishedTaskPagination.page} /{" "}
													{finishedTaskPagination.totalPages}
												</div>
												<Button
													type="button"
													variant="outline"
													size="sm"
													onClick={() =>
														setFinishedTaskPage((current) =>
															Math.min(
																finishedTaskPagination.totalPages,
																current + 1,
															),
														)
													}
													disabled={
														finishedTaskPagination.page >=
														finishedTaskPagination.totalPages
													}
												>
													Next
												</Button>
											</div>
										</div>
									) : null}
									<div className="overflow-x-auto">
										{!statusView || sortedTerminalTasks.length === 0 ? (
											<div className="px-4 py-6 text-sm text-muted-foreground">
												No finished tasks
											</div>
										) : filteredTerminalTasks.length === 0 ? (
											<div className="px-4 py-6 text-sm text-muted-foreground">
												No matching tasks
											</div>
										) : (
											<table className="w-full text-sm">
												<thead className="border-b bg-muted/30 text-left">
													<tr>
														<th className="w-[22%] px-4 py-3 font-medium">Task</th>
														<th className="w-[9%] px-4 py-3 font-medium">Stage</th>
														<th className="w-[9%] px-4 py-3 font-medium">Status</th>
														<th className="w-[11%] px-4 py-3 font-medium">Started</th>
														<th className="w-[11%] px-4 py-3 font-medium">Finished</th>
														<th className="w-[30%] px-4 py-3 font-medium">Details</th>
														<th className="w-[8%] px-4 py-3 font-medium">Actions</th>
													</tr>
												</thead>
												<tbody>
													{finishedTaskPagination.items.map((task) => {
														const canRerunTask = RERUNNABLE_TASK_STATUSES.has(task.status);
														const isRerunningTask = rerunningTaskId === task.taskId;
														return (
															<tr
																key={task.id}
																role="link"
																tabIndex={0}
																aria-label={`Open task ${task.title}`}
																onClick={() => void router.push(buildTaskDetailHref(task.taskId))}
																onKeyDown={(event) =>
																	handleTaskRowKeyDown(event, task.taskId)
																}
																className="cursor-pointer border-b transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none last:border-b-0"
															>
															<td className="w-[22%] px-4 py-3 align-top">
																<div className="line-clamp-2 font-medium">
																	{task.title}
																</div>
																<div className="text-xs text-muted-foreground break-all">
																	{task.subtitle || "-"}
																</div>
															</td>
															<td className="w-[9%] px-4 py-3 align-top capitalize">
																{getTaskStageLabel(task.stage)}
															</td>
															<td className="w-[9%] px-4 py-3 align-top">
																<Badge
																	variant="outline"
																	className={getTaskStatusBadgeClassName(task.status)}
																>
																	{getTaskStatusLabel(task.status)}
																</Badge>
															</td>
															<td className="w-[11%] whitespace-nowrap px-4 py-3 align-top text-xs text-muted-foreground">
																{task.startedAt ? (
																	<DateTooltip date={task.startedAt} />
																) : (
																	"-"
																)}
															</td>
															<td className="w-[11%] whitespace-nowrap px-4 py-3 align-top text-xs text-muted-foreground">
																{task.completedAt ? (
																	<DateTooltip date={task.completedAt} />
																) : (
																	"-"
																)}
															</td>
															<td className="w-[30%] px-4 py-3 align-top text-xs text-muted-foreground">
																<div className="line-clamp-3 break-words">
																	{task.errorMessage || "-"}
																</div>
															</td>
															<td className="w-[8%] px-4 py-3 align-top">
																<div className="flex items-center gap-2">
																	<Button
																		type="button"
																		variant="outline"
																		size="icon"
																		title={
																			canRerunTask
																				? "Rerun task"
																				: "Task can be rerun after it reaches a terminal state"
																		}
																		aria-label={
																			canRerunTask
																				? "Rerun task"
																				: "Task can be rerun after it reaches a terminal state"
																		}
																		disabled={
																			!canRerunTask ||
																			isRerunningTask ||
																			rerunTaskMutation.isLoading
																		}
																		onClick={(event) => {
																			event.stopPropagation();
																			void handleRerunTask(task.taskId);
																		}}
																	>
																		{isRerunningTask ? (
																			<Loader2 className="size-4 animate-spin" />
																		) : (
																			<RefreshCw className="size-4" />
																		)}
																	</Button>
																</div>
															</td>
														</tr>
														);
													})}
												</tbody>
											</table>
										)}
									</div>
								</div>
							</div>
						</TabsContent>
					</Tabs>
					<div className="pt-6">
						<Link
							className="text-sm text-muted-foreground underline"
							href={`/dashboard/project/${projectId}/environment/${environmentId}/${routeSegment}/${serviceType}/${serviceId}?tab=deployments`}
						>
							Back to Jobs
						</Link>
					</div>
				</CardContent>
			</Card>


		</div>
	);
};
