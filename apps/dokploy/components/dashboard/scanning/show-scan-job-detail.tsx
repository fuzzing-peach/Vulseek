import { motion } from "framer-motion";
import {
	AlertCircle,
	ChevronRight,
	ChevronsUpDown,
	Clipboard,
	Download,
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
	type MouseEvent,
	type ReactNode,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import {
	ANALYSIS_RESULT_OPTIONS,
	applyCandidateListQueryState,
	buildCandidateListStateHref,
	type CandidateSortDirection,
	type CandidateSortKey,
	parseCandidateListQueryState,
	serializeCandidateListQueryState,
	TRIAGE_RESULT_OPTIONS,
	VERIFY_RESULT_OPTIONS,
} from "@/components/dashboard/scanning/candidate-list-query-state";
import {
	LiveTaskActivity,
	LiveTaskActivityBadge,
	LiveTaskActivityButton,
	LiveTaskTextButton,
} from "@/components/dashboard/scanning/live-task-activity";
import { ScanMonitoring } from "@/components/dashboard/scanning/scan-monitoring";
import { ScanStageGraph } from "@/components/dashboard/scanning/scan-stage-graph";
import { useSandboxAgentActivities } from "@/components/dashboard/scanning/use-sandbox-agent-activity";
import { BreadcrumbSidebar } from "@/components/shared/breadcrumb-sidebar";
import { CopyValueButton } from "@/components/shared/copy-value-button";
import { DateTooltip } from "@/components/shared/date-tooltip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
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
	| "monitoring"
	| "files";

const RESULT_SHORT_LABELS: Record<string, string> = {
	real_vulnerability: "Real",
	likely_vulnerability: "Likely",
	true: "True",
	likely: "Likely",
	false: "False",
	plausible_but_unproven: "Plausible",
	false_positive: "False",
	api_misuse: "Misuse",
};

const formatResultLabel = (value: string) =>
	value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());

const CANDIDATE_EXPORT_FIELDS = [
	{ key: "vulnerabilityCandidateId", label: "Candidate ID" },
	{ key: "scanJobId", label: "Scan Job ID" },
	{ key: "scanFunctionTaskId", label: "Function Task ID" },
	{ key: "title", label: "Title" },
	{ key: "description", label: "Description" },
	{ key: "fileHostPath", label: "Source File Host Path" },
	{ key: "line", label: "Line" },
	{ key: "vulnerabilityType", label: "Vulnerability Type" },
	{ key: "status", label: "Status" },
	{ key: "currentStage", label: "Current Stage" },
	{ key: "confidence", label: "Confidence" },
	{ key: "score", label: "Score" },
	{ key: "createdAt", label: "Created At" },
	{ key: "updatedAt", label: "Updated At" },
	{ key: "analysisTaskId", label: "Analysis Task ID" },
	{ key: "analysisResult", label: "Analysis Result" },
	{ key: "analysisConfidence", label: "Analysis Confidence" },
	{ key: "analysisScore", label: "Analysis Score" },
	{ key: "analysisSummary", label: "Analysis Summary" },
	{ key: "analysisReportHostPath", label: "Analysis Report Host Path" },
	{ key: "analysisRuntimeSeconds", label: "Analysis Runtime Seconds" },
	{ key: "analysisThreadId", label: "Analysis Thread ID" },
	{ key: "analysisCreatedAt", label: "Analysis Created At" },
	{ key: "analysisUpdatedAt", label: "Analysis Updated At" },
	{ key: "verificationTaskId", label: "Verification Task ID" },
	{ key: "verificationResult", label: "Verification Result" },
	{ key: "verificationConfidence", label: "Verification Confidence" },
	{ key: "verificationScore", label: "Verification Score" },
	{ key: "verificationSummary", label: "Verification Summary" },
	{ key: "verificationReportHostPath", label: "Verification Report Host Path" },
	{
		key: "verificationRuntimeSeconds",
		label: "Verification Runtime Seconds",
	},
	{ key: "verificationThreadId", label: "Verification Thread ID" },
	{ key: "verificationCreatedAt", label: "Verification Created At" },
	{ key: "verificationUpdatedAt", label: "Verification Updated At" },
	{ key: "triageTaskId", label: "Triage Task ID" },
	{ key: "triageResult", label: "Triage Result" },
	{ key: "triageSecurityClassification", label: "Triage Classification" },
	{ key: "triageIsSecurityIssue", label: "Triage Is Security Issue" },
	{ key: "triageImpactType", label: "Triage Impact Type" },
	{ key: "triageCvssVector", label: "Triage CVSS Vector" },
	{ key: "triageCvssScore", label: "Triage CVSS Score" },
	{ key: "triageCvssSeverity", label: "Triage CVSS Severity" },
	{ key: "triageExploitability", label: "Triage Exploitability" },
	{ key: "triageIsExploitable", label: "Triage Is Exploitable" },
	{ key: "triageEpssProbability30d", label: "Triage EPSS 30d" },
	{ key: "triageEpssSource", label: "Triage EPSS Source" },
	{ key: "triageSummary", label: "Triage Summary" },
	{ key: "triageReportHostPath", label: "Triage Report Host Path" },
] as const;

type CandidateExportField = (typeof CANDIDATE_EXPORT_FIELDS)[number]["key"];

const DEFAULT_CANDIDATE_EXPORT_FIELDS = CANDIDATE_EXPORT_FIELDS.map(
	(field) => field.key,
);

const buildCandidateExportFilename = (scanJobId: string) => {
	const timestamp = new Date()
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "")
		.replace("T", "-");
	return `scan-candidates-${scanJobId}-${timestamp}.json`;
};

const copyTextToClipboard = async (text: string) => {
	if (navigator.clipboard?.writeText) {
		await navigator.clipboard.writeText(text);
		return;
	}

	const textarea = document.createElement("textarea");
	textarea.value = text;
	textarea.setAttribute("readonly", "true");
	textarea.style.position = "fixed";
	textarea.style.left = "-9999px";
	textarea.style.top = "0";
	document.body.appendChild(textarea);
	textarea.select();
	const didCopy = document.execCommand("copy");
	textarea.remove();
	if (!didCopy) {
		throw new Error("Failed to copy candidate JSON");
	}
};

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
		: `${totalValue} / (${cachedValue} ${cacheLabel})`;
};

const resolveRequestedTab = (
	value: string | string[] | undefined,
): ScanJobTab => {
	const rawTab =
		typeof value === "string" ? value : Array.isArray(value) ? value[0] : "";
	if (
		rawTab === "overview" ||
		rawTab === "tasks" ||
		rawTab === "analysis" ||
		rawTab === "verify" ||
		rawTab === "candidates" ||
		rawTab === "monitoring" ||
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

	return (
		<div className="h-[65vh] overflow-auto p-2">{renderItems(rootItems)}</div>
	);
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

	if (result === "true") {
		return {
			label: "True",
			className: "border-emerald-200 bg-emerald-100 text-emerald-700",
		};
	}

	if (result === "likely") {
		return {
			label: "Likely",
			className: "border-amber-200 bg-amber-100 text-amber-700",
		};
	}

	return {
		label: getShortResultLabel(result),
		className: "border-muted-foreground/20 bg-muted text-muted-foreground",
	};
};

const getTriageResultBadgeClassName = (result?: string | null) => {
	if (result === "security_issue") {
		return "border-red-200 bg-red-100 text-red-700";
	}

	if (result === "non_security") {
		return "border-muted-foreground/20 bg-muted text-muted-foreground";
	}

	if (result === "needs_more_information") {
		return "border-amber-200 bg-amber-100 text-amber-700";
	}

	return "border-muted-foreground/20 bg-muted text-muted-foreground";
};

const getTaskStageLabel = (stage?: string) => {
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
	return "Task";
};

const TERMINAL_CANDIDATE_STATUSES = new Set(["completed", "failed", "exited"]);
const RERUNNABLE_TASK_STATUSES = new Set(["completed", "failed", "exited"]);

const getTaskStatusLabel = (status?: string) => {
	if (!status) {
		return "-";
	}
	return status
		.replace(/_/g, " ")
		.replace(/\b\w/g, (char) => char.toUpperCase());
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

const TASK_STAGE_OPTIONS = Object.keys(RUNNING_TASK_STAGE_ORDER);
const TERMINAL_TASK_STATUS_OPTIONS = ["completed", "failed", "exited"];
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
	if (queueId === "triage") {
		return "h-3 bg-secondary/70 [&>div]:bg-indigo-500";
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
	const initialCandidateListQueryState = parseCandidateListQueryState(
		router.query,
	);
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
	const [triageFilters, setTriageFilters] = useState<string[]>(
		() => initialCandidateListQueryState.triageFilters,
	);
	const [candidateSortKey, setCandidateSortKey] = useState<CandidateSortKey>(
		() => initialCandidateListQueryState.candidateSortKey,
	);
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
	const [selectedCandidateIds, setSelectedCandidateIds] = useState<Set<string>>(
		() => new Set(),
	);
	const [isCandidateExportDialogOpen, setIsCandidateExportDialogOpen] =
		useState(false);
	const [candidateExportFields, setCandidateExportFields] = useState<
		CandidateExportField[]
	>(() => [...DEFAULT_CANDIDATE_EXPORT_FIELDS]);
	const [taskSearchQuery, setTaskSearchQuery] = useState("");
	const [taskStageFilter, setTaskStageFilter] = useState("all");
	const [taskStatusFilter, setTaskStatusFilter] = useState("all");
	const [runningTaskPage, setRunningTaskPage] = useState(1);
	const [runningTaskPageSize, setRunningTaskPageSize] = useState(10);
	const [finishedTaskPage, setFinishedTaskPage] = useState(1);
	const [finishedTaskPageSize, setFinishedTaskPageSize] = useState(20);
	const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
	const [noteDraft, setNoteDraft] = useState("");
	const [expandedDirectories, setExpandedDirectories] = useState<
		Record<string, boolean>
	>({});
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
		{ enabled: !!scanJobId, refetchInterval: 1000 },
	);
	const shouldLoadStatusView =
		activeTab === "overview" ||
		activeTab === "tasks" ||
		activeTab === "analysis" ||
		activeTab === "verify";
	const shouldLoadJobActivities =
		activeTab === "tasks" || activeTab === "analysis" || activeTab === "verify";
	const { data: candidates, isLoading: isLoadingCandidates } =
		api.scan.candidates.useQuery(
			{
				scanJobId,
				page: candidatePage,
				pageSize: candidatePageSize,
				query: candidateQuery,
				analysisResults: analysisFilters,
				verifyResults: verifyFilters,
				triageResults: triageFilters,
				sortKey: candidateSortKey,
				sortDirection: candidateSortDirection,
			},
			{
				enabled: !!scanJobId && activeTab === "candidates",
				refetchInterval: activeTab === "candidates" ? 1000 : false,
				keepPreviousData: true,
			},
		);
	const {
		data: statusView,
		isLoading: isLoadingStatusView,
		error: statusViewError,
	} = api.scan.statusView.useQuery(
		{ scanJobId },
		{
			enabled: !!scanJobId && shouldLoadStatusView,
			refetchInterval: shouldLoadStatusView ? 1000 : false,
		},
	);
	const { data: terminalTasks, isLoading: isLoadingTerminalTasks } =
		api.scan.terminalTasks.useQuery(
			{
				scanJobId,
				page: finishedTaskPage,
				pageSize: finishedTaskPageSize,
				query: taskSearchQuery,
				stage: taskStageFilter,
				status: taskStatusFilter,
			},
			{
				enabled: !!scanJobId && activeTab === "tasks",
				refetchInterval: activeTab === "tasks" ? 1000 : false,
				keepPreviousData: true,
			},
		);
	const { activitiesByTaskId, connectedTaskIds: activityConnectedTaskIds } =
		useSandboxAgentActivities({
			scanJobId,
			enabled: !!scanJobId && shouldLoadJobActivities,
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
	const [reanalyzingCandidateId, setReanalyzingCandidateId] = useState<
		string | null
	>(null);
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
			triageFilters,
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
			triageFilters,
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
		setTriageFilters(candidateListQueryState.triageFilters);
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
			currentCandidateListStateSerialized === candidateListQueryStateSerialized
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
		const completed =
			statusView?.scan.repositoryTaskStatus === "completed" ? 1 : 0;
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
			percent:
				total > 0 ? Math.max(0, Math.min(100, (completed / total) * 100)) : 0,
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
			percent:
				total > 0 ? Math.max(0, Math.min(100, (completed / total) * 100)) : 0,
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
	const getQueueTerminalProgressValue = (
		queue: (typeof queuePendingCounts)[number],
	) =>
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
		const totalItems = terminalTasks?.total ?? 0;
		const pageSize = terminalTasks?.pageSize ?? finishedTaskPageSize;
		const totalPages =
			terminalTasks?.totalPages ??
			Math.max(1, Math.ceil(totalItems / pageSize));
		const page =
			terminalTasks?.page ??
			Math.min(Math.max(1, finishedTaskPage), totalPages);
		const startIndex = totalItems > 0 ? (page - 1) * pageSize : 0;
		const items = terminalTasks?.items ?? [];
		const endIndex = Math.min(totalItems, startIndex + items.length);
		return {
			page,
			pageSize,
			totalItems,
			totalPages,
			startIndex,
			endIndex,
			items,
		};
	}, [finishedTaskPage, finishedTaskPageSize, terminalTasks]);

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

	const analysisQueuedCount = statusView?.summary.analysisQueuedCandidates ?? 0;
	const verifyQueuedCount =
		statusView?.summary.verificationQueuedCandidates ?? 0;
	const analysisCompletedCandidates =
		statusView?.summary.analysisCompletedCandidates ?? 0;
	const failedAnalysisCandidatesCount =
		statusView?.summary.analysisFailedCandidates ?? 0;
	const verifyEligibleCandidates =
		statusView?.summary.verificationEligibleCandidates ?? 0;
	const verifyCompletedCandidates =
		statusView?.summary.verificationCompletedCandidates ?? 0;
	const failedVerificationCandidatesCount =
		statusView?.summary.verificationFailedCandidates ?? 0;
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
	const candidatePagination = useMemo(() => {
		const totalItems = candidates?.total ?? 0;
		const pageSize = candidates?.pageSize ?? candidatePageSize;
		const totalPages =
			candidates?.totalPages ?? Math.max(1, Math.ceil(totalItems / pageSize));
		const safePage =
			candidates?.page ?? Math.min(Math.max(1, candidatePage), totalPages);
		const startIndex = totalItems > 0 ? (safePage - 1) * pageSize : 0;
		const items = candidates?.items ?? [];
		const endIndex = Math.min(totalItems, startIndex + items.length);
		return {
			page: safePage,
			pageSize,
			totalItems,
			totalPages,
			startIndex,
			endIndex,
			items,
		};
	}, [candidatePage, candidatePageSize, candidates]);
	type CandidateListItem = (typeof candidatePagination.items)[number];
	const currentPageCandidateIds = useMemo(
		() =>
			candidatePagination.items.map(
				(candidate) => candidate.vulnerabilityCandidateId,
			),
		[candidatePagination.items],
	);
	const selectedCurrentPageCandidates = useMemo(
		() =>
			candidatePagination.items.filter((candidate) =>
				selectedCandidateIds.has(candidate.vulnerabilityCandidateId),
			),
		[candidatePagination.items, selectedCandidateIds],
	);
	const selectedCandidateCount = selectedCurrentPageCandidates.length;
	const hasCurrentPageCandidates = currentPageCandidateIds.length > 0;
	const areAllCurrentPageCandidatesSelected =
		hasCurrentPageCandidates &&
		currentPageCandidateIds.every((candidateId) =>
			selectedCandidateIds.has(candidateId),
		);
	const areSomeCurrentPageCandidatesSelected =
		selectedCandidateCount > 0 && !areAllCurrentPageCandidatesSelected;
	const selectedExportFieldSet = useMemo(
		() => new Set(candidateExportFields),
		[candidateExportFields],
	);
	const hasSelectedExportFields = candidateExportFields.length > 0;

	useEffect(() => {
		if (candidatePage !== candidatePagination.page) {
			setCandidatePage(candidatePagination.page);
		}
	}, [candidatePage, candidatePagination.page]);
	useEffect(() => {
		const currentPageIds = new Set(currentPageCandidateIds);
		setSelectedCandidateIds((current) => {
			let changed = false;
			const next = new Set<string>();
			for (const candidateId of current) {
				if (currentPageIds.has(candidateId)) {
					next.add(candidateId);
				} else {
					changed = true;
				}
			}
			return changed ? next : current;
		});
	}, [currentPageCandidateIds]);
	const hasCandidateFilters =
		candidateQuery.trim().length > 0 ||
		analysisFilters.length > 0 ||
		verifyFilters.length > 0 ||
		triageFilters.length > 0;
	const hasAnyCandidates =
		(statusView?.summary.totalCandidates ?? candidates?.total ?? 0) > 0;
	const hasFinishedTaskFilters =
		taskSearchQuery.trim().length > 0 ||
		taskStageFilter !== "all" ||
		taskStatusFilter !== "all";

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

	const toggleTriageFilter = (value: string) => {
		setCandidatePage(1);
		setTriageFilters((current) =>
			current.includes(value)
				? current.filter((item) => item !== value)
				: [...current, value],
		);
	};

	const toggleCandidateSelection = (candidateId: string) => {
		setSelectedCandidateIds((current) => {
			const next = new Set(current);
			if (next.has(candidateId)) {
				next.delete(candidateId);
			} else {
				next.add(candidateId);
			}
			return next;
		});
	};

	const toggleCurrentPageCandidateSelection = () => {
		setSelectedCandidateIds((current) => {
			if (areAllCurrentPageCandidatesSelected) {
				return new Set();
			}
			return new Set([...current, ...currentPageCandidateIds]);
		});
	};

	const toggleCandidateExportField = (field: CandidateExportField) => {
		setCandidateExportFields((current) =>
			current.includes(field)
				? current.filter((item) => item !== field)
				: [...current, field],
		);
	};

	const buildCandidateExportRecord = (candidate: CandidateListItem) => {
		const candidateWithHostPaths = candidate as CandidateListItem & {
			fileHostPath?: string | null;
			latestAnalysisResult?:
				| (CandidateListItem["latestAnalysisResult"] & {
						reportHostPath?: string | null;
				  })
				| null;
			latestVerificationResult?:
				| (CandidateListItem["latestVerificationResult"] & {
						reportHostPath?: string | null;
				  })
				| null;
			latestTriageResult?:
				| (CandidateListItem["latestTriageResult"] & {
						reportHostPath?: string | null;
				  })
				| null;
		};
		const latestAnalysisResult = candidateWithHostPaths.latestAnalysisResult;
		const latestVerificationResult =
			candidateWithHostPaths.latestVerificationResult;
		const latestTriageResult = candidateWithHostPaths.latestTriageResult;
		const exportableFields: Record<CandidateExportField, unknown> = {
			vulnerabilityCandidateId: candidate.vulnerabilityCandidateId,
			scanJobId: candidate.scanJobId,
			scanFunctionTaskId: candidate.scanFunctionTaskId,
			title: candidate.title,
			description: candidate.description,
			fileHostPath: candidateWithHostPaths.fileHostPath,
			line: candidate.line,
			vulnerabilityType: candidate.vulnerabilityType,
			status: candidate.status,
			currentStage: candidate.currentStage,
			confidence: candidate.confidence,
			score: candidate.score,
			createdAt: candidate.createdAt,
			updatedAt: candidate.updatedAt,
			analysisTaskId: latestAnalysisResult?.taskId ?? null,
			analysisResult: latestAnalysisResult?.result ?? null,
			analysisConfidence: latestAnalysisResult?.confidence ?? null,
			analysisScore: latestAnalysisResult?.score ?? null,
			analysisSummary: latestAnalysisResult?.summary ?? null,
			analysisReportHostPath: latestAnalysisResult?.reportHostPath ?? null,
			analysisRuntimeSeconds: latestAnalysisResult?.runtimeSeconds ?? null,
			analysisThreadId: latestAnalysisResult?.threadId ?? null,
			analysisCreatedAt: latestAnalysisResult?.createdAt ?? null,
			analysisUpdatedAt: latestAnalysisResult?.updatedAt ?? null,
			verificationTaskId: latestVerificationResult?.taskId ?? null,
			verificationResult: latestVerificationResult?.result ?? null,
			verificationConfidence: latestVerificationResult?.confidence ?? null,
			verificationScore: latestVerificationResult?.score ?? null,
			verificationSummary: latestVerificationResult?.summary ?? null,
			verificationReportHostPath:
				latestVerificationResult?.reportHostPath ?? null,
			verificationRuntimeSeconds:
				latestVerificationResult?.runtimeSeconds ?? null,
			verificationThreadId: latestVerificationResult?.threadId ?? null,
			verificationCreatedAt: latestVerificationResult?.createdAt ?? null,
			verificationUpdatedAt: latestVerificationResult?.updatedAt ?? null,
			triageTaskId: latestTriageResult?.taskId ?? null,
			triageResult: latestTriageResult?.result ?? null,
			triageSecurityClassification:
				latestTriageResult?.securityClassification ?? null,
			triageIsSecurityIssue: latestTriageResult?.isSecurityIssue ?? null,
			triageImpactType: latestTriageResult?.impactType ?? null,
			triageCvssVector: latestTriageResult?.cvssVector ?? null,
			triageCvssScore: latestTriageResult?.cvssScore ?? null,
			triageCvssSeverity: latestTriageResult?.cvssSeverity ?? null,
			triageExploitability: latestTriageResult?.exploitability ?? null,
			triageIsExploitable: latestTriageResult?.isExploitable ?? null,
			triageEpssProbability30d:
				latestTriageResult?.epssProbability30d ?? null,
			triageEpssSource: latestTriageResult?.epssSource ?? null,
			triageSummary: latestTriageResult?.summary ?? null,
			triageReportHostPath: latestTriageResult?.reportHostPath ?? null,
		};
		return Object.fromEntries(
			CANDIDATE_EXPORT_FIELDS.filter((field) =>
				selectedExportFieldSet.has(field.key),
			).map((field) => [field.key, exportableFields[field.key]]),
		);
	};

	const buildCandidateExportJson = () =>
		JSON.stringify(
			selectedCurrentPageCandidates.map((candidate) =>
				buildCandidateExportRecord(candidate),
			),
			null,
			2,
		);

	const downloadSelectedCandidatesJson = () => {
		const exportJson = buildCandidateExportJson();
		const blob = new Blob([exportJson], { type: "application/json" });
		const objectUrl = URL.createObjectURL(blob);
		const anchor = document.createElement("a");
		anchor.href = objectUrl;
		anchor.download = buildCandidateExportFilename(scanJobId);
		document.body.appendChild(anchor);
		anchor.click();
		anchor.remove();
		URL.revokeObjectURL(objectUrl);
		toast.success("Candidate JSON downloaded");
	};

	const copySelectedCandidatesJson = async () => {
		try {
			await copyTextToClipboard(buildCandidateExportJson());
			toast.success("Candidate JSON copied");
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to copy candidate JSON",
			);
		}
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
	const shouldIgnoreTaskRowClick = (target: EventTarget | null) =>
		target instanceof Element &&
		!!target.closest("a,button,input,textarea,select,[data-task-row-action]");
	const handleTaskRowClick = (
		event: MouseEvent<HTMLTableRowElement>,
		taskId: string,
	) => {
		if (shouldIgnoreTaskRowClick(event.target)) {
			return;
		}
		void router.push(buildTaskDetailHref(taskId));
	};
	const handleTaskRowKeyDown = (
		event: KeyboardEvent<HTMLTableRowElement>,
		taskId: string,
	) => {
		if (shouldIgnoreTaskRowClick(event.target)) {
			return;
		}
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
			[directoryPath]: {
				items: current[directoryPath]?.items || [],
				status: "loading",
			},
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
					<CardTitle className="text-xl">
						Scan Job {scanJobId.slice(0, 6)}
					</CardTitle>
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
						<TabsList className="flex h-auto min-h-10 w-full justify-start gap-1 overflow-x-auto p-1 sm:gap-2">
							<TabsTrigger className="shrink-0 px-2 sm:px-3" value="overview">
								Overview
							</TabsTrigger>
							<TabsTrigger className="shrink-0 px-2 sm:px-3" value="tasks">
								Tasks
							</TabsTrigger>
							<TabsTrigger className="shrink-0 px-2 sm:px-3" value="analysis">
								Analysis
							</TabsTrigger>
							<TabsTrigger className="shrink-0 px-2 sm:px-3" value="verify">
								Verify
							</TabsTrigger>
							<TabsTrigger className="shrink-0 px-2 sm:px-3" value="candidates">
								Candidates
							</TabsTrigger>
							<TabsTrigger className="shrink-0 px-2 sm:px-3" value="monitoring">
								Monitoring
							</TabsTrigger>
							<TabsTrigger className="shrink-0 px-2 sm:px-3" value="files">
								Files
							</TabsTrigger>
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
										<div className="flex justify-end">
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
									<ScanStageGraph scanJobId={scanJobId} />
									<div className="grid grid-cols-1 md:grid-cols-2 gap-3">
										<div className="border rounded-lg p-3">
											<div className="text-sm text-muted-foreground">
												Status
											</div>
											<div
												className={`font-medium ${getScanJobStatusClassName(scanJob.status)}`}
											>
												{getScanJobStatusLabel(scanJob.status)}
											</div>
										</div>
										<div className="border rounded-lg p-3">
											<div className="text-sm text-muted-foreground">
												Scan Type
											</div>
											<div className="font-medium">
												{scanJob.scanType === "delta"
													? "Delta Scan"
													: "Full Scan"}
											</div>
										</div>
										<div className="border rounded-lg p-3">
											<div className="text-sm text-muted-foreground">
												Trigger
											</div>
											<div className="font-medium">
												{formatTriggerSourceLabel(scanJob.triggerSource)}
											</div>
										</div>
										<div className="border rounded-lg p-3 md:col-span-2">
											<div className="mb-3 text-sm font-medium">Usage</div>
											<div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
												<div>
													<div className="text-sm text-muted-foreground">
														Input / Cache Read
													</div>
													<div className="font-medium">
														{formatTokenUsageWithCache(
															scanJob.inputTokens,
															scanJob.cachedReadTokens,
														)}
													</div>
												</div>
												<div>
													<div className="text-sm text-muted-foreground">
														Output / Cache Write
													</div>
													<div className="font-medium">
														{formatTokenUsageWithCache(
															scanJob.outputTokens,
															scanJob.cachedWriteTokens,
															"write cache",
														)}
													</div>
												</div>
												<div>
													<div className="text-sm text-muted-foreground">
														Total Tokens
													</div>
													<div className="font-medium">
														{formatTokenUsage(scanJob.totalTokens)}
													</div>
												</div>
												<div>
													<div className="text-sm text-muted-foreground">
														Thought Tokens
													</div>
													<div className="font-medium">
														{formatTokenUsage(scanJob.thoughtTokens)}
													</div>
												</div>
											</div>
										</div>
										{scanJob.scanType === "delta" ? (
											<div className="border rounded-lg p-3">
												<div className="text-sm text-muted-foreground">
													Commit Window
												</div>
												<div className="font-medium">
													k={scanJob.commitWindow}
												</div>
											</div>
										) : null}
										<div className="border rounded-lg p-3">
											<div className="text-sm text-muted-foreground">
												Created
											</div>
											<div className="font-medium">
												<DateTooltip date={scanJob.createdAt} />
											</div>
										</div>
										<div className="border rounded-lg p-3">
											<div className="text-sm text-muted-foreground">
												Finished
											</div>
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
												<div className="text-sm text-muted-foreground">
													Error
												</div>
												<div className="font-medium text-destructive break-all">
													{scanJob.errorMessage}
												</div>
											</div>
										)}
										<div className="border rounded-lg p-3 md:col-span-2">
											<div className="flex items-start justify-between gap-3">
												<div>
													<div className="text-sm text-muted-foreground">
														Note
													</div>
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
							{isLoadingStatusView ? (
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
										<div className="flex justify-end">
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
												value:
													statusView.summary
														.analysisLikelyOrConfirmedCandidates,
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
							{isLoadingStatusView ? (
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
										<div className="flex justify-end">
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
										description="Candidates currently being sanity-checked and pending verification."
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
																	(verifyCompletedCandidates /
																		verifyEligibleCandidates) *
																		100,
																),
															)
														: 0,
												progressClassName: "[&>div]:bg-sky-500",
											},
											{
												title: "Facts True/Likely",
												value: statusView.summary.verifiedZeroDayCandidates,
											},
											{
												title: "Triaged",
												value:
													statusView.summary.triageCompletedCandidates ??
													0,
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
							) : !candidates ||
								(!hasAnyCandidates &&
									!hasCandidateFilters &&
									candidates.total === 0) ? (
								<div className="flex items-center gap-2 text-muted-foreground">
									<FileSearch className="size-4" />
									No Candidates yet
								</div>
							) : (
								<div className="flex flex-col gap-3">
									<div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_220px_220px_220px]">
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
													<div className="text-sm font-medium">
														Analysis Result
													</div>
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
																onCheckedChange={() =>
																	toggleAnalysisFilter(value)
																}
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
													<div className="text-sm font-medium">
														Verify Result
													</div>
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
																onCheckedChange={() =>
																	toggleVerifyFilter(value)
																}
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
														Triage Result
														{triageFilters.length > 0
															? ` (${triageFilters.length})`
															: ""}
													</span>
													<ChevronsUpDown className="size-4 text-muted-foreground" />
												</Button>
											</PopoverTrigger>
											<PopoverContent align="end" className="w-72 p-3">
												<div className="mb-3 flex items-center justify-between">
													<div className="text-sm font-medium">
														Triage Result
													</div>
													<Button
														type="button"
														variant="ghost"
														size="sm"
														className="h-auto px-2 py-1 text-xs"
														onClick={() => setTriageFilters([])}
													>
														Clear
													</Button>
												</div>
												<div className="space-y-2">
													{TRIAGE_RESULT_OPTIONS.map((value) => (
														<label
															key={value}
															className="flex items-center gap-2 text-sm"
														>
															<Checkbox
																checked={triageFilters.includes(value)}
																onCheckedChange={() =>
																	toggleTriageFilter(value)
																}
															/>
															<span>{formatResultLabel(value)}</span>
														</label>
													))}
												</div>
											</PopoverContent>
										</Popover>
									</div>
									{candidatePagination.totalItems === 0 ? (
										<div className="flex items-center gap-2 text-muted-foreground">
											<FileSearch className="size-4" />
											No matching candidates
										</div>
									) : (
										<>
											<div className="rounded-lg border">
												<div className="flex flex-col gap-3 border-b px-4 py-3 text-sm md:flex-row md:items-center md:justify-between">
													<div className="text-muted-foreground">
														Showing {candidatePagination.startIndex + 1}-
														{candidatePagination.endIndex} of{" "}
														{candidatePagination.totalItems}
														{selectedCandidateCount > 0
															? ` (${selectedCandidateCount} selected)`
															: ""}
													</div>
													<div className="flex flex-wrap items-center gap-2">
														<Button
															type="button"
															variant="outline"
															size="sm"
															disabled={selectedCandidateCount === 0}
															onClick={() =>
																setIsCandidateExportDialogOpen(true)
															}
														>
															<Download className="mr-2 size-4" />
															Export
														</Button>
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
																setCandidatePage((current) =>
																	Math.max(1, current - 1),
																)
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
																<th className="w-12 px-4 py-3 font-medium">
																	<Checkbox
																		aria-label="Select all candidates on this page"
																		checked={
																			areAllCurrentPageCandidatesSelected
																				? true
																				: areSomeCurrentPageCandidatesSelected
																					? "indeterminate"
																					: false
																		}
																		onClick={(event) => event.stopPropagation()}
																		onCheckedChange={
																			toggleCurrentPageCandidateSelection
																		}
																	/>
																</th>
																<th className="w-[10%] px-4 py-3 font-medium">
																	Status
																</th>
																<th className="w-[32%] px-4 py-3 font-medium">
																	<button
																		type="button"
																		onClick={() =>
																			toggleCandidateSort("candidate")
																		}
																		className="inline-flex items-center gap-1 hover:text-foreground"
																	>
																		<span>Candidate</span>
																		<ChevronsUpDown className="size-3.5" />
																	</button>
																</th>
																<th className="w-[16%] px-4 py-3 font-medium">
																	<button
																		type="button"
																		onClick={() =>
																			toggleCandidateSort("analysis")
																		}
																		className="inline-flex items-center gap-1 hover:text-foreground"
																	>
																		<span>Analysis Result</span>
																		<ChevronsUpDown className="size-3.5" />
																	</button>
																</th>
																<th className="w-[14%] px-4 py-3 font-medium">
																	<button
																		type="button"
																		onClick={() =>
																			toggleCandidateSort("verify")
																		}
																		className="inline-flex items-center gap-1 hover:text-foreground"
																	>
																		<span>Verify Result</span>
																		<ChevronsUpDown className="size-3.5" />
																	</button>
																</th>
																<th className="w-[18%] px-4 py-3 font-medium">
																	Triage Result
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
																const verificationTruthBadge =
																	getVerificationTruthBadge(
																		candidate.latestVerificationResult?.result,
																	);
																const isTerminalCandidate =
																	TERMINAL_CANDIDATE_STATUSES.has(
																		candidate.status,
																	);
																const isReanalyzingCandidate =
																	reanalyzingCandidateId ===
																	candidate.vulnerabilityCandidateId;
																const isSelectedCandidate =
																	selectedCandidateIds.has(
																		candidate.vulnerabilityCandidateId,
																	);
																return (
																	<tr
																		key={candidate.vulnerabilityCandidateId}
																		className={`border-b last:border-b-0 transition-colors hover:bg-muted/40 ${
																			isSelectedCandidate ? "bg-muted/40" : ""
																		}`}
																	>
																		<td className="px-4 py-3 align-top">
																			<Checkbox
																				aria-label={`Select candidate ${candidate.title}`}
																				checked={isSelectedCandidate}
																				onClick={(event) =>
																					event.stopPropagation()
																				}
																				onCheckedChange={() =>
																					toggleCandidateSelection(
																						candidate.vulnerabilityCandidateId,
																					)
																				}
																			/>
																		</td>
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
																				<div className="font-medium">
																					{candidate.title}
																				</div>
																				<div className="mt-1 text-xs text-muted-foreground break-all">
																					{candidate.filePath || "-"}
																					{candidate.line
																						? `:${candidate.line}`
																						: ""}
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
																				{candidate.latestAnalysisResult
																					?.result ? (
																					<Badge
																						variant="outline"
																						className={getAnalysisResultBadgeClassName(
																							candidate.latestAnalysisResult
																								.result,
																						)}
																					>
																						{getShortResultLabel(
																							candidate.latestAnalysisResult
																								.result,
																						)}
																					</Badge>
																				) : (
																					<span className="text-xs text-muted-foreground">
																						-
																					</span>
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
																					<span className="text-xs text-muted-foreground">
																						-
																					</span>
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
																				{candidate.latestTriageResult ? (
																					<Badge
																						variant="outline"
																						className={getTriageResultBadgeClassName(
																							candidate.latestTriageResult.result,
																						)}
																					>
																						{getShortResultLabel(
																							candidate.latestTriageResult.result,
																						)}
																					</Badge>
																				) : (
																					<span className="text-xs text-muted-foreground">
																						-
																					</span>
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
											<Dialog
												open={isCandidateExportDialogOpen}
												onOpenChange={setIsCandidateExportDialogOpen}
											>
												<DialogContent className="sm:max-w-xl">
													<DialogHeader>
														<DialogTitle>Export Candidates</DialogTitle>
														<DialogDescription>
															Export {selectedCandidateCount} selected candidate
															{selectedCandidateCount === 1 ? "" : "s"} from the
															current page.
														</DialogDescription>
													</DialogHeader>
													<div className="space-y-4">
														<div className="flex items-center justify-between gap-3">
															<div>
																<div className="text-sm font-medium">
																	Fields
																</div>
																<div className="text-xs text-muted-foreground">
																	Choose the fields included in the generated
																	JSON.
																</div>
															</div>
															<Button
																type="button"
																variant="ghost"
																size="sm"
																className="h-auto px-2 py-1 text-xs"
																onClick={() =>
																	setCandidateExportFields(
																		candidateExportFields.length ===
																			CANDIDATE_EXPORT_FIELDS.length
																			? []
																			: [...DEFAULT_CANDIDATE_EXPORT_FIELDS],
																	)
																}
															>
																{candidateExportFields.length ===
																CANDIDATE_EXPORT_FIELDS.length
																	? "Clear"
																	: "Select all"}
															</Button>
														</div>
														<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
															{CANDIDATE_EXPORT_FIELDS.map((field) => (
																<label
																	key={field.key}
																	className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
																>
																	<Checkbox
																		checked={selectedExportFieldSet.has(
																			field.key,
																		)}
																		onCheckedChange={() =>
																			toggleCandidateExportField(field.key)
																		}
																	/>
																	<span>{field.label}</span>
																</label>
															))}
														</div>
														{!hasSelectedExportFields ? (
															<div className="text-xs text-destructive">
																Select at least one field to export.
															</div>
														) : null}
													</div>
													<DialogFooter>
														<Button
															type="button"
															variant="outline"
															onClick={copySelectedCandidatesJson}
															disabled={
																selectedCandidateCount === 0 ||
																!hasSelectedExportFields
															}
														>
															<Clipboard className="mr-2 size-4" />
															Copy JSON
														</Button>
														<Button
															type="button"
															onClick={downloadSelectedCandidatesJson}
															disabled={
																selectedCandidateCount === 0 ||
																!hasSelectedExportFields
															}
														>
															<Download className="mr-2 size-4" />
															Download JSON
														</Button>
													</DialogFooter>
												</DialogContent>
											</Dialog>
										</>
									)}
								</div>
							)}
						</TabsContent>

						<TabsContent value="monitoring" className="pt-4">
							<ScanMonitoring mode="job" scanJobId={scanJobId} />
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

						<TabsContent value="tasks" className="pt-4">
							<div className="flex flex-col gap-4">
								{shouldShowRetryFailedTasks ? (
									<div className="flex justify-end">
										<Button
											type="button"
											disabled={
												retryFailedTasksMutation.isLoading ||
												!canRetryFailedTasks
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
														<th className="w-[28%] px-4 py-3 font-medium">
															Queue
														</th>
														<th className="w-[36%] px-4 py-3 font-medium">
															Tasks
														</th>
														<th className="w-[36%] px-4 py-3 font-medium">
															Progress
														</th>
													</tr>
												</thead>
												<tbody>
													{queuePendingCounts.map((queue) => {
														const metrics = getQueueTaskMetrics(queue);
														return (
															<tr
																key={queue.id}
																className="border-b last:border-b-0"
															>
																<td className="px-4 py-3 align-top font-medium">
																	{queue.title}
																</td>
																<td
																	className="px-4 py-3 align-top"
																	title={metrics.title}
																>
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
																				<span className="text-red-600">
																					failed
																				</span>
																			</span>
																		) : null}
																	</div>
																</td>
																<td
																	className="px-4 py-3 align-top"
																	title={metrics.title}
																>
																	<div className="flex items-center gap-3">
																		<Progress
																			value={getQueueTerminalProgressValue(
																				queue,
																			)}
																			className={getQueueProgressClassName(
																				queue.id,
																			)}
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
											All running scanning, analysis, and verification agents
											for this job.
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
													{TASK_STAGE_OPTIONS.map((stage) => (
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
														<th className="w-[22%] px-4 py-3 font-medium">
															Task
														</th>
														<th className="w-[10%] px-4 py-3 font-medium">
															Stage
														</th>
														<th className="w-[10%] px-4 py-3 font-medium">
															Runtime
														</th>
														<th className="w-[48%] px-4 py-3 font-medium">
															Current Activity
														</th>
														<th className="w-[10%] px-4 py-3 font-medium">
															Actions
														</th>
													</tr>
												</thead>
												<tbody>
													{runningTaskPagination.items.map((task) => (
														<tr
															key={task.id}
															tabIndex={0}
															aria-label={`Open task ${task.title}`}
															onClick={(event) =>
																handleTaskRowClick(event, task.taskId)
															}
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
															<td className="w-[10%] px-4 py-3 align-top capitalize">
																{getTaskStageLabel(task.stage)}
															</td>
															<td className="w-[10%] whitespace-nowrap px-4 py-3 align-top tabular-nums">
																{formatTaskRuntime(
																	task.startedAt,
																	runtimeNowMs,
																)}
															</td>
															<td className="w-[48%] px-4 py-3 align-top">
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
															<td
																className="w-[10%] px-4 py-3 align-top"
																data-task-row-action
															>
																<div className="flex items-center gap-2">
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
																	<LiveTaskTextButton
																		taskId={task.taskId}
																		title={task.title}
																		subtitle={task.subtitle}
																		variant="outline"
																		size="icon"
																		iconOnly
																	/>
																</div>
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
									{terminalTasks &&
									(terminalTasks.total > 0 || hasFinishedTaskFilters) ? (
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
													{TASK_STAGE_OPTIONS.map((stage) => (
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
													{TERMINAL_TASK_STATUS_OPTIONS.map((status) => (
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
										{isLoadingTerminalTasks ? (
											<div className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
												<Loader2 className="size-4 animate-spin" />
												Loading finished tasks...
											</div>
										) : !terminalTasks ||
											(terminalTasks.total === 0 && !hasFinishedTaskFilters) ? (
											<div className="px-4 py-6 text-sm text-muted-foreground">
												No finished tasks
											</div>
										) : terminalTasks.total === 0 ||
											finishedTaskPagination.items.length === 0 ? (
											<div className="px-4 py-6 text-sm text-muted-foreground">
												No matching tasks
											</div>
										) : (
											<table className="w-full text-sm">
												<thead className="border-b bg-muted/30 text-left">
													<tr>
														<th className="w-[22%] px-4 py-3 font-medium">
															Task
														</th>
														<th className="w-[9%] px-4 py-3 font-medium">
															Stage
														</th>
														<th className="w-[9%] px-4 py-3 font-medium">
															Status
														</th>
														<th className="w-[11%] px-4 py-3 font-medium">
															Started
														</th>
														<th className="w-[11%] px-4 py-3 font-medium">
															Finished
														</th>
														<th className="w-[30%] px-4 py-3 font-medium">
															Details
														</th>
														<th className="w-[8%] px-4 py-3 font-medium">
															Actions
														</th>
													</tr>
												</thead>
												<tbody>
													{finishedTaskPagination.items.map((task) => {
														const canRerunTask = RERUNNABLE_TASK_STATUSES.has(
															task.status,
														);
														const isRerunningTask =
															rerunningTaskId === task.taskId;
														return (
															<tr
																key={task.id}
																role="link"
																tabIndex={0}
																aria-label={`Open task ${task.title}`}
																onClick={() =>
																	void router.push(
																		buildTaskDetailHref(task.taskId),
																	)
																}
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
																		className={getTaskStatusBadgeClassName(
																			task.status,
																		)}
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
