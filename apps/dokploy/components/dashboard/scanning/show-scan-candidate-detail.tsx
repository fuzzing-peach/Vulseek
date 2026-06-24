import {
	Activity,
	AlertCircle,
	ExternalLink,
	FileIcon,
	FileText,
	Folder,
	Loader2,
	Plus,
	RefreshCw,
	ShieldCheck,
	Tag,
	X,
	Workflow,
} from "lucide-react";
import Head from "next/head";
import { useTranslation } from "next-i18next";
import Link from "next/link";
import { useRouter } from "next/router";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
	buildCandidateListStateHref,
	parseCandidateListQueryState,
} from "@/components/dashboard/scanning/candidate-list-query-state";
import { JsonRpcSummaryPanel } from "@/components/dashboard/scanning/jsonrpc-summary";
import { useSandboxAgentText } from "@/components/dashboard/scanning/live-task-activity";
import { useSandboxAgentSession } from "@/components/dashboard/scanning/use-sandbox-agent-session";
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
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Tree } from "@/components/ui/file-tree";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { api } from "@/utils/api";
import {
	formatAnalysisResultLabel,
	formatScanStageLabel,
	formatScanStatusLabel,
	formatTruthResultLabel,
	scanT,
	type ScanTranslation,
} from "./scan-i18n";

interface Props {
	serviceType: "application" | "compose";
	routeSegment: "profiles" | "services";
}

const RERUNNABLE_CANDIDATE_STATUSES = new Set(["completed", "failed", "exited"]);

const getAnalysisResultBadgeClassName = (result?: string | null) => {
	if (result === "real_vulnerability") {
		return "border-red-200 bg-red-100 text-red-700 dark:border-red-500/60 dark:bg-red-950/50 dark:text-red-100";
	}

	if (result === "likely_vulnerability") {
		return "border-orange-200 bg-orange-100 text-orange-700 dark:border-orange-500/60 dark:bg-orange-950/50 dark:text-orange-100";
	}

	if (result === "plausible_but_unproven") {
		return "border-yellow-200 bg-yellow-100 text-yellow-700 dark:border-yellow-500/60 dark:bg-yellow-950/50 dark:text-yellow-100";
	}

	if (result === "false_positive") {
		return "border-muted-foreground/20 bg-muted text-muted-foreground";
	}

	if (result === "api_misuse") {
		return "border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-500/60 dark:bg-slate-900/70 dark:text-slate-100";
	}

	return "border-muted-foreground/20 bg-muted text-muted-foreground";
};

const getVerificationTruthBadge = (
	t: ScanTranslation,
	result?: string | null,
): { label: string; className: string } | null => {
	if (!result) {
		return null;
	}

	if (result === "true") {
		return {
			label: scanT(t, "scan.candidate.factsTrue", "Facts True"),
			className:
				"border-emerald-200 bg-emerald-100 text-emerald-700 dark:border-emerald-500/60 dark:bg-emerald-950/50 dark:text-emerald-100",
		};
	}

	if (result === "likely") {
		return {
			label: scanT(t, "scan.candidate.factsLikely", "Facts Likely"),
			className:
				"border-amber-200 bg-amber-100 text-amber-700 dark:border-amber-500/60 dark:bg-amber-950/50 dark:text-amber-100",
		};
	}

	return {
		label: scanT(t, "scan.candidate.factsFalse", "Facts False"),
		className: "border-muted-foreground/20 bg-muted text-muted-foreground",
	};
};

type CandidateTaskLineageTask = {
	taskId: string;
	scanJobId: string;
	parentTaskId: string | null;
	stageName: string;
	status: string;
	name: string;
	attempt: number;
	runtimeMode: string | null;
	createdAt: string;
	startedAt: string | null;
	completedAt: string | null;
	relation: "repository" | "module" | "function" | "candidate";
};

const getTaskStageLabel = (t: ScanTranslation, stage?: string | null) => {
	if (stage === "delta-scope") {
		return formatScanStageLabel(t, "delta-scope");
	}
	if (stage === "repository-scan") {
		return formatScanStageLabel(t, "repository");
	}
	if (stage === "module-scan") {
		return formatScanStageLabel(t, "module");
	}
	if (stage === "function-scan") {
		return formatScanStageLabel(t, "function");
	}
	if (stage === "analyze") {
		return formatScanStageLabel(t, "analyze");
	}
	if (stage === "criticize") {
		return formatScanStageLabel(t, "criticize");
	}
	if (stage === "build-fuzzer") {
		return formatScanStageLabel(t, "build-fuzzer");
	}
	if (stage === "run-fuzzer") {
		return formatScanStageLabel(t, "run-fuzzer");
	}
	if (stage === "verify") {
		return formatScanStageLabel(t, "verify");
	}
	if (stage === "triage") {
		return formatScanStageLabel(t, "triage");
	}
	return formatScanStageLabel(t, stage);
};

const getTaskStatusBadgeClassName = (status?: string | null) => {
	if (status === "completed") {
		return "border-emerald-200 bg-emerald-100 text-emerald-700 dark:border-emerald-500/60 dark:bg-emerald-950/50 dark:text-emerald-100";
	}
	if (status === "failed") {
		return "border-red-200 bg-red-100 text-red-700 dark:border-red-500/60 dark:bg-red-950/50 dark:text-red-100";
	}
	if (
		status === "running" ||
		status === "starting" ||
		status === "launched" ||
		status === "launching"
	) {
		return "border-sky-200 bg-sky-100 text-sky-700 dark:border-sky-500/60 dark:bg-sky-950/50 dark:text-sky-100";
	}
	if (status === "pending") {
		return "border-amber-200 bg-amber-100 text-amber-700 dark:border-amber-500/60 dark:bg-amber-950/50 dark:text-amber-100";
	}
	if (status === "canceled") {
		return "border-amber-200 bg-amber-100 text-amber-700 dark:border-amber-500/60 dark:bg-amber-950/50 dark:text-amber-100";
	}
	return "border-muted-foreground/20 bg-muted text-muted-foreground";
};

const isContainerNearBottom = (container: HTMLElement) =>
	container.scrollHeight - container.scrollTop - container.clientHeight <= 16;

const CandidateTaskLineagePanel = ({
	candidateId,
	projectId,
	environmentId,
	serviceType,
	routeSegment,
	serviceId,
	scanJobId,
	scanFunctionTaskId,
	enabled,
}: {
	candidateId: string;
	projectId: string;
	environmentId: string;
	serviceType: "application" | "compose";
	routeSegment: "profiles" | "services";
	serviceId: string;
	scanJobId: string;
	scanFunctionTaskId?: string;
	enabled: boolean;
}) => {
	const { t } = useTranslation("scan");
	const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
	const [taskOutputView, setTaskOutputView] = useState<"activities" | "text">(
		"activities",
	);
	const textContainerRef = useRef<HTMLPreElement | null>(null);
	const textAutoScrollRef = useRef(true);
	const { data, isLoading, isError, error } =
		api.scan.candidateTaskLineage.useQuery(
			{ vulnerabilityCandidateId: candidateId, scanJobId, scanFunctionTaskId },
			{
				enabled: enabled && !!candidateId && !!scanJobId,
				refetchInterval: enabled ? 4000 : false,
			},
		);
	const tasks = (data?.tasks || []) as CandidateTaskLineageTask[];
	const selectedTask =
		tasks.find((task) => task.taskId === selectedTaskId) || tasks[0] || null;
	const activityState = useSandboxAgentSession({
		taskId: selectedTask?.taskId || "",
		enabled: !!selectedTask?.taskId && taskOutputView === "activities",
	});
	const textState = useSandboxAgentText({
		taskId: selectedTask?.taskId || "",
		enabled: !!selectedTask?.taskId && taskOutputView === "text",
	});
	const upstreamTasks = tasks.filter((task) => task.relation !== "candidate");
	const downstreamTasks = tasks.filter((task) => task.relation === "candidate");
	const taskHref = (taskId: string) =>
		`/dashboard/project/${projectId}/environment/${environmentId}/${routeSegment}/${serviceType}/${serviceId}/jobs/${scanJobId}/tasks/${encodeURIComponent(taskId)}`;

	useEffect(() => {
		if (!tasks.length) {
			setSelectedTaskId(null);
			return;
		}
		setSelectedTaskId((current) =>
			current && tasks.some((task) => task.taskId === current)
				? current
				: tasks[0]?.taskId || null,
		);
	}, [tasks]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: keep text output pinned to the bottom as new chunks append.
	useEffect(() => {
		if (taskOutputView !== "text") {
			textAutoScrollRef.current = true;
			return;
		}
		const container = textContainerRef.current;
		if (!container || !textAutoScrollRef.current) {
			return;
		}
		container.scrollTop = container.scrollHeight;
	}, [taskOutputView, textState.text]);

	const renderTaskGroup = (
		label: string,
		groupTasks: CandidateTaskLineageTask[],
	) => (
		<div className="space-y-2">
			<div className="px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				{label}
			</div>
			{groupTasks.length === 0 ? (
				<div className="rounded-md border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
					{scanT(t, "scan.tasks.empty", "暂无阶段任务。")}
				</div>
			) : (
				groupTasks.map((task) => (
					<div
						key={task.taskId}
						className={cn(
							"flex items-start gap-2 rounded-md border p-2 transition-colors hover:bg-muted/40",
							selectedTask?.taskId === task.taskId &&
								"border-foreground/30 bg-muted/50",
						)}
					>
						<button
							type="button"
							onClick={() => setSelectedTaskId(task.taskId)}
							className="min-w-0 flex-1 text-left"
						>
							<div className="min-w-0">
								<div className="truncate text-sm font-medium">{task.name}</div>
								<div className="mt-1 flex flex-wrap items-center gap-2">
									<Badge variant="outline">
										{getTaskStageLabel(t, task.stageName)}
									</Badge>
									<Badge
										variant="outline"
										className={getTaskStatusBadgeClassName(task.status)}
									>
										{formatScanStatusLabel(t, task.status)}
									</Badge>
								</div>
							</div>
						</button>
						<Button
							asChild
							variant="ghost"
							size="icon"
							className="size-8 shrink-0"
							title={scanT(t, "scan.task.openDetail", "打开阶段任务详情")}
						>
							<Link href={taskHref(task.taskId)}>
								<ExternalLink className="size-4" />
							</Link>
						</Button>
					</div>
				))
			)}
		</div>
	);

	if (isLoading) {
		return (
			<div className="flex items-center gap-2 text-muted-foreground">
				<Loader2 className="size-4 animate-spin" />
				{scanT(t, "scan.candidate.loadingLineage", "正在加载阶段任务 lineage...")}
			</div>
		);
	}

	if (isError) {
		return (
			<div className="flex items-center gap-2 text-muted-foreground">
				<AlertCircle className="size-4" />
				{error?.message ||
					scanT(
						t,
						"scan.candidate.lineageLoadError",
						"无法加载阶段任务 lineage",
					)}
			</div>
		);
	}

	return (
		<div className="grid min-h-[65vh] grid-cols-1 overflow-hidden rounded-lg border lg:grid-cols-[360px_minmax(0,1fr)]">
			<div className="border-b bg-muted/10 lg:border-b-0 lg:border-r">
				<div className="border-b px-4 py-3">
					<div className="font-medium">
						{scanT(t, "scan.candidate.taskLineage", "阶段任务 Lineage")}
					</div>
					<div className="text-sm text-muted-foreground">
						{scanT(
							t,
							"scan.candidate.lineageDescription",
							"从仓库阶段任务到候选点位专属阶段任务。",
						)}
					</div>
				</div>
				<div className="max-h-[65vh] space-y-4 overflow-auto p-3">
					{tasks.length === 0 ? (
						<div className="flex min-h-[280px] flex-col items-center justify-center gap-2 text-muted-foreground">
							<Workflow className="size-6" />
							{scanT(
								t,
								"scan.candidate.noLineageTasks",
								"未找到 lineage 阶段任务",
							)}
						</div>
					) : (
						<>
							{renderTaskGroup(
								scanT(t, "scan.candidate.upstream", "Upstream"),
								upstreamTasks,
							)}
							{renderTaskGroup(
								scanT(t, "scan.candidate.candidateTasks", "候选点位阶段任务"),
								downstreamTasks,
							)}
						</>
					)}
				</div>
			</div>

			<div className="min-w-0">
				<div className="border-b px-4 py-3">
					{selectedTask ? (
						<div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
							<div className="min-w-0">
								<div className="truncate font-medium">{selectedTask.name}</div>
								<div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
									<Badge variant="outline">
										{getTaskStageLabel(t, selectedTask.stageName)}
									</Badge>
									<Badge
										variant="outline"
										className={getTaskStatusBadgeClassName(selectedTask.status)}
									>
										{formatScanStatusLabel(t, selectedTask.status)}
									</Badge>
									<span>{selectedTask.taskId}</span>
								</div>
							</div>
							<Button asChild variant="outline" size="sm">
								<Link href={taskHref(selectedTask.taskId)}>
									<ExternalLink className="mr-2 size-4" />
									{scanT(t, "scan.task.detail", "阶段任务详情")}
								</Link>
							</Button>
						</div>
					) : (
						<div className="text-sm text-muted-foreground">
							{scanT(t, "scan.task.noSelected", "未选择阶段任务")}
						</div>
					)}
				</div>

				{selectedTask ? (
					<div className="p-4">
						<Tabs
							value={taskOutputView}
							onValueChange={(value) =>
								setTaskOutputView(value as "activities" | "text")
							}
						>
							<TabsList>
								<TabsTrigger value="activities">
									<Activity className="mr-2 size-4" />
									{scanT(t, "scan.activity.activities", "Activities")}
								</TabsTrigger>
								<TabsTrigger value="text">
									<FileText className="mr-2 size-4" />
									{scanT(t, "scan.activity.text", "Text")}
								</TabsTrigger>
							</TabsList>

							<TabsContent value="activities" className="pt-4">
								{activityState.errorMessage ? (
									<div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/60 dark:bg-red-950/50 dark:text-red-100">
										{activityState.errorMessage}
									</div>
								) : null}
								{activityState.metadata &&
								activityState.messages.length === 0 ? (
									<div className="mb-3 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
										<div>status: {activityState.metadata.status || "-"}</div>
										<div>
											jsonl:{" "}
											{activityState.metadata.jsonlExists === false
												? "missing"
												: "visible"}
										</div>
										{activityState.metadata.jsonlStatError ? (
											<div className="break-all">
												error: {activityState.metadata.jsonlStatError}
											</div>
										) : null}
									</div>
								) : null}
								<JsonRpcSummaryPanel
									messages={activityState.messages}
									maxHeightClassName="max-h-[58vh]"
									className="min-w-0"
									debugTaskId={selectedTask.taskId}
								/>
							</TabsContent>

							<TabsContent value="text" className="pt-4">
								<div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
									{textState.isConnected ? (
										<span className="flex items-center gap-1">
											<span className="size-1.5 rounded-full bg-emerald-500" />
											{scanT(t, "scan.activity.connected", "connected")}
										</span>
									) : (
										<span className="flex items-center gap-1">
											<Loader2 className="size-3 animate-spin" />
											{scanT(t, "scan.activity.connecting", "connecting")}
										</span>
									)}
									<span>
										{scanT(t, "scan.activity.chars", "{{count}} chars", {
											count: textState.text.length.toLocaleString(),
										})}
									</span>
								</div>
								{textState.errorMessage ? (
									<div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/60 dark:bg-red-950/50 dark:text-red-100">
										{textState.errorMessage}
									</div>
								) : null}
								{textState.metadata && !textState.text ? (
									<div className="mb-3 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
										<div>status: {textState.metadata.status || "-"}</div>
										<div>
											text:{" "}
											{textState.metadata.textExists === false
												? "missing"
												: "visible"}
										</div>
										{textState.metadata.textStatError ? (
											<div className="break-all">
												error: {textState.metadata.textStatError}
											</div>
										) : null}
									</div>
								) : null}
								<pre
									ref={textContainerRef}
									onScroll={(event) => {
										textAutoScrollRef.current = isContainerNearBottom(
											event.currentTarget,
										);
									}}
									className="max-h-[58vh] min-h-[360px] w-full overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-words rounded-md border bg-muted/20 p-3 text-xs leading-relaxed text-foreground"
								>
									{textState.text ||
										scanT(t, "scan.activity.noText", "No text output yet.")}
								</pre>
							</TabsContent>
						</Tabs>
					</div>
				) : (
					<div className="flex min-h-[360px] items-center justify-center text-muted-foreground">
						{scanT(
							t,
							"scan.task.selectToInspect",
							"Select a task to inspect output.",
						)}
					</div>
				)}
			</div>
		</div>
	);
};

export const ShowScanCandidateDetail = ({
	serviceType,
	routeSegment,
}: Props) => {
	const { t } = useTranslation("scan");
	const router = useRouter();
	const utils = api.useUtils();
	const projectId =
		typeof router.query.projectId === "string" ? router.query.projectId : "";
	const environmentId =
		typeof router.query.environmentId === "string"
			? router.query.environmentId
			: "";
	const serviceId =
		typeof router.query.applicationId === "string"
			? router.query.applicationId
			: typeof router.query.composeId === "string"
				? router.query.composeId
				: "";
	const scanJobId =
		typeof router.query.scanJobId === "string" ? router.query.scanJobId : "";
	const candidateId =
		typeof router.query.candidateId === "string"
			? router.query.candidateId
			: "";
	const scanFunctionTaskId =
		typeof router.query.scanFunctionTaskId === "string"
			? router.query.scanFunctionTaskId
			: "";
	const candidateListQueryState = useMemo(
		() => parseCandidateListQueryState(router.query),
		[router.query],
	);
	const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
	const [previewFilePath, setPreviewFilePath] = useState<string | null>(null);
	const [activeTab, setActiveTab] = useState<
		"overview" | "task-lineage" | "files"
	>("overview");
	const [noteDraft, setNoteDraft] = useState("");
	const [selectedTags, setSelectedTags] = useState<string[]>([]);
	const [tagInput, setTagInput] = useState("");
	const metadataSyncKeyRef = useRef("");

	const jobCandidatesHref = buildCandidateListStateHref(
		`/dashboard/project/${projectId}/environment/${environmentId}/${routeSegment}/${serviceType}/${serviceId}/jobs/${scanJobId}`,
		candidateListQueryState,
		"candidates",
	);
	const jobTasksHref = `/dashboard/project/${projectId}/environment/${environmentId}/${routeSegment}/${serviceType}/${serviceId}/jobs/${scanJobId}?tab=tasks`;

	const applicationQuery = api.application.one.useQuery(
		{ applicationId: serviceId },
		{ enabled: serviceType === "application" && !!serviceId },
	);
	const composeQuery = api.compose.one.useQuery(
		{ composeId: serviceId },
		{ enabled: serviceType === "compose" && !!serviceId },
	);
	const serviceData =
		serviceType === "application" ? applicationQuery.data : composeQuery.data;

	const { data: candidate, isLoading: isLoadingCandidate } =
		api.scan.candidate.useQuery(
			{
				vulnerabilityCandidateId: candidateId,
				scanJobId: scanJobId || undefined,
				scanFunctionTaskId: scanFunctionTaskId || undefined,
			},
			{ enabled: !!candidateId && !!scanJobId, refetchInterval: 2000 },
		);
	const { data: fileTree, isLoading: isLoadingFileTree } =
		api.scan.candidateFilesTree.useQuery(
			{
				vulnerabilityCandidateId: candidateId,
				scanJobId: scanJobId || undefined,
			},
			{
				enabled: activeTab === "files" && !!candidateId && !!scanJobId,
				refetchInterval: activeTab === "files" ? 4000 : false,
			},
		);
	const { data: selectedFile, isLoading: isLoadingSelectedFile } =
		api.scan.readCandidateFile.useQuery(
			{
				vulnerabilityCandidateId: candidateId,
				scanJobId: scanJobId || undefined,
				filePath: selectedFilePath || "",
			},
			{
				enabled:
					activeTab === "files" &&
					!!candidateId &&
					!!scanJobId &&
					!!selectedFilePath,
			},
		);
	const { data: previewFile, isLoading: isLoadingPreviewFile } =
		api.scan.readCandidateFile.useQuery(
			{
				vulnerabilityCandidateId: candidateId,
				scanJobId: scanJobId || undefined,
				filePath: previewFilePath || "",
			},
			{ enabled: !!candidateId && !!scanJobId && !!previewFilePath },
		);
	const { data: availableTags = [] } = api.scan.candidateTags.useQuery();
	const analyzeCandidateMutation = api.scan.analyzeCandidate.useMutation();
	const verifyCandidateMutation = api.scan.verifyCandidate.useMutation();
	const updateCandidateMetadataMutation =
		api.scan.updateCandidateMetadata.useMutation();

	useEffect(() => {
		if (!candidate) {
			return;
		}
		const nextMetadataKey = [
			candidate.vulnerabilityCandidateId,
			candidate.note || "",
			...(candidate.tags || []),
		].join("\n");
		if (metadataSyncKeyRef.current === nextMetadataKey) {
			return;
		}
		metadataSyncKeyRef.current = nextMetadataKey;
		setNoteDraft(candidate.note || "");
		setSelectedTags(candidate.tags || []);
		setTagInput("");
	}, [candidate?.note, candidate?.tags, candidate?.vulnerabilityCandidateId]);

	useEffect(() => {
		if (!fileTree?.length) {
			setSelectedFilePath(null);
			return;
		}

		const walk = (items: Array<Record<string, unknown>>): string | null => {
			for (const item of items) {
				if (item.type === "file" && typeof item.id === "string") {
					return item.id;
				}
				if (Array.isArray(item.children)) {
					const next = walk(item.children as Array<Record<string, unknown>>);
					if (next) {
						return next;
					}
				}
			}
			return null;
		};

		setSelectedFilePath(
			(current) => current || walk(fileTree as Array<Record<string, unknown>>),
		);
	}, [fileTree]);

	const verificationTruthBadge = useMemo(
		() =>
			getVerificationTruthBadge(t, candidate?.latestVerificationResult?.result),
		[candidate?.latestVerificationResult?.result, t],
	);
	const candidateStreamStage =
		candidate?.currentStage === "verifying" ? "verifying" : "analyzing";
	const candidateTaskId =
		candidateStreamStage === "verifying"
			? candidate?.latestVerificationResult?.taskId || ""
			: candidate?.latestAnalysisResult?.taskId || "";
	const { messages: liveJsonRpcMessages } = useSandboxAgentSession({
		taskId: candidateTaskId,
		enabled:
			activeTab === "overview" &&
			!!candidateTaskId &&
			candidate?.status === "running",
	});
	const canVerify =
		candidate?.latestAnalysisResult?.result === "real_vulnerability" ||
		candidate?.latestAnalysisResult?.result === "likely_vulnerability";
	const canRerunAnalysis = candidate
		? RERUNNABLE_CANDIDATE_STATUSES.has(candidate.status)
		: false;
	const verifyButtonLabel = candidate?.latestVerificationResult
		? scanT(t, "scan.candidate.reverify", "Reverify")
		: scanT(t, "scan.candidate.verify", "Verify");
	const rerunAnalysisTitle = canRerunAnalysis
		? scanT(t, "scan.candidates.rerunAnalysis", "Re-run analysis")
		: scanT(
				t,
				"scan.candidates.rerunAnalysisDisabled",
				"Analysis can be re-run after the candidate reaches a terminal state",
			);
	const normalizedTagInput = tagInput.trim();
	const candidateMetadataDirty =
		noteDraft !== (candidate?.note || "") ||
		selectedTags.join("\n") !== (candidate?.tags || []).join("\n");
	const candidateTagSuggestions = availableTags.filter(
		(tag) => !selectedTags.includes(tag),
	);
	const addCandidateTag = (tag: string) => {
		const normalized = tag.trim().slice(0, 64);
		if (!normalized || selectedTags.includes(normalized)) {
			return;
		}
		setSelectedTags((current) => [...current, normalized].slice(0, 50));
		setTagInput("");
	};
	const removeCandidateTag = (tag: string) => {
		setSelectedTags((current) => current.filter((value) => value !== tag));
	};
	const saveCandidateMetadata = async () => {
		if (!candidateId || !scanJobId) {
			return;
		}
		await updateCandidateMetadataMutation.mutateAsync({
			vulnerabilityCandidateId: candidateId,
			scanJobId,
			scanFunctionTaskId: scanFunctionTaskId || undefined,
			note: noteDraft,
			tags: selectedTags,
		});
		metadataSyncKeyRef.current = [candidateId, noteDraft, ...selectedTags].join(
			"\n",
		);
		await Promise.all([
			utils.scan.candidate.invalidate({
				vulnerabilityCandidateId: candidateId,
				scanJobId,
				scanFunctionTaskId: scanFunctionTaskId || undefined,
			}),
			utils.scan.candidates.invalidate({ scanJobId }),
			utils.scan.candidateTags.invalidate(),
		]);
	};
	const rerunCandidateAnalysis = async () => {
		if (!candidate || !scanJobId) {
			return;
		}
		try {
			const result = await analyzeCandidateMutation.mutateAsync({
				vulnerabilityCandidateId: candidate.vulnerabilityCandidateId,
				scanJobId,
				scanFunctionTaskId:
					scanFunctionTaskId || candidate.scanFunctionTaskId || undefined,
			});
			toast.success(
				scanT(t, "scan.candidates.analysisRequeued", "Analysis requeued"),
			);
			await Promise.all([
				utils.scan.candidate.invalidate({
					vulnerabilityCandidateId: candidateId,
					scanJobId,
					scanFunctionTaskId: scanFunctionTaskId || undefined,
				}),
				utils.scan.candidates.invalidate({ scanJobId }),
				utils.scan.one.invalidate({ scanJobId }),
				utils.scan.statusView.invalidate({ scanJobId }),
				utils.scan.candidateTaskLineage.invalidate({
					vulnerabilityCandidateId: candidateId,
					scanJobId,
					scanFunctionTaskId: scanFunctionTaskId || undefined,
				}),
			]);
			await router.push(
				`${jobTasksHref}&taskId=${encodeURIComponent(result.taskId)}`,
			);
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: scanT(
							t,
							"scan.candidates.analysisRequeueError",
							"Failed to requeue analysis",
						),
			);
		}
	};
	const renderPathCard = (
		label: string,
		value?: string | null,
		copyLabel?: string,
	) => (
		<div className="rounded-md border p-3 transition-colors hover:border-foreground/20 hover:bg-muted/40">
			<button
				type="button"
				disabled={!value}
				onClick={() => value && setPreviewFilePath(value)}
				className="w-full text-left disabled:cursor-default"
			>
				<div className="text-xs text-muted-foreground">{label}</div>
			</button>
			<div className="mt-1 flex items-start gap-2 break-all text-sm">
				<button
					type="button"
					disabled={!value}
					onClick={() => value && setPreviewFilePath(value)}
					className="min-w-0 flex-1 text-left disabled:cursor-default"
				>
					{value || "-"}
				</button>
				{value ? (
					<CopyValueButton
						value={value}
						label={copyLabel || label}
						className="size-6 shrink-0"
					/>
				) : null}
			</div>
		</div>
	);

	return (
		<div className="pb-10">
			<BreadcrumbSidebar
				list={[
					{ name: scanT(t, "scan.breadcrumb.projects", "Projects"), href: "/dashboard/projects" },
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
						name: scanT(t, "scan.jobs.title", "Jobs"),
						href: `/dashboard/project/${projectId}/environment/${environmentId}/${routeSegment}/${serviceType}/${serviceId}?tab=deployments`,
					},
					{
						name: `Job ${scanJobId.slice(0, 6)}`,
						href: jobCandidatesHref,
					},
					{
						name: scanT(t, "scan.job.tabs.candidates", "Candidates"),
						href: jobCandidatesHref,
					},
					{
						name: scanT(t, "scan.candidate.shortTitle", "Candidate {{id}}", {
							id: candidateId.slice(0, 6),
						}),
					},
				]}
			/>
			<Head>
				<title>
					{scanT(t, "scan.candidate.shortTitle", "Candidate {{id}}", {
						id: candidateId.slice(0, 6),
					})}{" "}
					| Dokploy
				</title>
			</Head>
			<Dialog
				open={!!previewFilePath}
				onOpenChange={(open) => !open && setPreviewFilePath(null)}
			>
				<DialogContent className="max-w-5xl">
					<DialogHeader>
						<DialogTitle>
							{scanT(t, "scan.files.preview", "File Preview")}
						</DialogTitle>
					</DialogHeader>
					<div className="rounded-md border">
						<div className="flex items-start justify-between gap-3 border-b px-4 py-3 text-sm text-muted-foreground">
							<span className="break-all">
								{previewFile?.relativePath ||
									previewFilePath ||
									scanT(t, "scan.files.noFileSelected", "No file selected")}
							</span>
							{previewFile?.content ? (
								<CopyValueButton
									value={previewFile.content}
									label={scanT(t, "scan.files.content", "File Content")}
									className="size-7 shrink-0"
								/>
							) : null}
						</div>
						<div className="max-h-[70vh] overflow-auto px-4 py-3">
							{!previewFilePath ? null : isLoadingPreviewFile ? (
								<div className="flex min-h-[280px] items-center justify-center gap-2 text-muted-foreground">
									<Loader2 className="size-4 animate-spin" />
									{scanT(t, "scan.files.loadingFile", "Loading file...")}
								</div>
							) : (
								<pre className="whitespace-pre-wrap break-words font-mono text-sm">
									{previewFile?.content ||
										scanT(t, "scan.files.emptyFile", "(empty)")}
								</pre>
							)}
						</div>
					</div>
				</DialogContent>
			</Dialog>

			<Card className="bg-background">
				<CardHeader>
					<div className="flex items-start justify-between gap-4">
						<div className="min-w-0">
							<CardTitle className="text-xl">
								{candidate?.title || `Candidate ${candidateId.slice(0, 6)}`}
							</CardTitle>
							<CardDescription className="mt-2 flex items-center gap-2 break-all">
								<span>{candidateId}</span>
								<CopyValueButton
									value={candidateId}
									label={scanT(t, "scan.field.candidateId", "Candidate ID")}
									className="size-7 shrink-0"
								/>
							</CardDescription>
						</div>
						<div className="flex shrink-0 flex-wrap justify-end gap-2">
							<Button
								type="button"
								variant="outline"
								title={rerunAnalysisTitle}
								aria-label={rerunAnalysisTitle}
								isLoading={analyzeCandidateMutation.isLoading}
								disabled={
									!canRerunAnalysis || analyzeCandidateMutation.isLoading
								}
								onClick={rerunCandidateAnalysis}
							>
								<RefreshCw className="mr-2 size-4" />
								{scanT(t, "scan.candidates.rerunAnalysis", "Re-run analysis")}
							</Button>
							{canVerify ? (
								<Button
									type="button"
									className="shrink-0"
									isLoading={verifyCandidateMutation.isLoading}
									disabled={
										verifyCandidateMutation.isLoading ||
										(candidate?.status === "running" &&
											candidate?.currentStage === "verifying")
									}
									onClick={async () => {
										try {
											await verifyCandidateMutation.mutateAsync({
												vulnerabilityCandidateId: candidateId,
											});
											await Promise.all([
												utils.scan.candidate.invalidate({
													vulnerabilityCandidateId: candidateId,
												}),
												utils.scan.candidateFilesTree.invalidate({
													vulnerabilityCandidateId: candidateId,
												}),
											]);
											await router.push(
												`/dashboard/project/${projectId}/environment/${environmentId}/${routeSegment}/${serviceType}/${serviceId}/jobs/${scanJobId}?tab=verify`,
											);
										} catch {}
									}}
								>
									<ShieldCheck className="mr-2 size-4" />
									{verifyButtonLabel}
								</Button>
							) : null}
						</div>
					</div>
				</CardHeader>
				<CardContent>
					<Tabs
						value={activeTab}
						onValueChange={(value) =>
							setActiveTab(value as "overview" | "task-lineage" | "files")
						}
						className="w-full"
					>
						<TabsList className="flex gap-4 justify-start">
							<TabsTrigger value="overview">
								{scanT(t, "scan.job.tabs.overview", "Overview")}
							</TabsTrigger>
							<TabsTrigger value="task-lineage">
								{scanT(t, "scan.candidate.taskLineage", "阶段任务 Lineage")}
							</TabsTrigger>
							<TabsTrigger value="files">
								{scanT(t, "scan.files.title", "Files")}
							</TabsTrigger>
						</TabsList>

						<TabsContent value="overview" className="pt-4">
							{isLoadingCandidate ? (
								<div className="flex items-center gap-2 text-muted-foreground">
									<Loader2 className="size-4 animate-spin" />
									{scanT(t, "scan.candidate.loading", "Loading candidate...")}
								</div>
							) : !candidate ? (
								<div className="flex items-center gap-2 text-muted-foreground">
									<AlertCircle className="size-4" />
									{scanT(t, "scan.candidate.notFound", "Candidate not found")}
								</div>
							) : (
								<div className="grid gap-6">
									<section className="rounded-lg border p-4">
										<div className="mb-4 text-lg font-semibold">
											{scanT(t, "scan.section.general", "General")}
										</div>
										<div className="grid gap-3 md:grid-cols-2">
											<div className="rounded-lg border p-3">
												<div className="text-sm text-muted-foreground">
													{scanT(t, "scan.field.status", "Status")}
												</div>
												<div className="mt-1 font-medium capitalize">
													{formatScanStatusLabel(t, candidate.status)}
												</div>
											</div>
											<div className="rounded-lg border p-3">
												<div className="text-sm text-muted-foreground">
													{scanT(t, "scan.field.currentStage", "Current Stage")}
												</div>
												<div className="mt-1 font-medium capitalize">
													{formatScanStageLabel(t, candidate.currentStage)}
												</div>
											</div>
											<div className="rounded-lg border p-3">
												<div className="text-sm text-muted-foreground">
													{scanT(t, "scan.field.sanityCheck", "Sanity Check")}
												</div>
												<div className="mt-1 font-medium">
													{candidate.latestVerificationResult
														? formatTruthResultLabel(
																t,
																candidate.latestVerificationResult.result,
															)
														: "-"}
												</div>
											</div>
											<div className="rounded-lg border p-3">
												<div className="text-sm text-muted-foreground">
													{scanT(t, "scan.field.location", "Location")}
												</div>
												<div className="mt-1 break-all font-medium">
													{candidate.filePath || "-"}
													{candidate.line ? `:${candidate.line}` : ""}
												</div>
											</div>
											<div className="rounded-lg border p-3">
												<div className="text-sm text-muted-foreground">
													{scanT(t, "scan.field.score", "Score")}
												</div>
												<div className="mt-1 font-medium">
													{typeof candidate.score === "number"
														? candidate.score.toFixed(1)
														: "-"}
												</div>
											</div>
											<div className="rounded-lg border p-3">
												<div className="text-sm text-muted-foreground">
													{scanT(t, "scan.field.confidence", "Confidence")}
												</div>
												<div className="mt-1 font-medium">
													{typeof candidate.confidence === "number"
														? candidate.confidence
														: "-"}
												</div>
											</div>
											<div className="rounded-lg border p-3">
												<div className="text-sm text-muted-foreground">
													{scanT(t, "scan.field.created", "Created")}
												</div>
												<div className="mt-1 font-medium">
													<DateTooltip date={candidate.createdAt} />
												</div>
											</div>
											<div className="rounded-lg border p-3">
												<div className="text-sm text-muted-foreground">
													{scanT(t, "scan.field.updated", "Updated")}
												</div>
												<div className="mt-1 font-medium">
													<DateTooltip date={candidate.updatedAt} />
												</div>
											</div>
										</div>

										<div className="mt-4 rounded-lg border p-3">
											<div className="text-sm text-muted-foreground">
												{scanT(t, "scan.field.description", "Description")}
											</div>
											<div className="mt-1 whitespace-pre-wrap break-words text-sm">
												{candidate.description || "-"}
											</div>
										</div>
									</section>

									<section className="rounded-lg border p-4">
										<div className="mb-4 flex items-center justify-between gap-3">
											<div className="flex items-center gap-2 text-lg font-semibold">
												<Tag className="size-4" />
												{scanT(t, "scan.candidate.userNotes", "User Notes")}
											</div>
											<Button
												type="button"
												size="sm"
												isLoading={updateCandidateMetadataMutation.isLoading}
												disabled={
													updateCandidateMetadataMutation.isLoading ||
													!candidateMetadataDirty
												}
												onClick={saveCandidateMetadata}
											>
												{scanT(t, "scan.dialog.save", "Save")}
											</Button>
										</div>
										<div className="grid gap-4">
											<div className="grid gap-2">
												<div className="text-sm text-muted-foreground">
													{scanT(t, "scan.candidate.note", "Note")}
												</div>
												<Textarea
													value={noteDraft}
													onChange={(event) =>
														setNoteDraft(event.target.value)
													}
													placeholder={scanT(
														t,
														"scan.candidate.notePlaceholder",
														"Add reviewer notes for this candidate.",
													)}
													className="min-h-28"
												/>
											</div>
											<div className="grid gap-2">
												<div className="text-sm text-muted-foreground">
													{scanT(t, "scan.candidate.tags", "Tags")}
												</div>
												<div className="flex flex-wrap gap-2">
													{selectedTags.length > 0 ? (
														selectedTags.map((tag) => (
															<Badge
																key={tag}
																variant="secondary"
																className="gap-1 pr-1"
															>
																<span>{tag}</span>
																<button
																	type="button"
																	className="rounded-sm p-0.5 hover:bg-background/70"
																	onClick={() => removeCandidateTag(tag)}
																	aria-label={scanT(
																		t,
																		"scan.candidate.removeTagAria",
																		"Remove tag {{tag}}",
																		{ tag },
																	)}
																>
																	<X className="size-3" />
																</button>
															</Badge>
														))
													) : (
														<div className="text-sm text-muted-foreground">
															{scanT(t, "scan.candidate.noTags", "No tags set.")}
														</div>
													)}
												</div>
												<div className="flex gap-2">
													<Input
														value={tagInput}
														onChange={(event) =>
															setTagInput(event.target.value)
														}
														maxLength={64}
														onKeyDown={(event) => {
															if (event.key === "Enter") {
																event.preventDefault();
																addCandidateTag(normalizedTagInput);
															}
														}}
														placeholder={scanT(
															t,
															"scan.candidate.tagPlaceholder",
															"Type a new tag",
														)}
													/>
													<Button
														type="button"
														variant="secondary"
														disabled={!normalizedTagInput}
														onClick={() =>
															addCandidateTag(normalizedTagInput)
														}
													>
														<Plus className="mr-2 size-4" />
														{scanT(t, "scan.common.add", "Add")}
													</Button>
												</div>
												{candidateTagSuggestions.length > 0 ? (
													<div className="flex flex-wrap gap-2">
														{candidateTagSuggestions.map((tag) => (
															<button
																key={tag}
																type="button"
																className="rounded-md border px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
																onClick={() => addCandidateTag(tag)}
															>
																{tag}
															</button>
														))}
													</div>
												) : null}
											</div>
										</div>
									</section>

									{candidate.status === "running" ? (
										<section className="rounded-lg border p-4">
											<div className="mb-4 text-lg font-semibold">
												{scanT(t, "scan.candidate.liveOutput", "Live Output")}
											</div>
											<div className="mb-3 flex items-center justify-between gap-3">
												<div className="text-sm text-muted-foreground">
													{scanT(
														t,
														"scan.candidate.liveAgentOutput",
														"Live Agent Output",
													)}
												</div>
												<Badge variant="outline" className="capitalize">
													{formatScanStageLabel(
														t,
														candidate.currentStage || candidateStreamStage,
													)}
												</Badge>
											</div>
											<JsonRpcSummaryPanel
												messages={liveJsonRpcMessages}
												maxHeightClassName="max-h-[420px]"
											/>
										</section>
									) : null}

										<section className="rounded-lg border p-4">
										<div className="mb-4 text-lg font-semibold">
											{scanT(t, "scan.section.analysis", "Analysis")}
										</div>
										<div className="mb-3 flex items-center justify-between gap-3">
											<div className="text-sm text-muted-foreground">
												{scanT(
													t,
													"scan.candidate.latestAnalysis",
													"Latest Analysis Result",
												)}
											</div>
											{candidate.latestAnalysisResult?.result ? (
												<Badge
													variant="outline"
													className={`capitalize ${getAnalysisResultBadgeClassName(candidate.latestAnalysisResult.result)}`}
												>
													{formatAnalysisResultLabel(
														t,
														candidate.latestAnalysisResult.result,
													)}
												</Badge>
											) : null}
										</div>
										<div className="grid gap-3 md:grid-cols-2">
											<div className="rounded-md border p-3">
												<div className="text-xs text-muted-foreground">
													{scanT(t, "scan.field.summary", "Summary")}
												</div>
												<div className="mt-1 whitespace-pre-wrap break-words text-sm">
													{candidate.latestAnalysisResult?.summary || "-"}
												</div>
											</div>
											{renderPathCard(
												scanT(t, "scan.field.reportPath", "Report Path"),
												candidate.latestAnalysisResult?.reportPath,
												scanT(
													t,
													"scan.field.analysisReportPath",
													"Analysis Report Path",
												),
											)}
											<div className="rounded-md border p-3">
												<div className="text-xs text-muted-foreground">
													{scanT(t, "scan.field.score", "Score")}
												</div>
												<div className="mt-1 text-sm">
													{typeof candidate.latestAnalysisResult?.score ===
													"number"
														? candidate.latestAnalysisResult.score.toFixed(1)
														: "-"}
												</div>
											</div>
											<div className="rounded-md border p-3">
												<div className="text-xs text-muted-foreground">
													{scanT(t, "scan.field.confidence", "Confidence")}
												</div>
												<div className="mt-1 text-sm">
													{typeof candidate.latestAnalysisResult?.confidence ===
													"number"
														? candidate.latestAnalysisResult.confidence
														: "-"}
												</div>
											</div>
											<div className="rounded-md border p-3">
												<div className="text-xs text-muted-foreground">
													{scanT(t, "scan.field.runtimeSeconds", "Runtime Seconds")}
												</div>
												<div className="mt-1 text-sm">
													{candidate.latestAnalysisResult?.runtimeSeconds ??
														"-"}
												</div>
											</div>
											<div className="rounded-md border p-3">
												<div className="text-xs text-muted-foreground">
													{scanT(t, "scan.field.threadId", "Thread ID")}
												</div>
												<div className="mt-1 flex items-center gap-2 break-all text-sm">
													<span>
														{candidate.latestAnalysisResult?.threadId || "-"}
													</span>
													{candidate.latestAnalysisResult?.threadId ? (
														<CopyValueButton
															value={candidate.latestAnalysisResult.threadId}
															label={scanT(
																t,
																"scan.field.analysisThreadId",
																"Analysis Thread ID",
															)}
															className="size-6 shrink-0"
														/>
													) : null}
												</div>
											</div>
										</div>
									</section>

									<section className="rounded-lg border p-4">
										<div className="mb-4 text-lg font-semibold">
											{scanT(t, "scan.section.verify", "Verify")}
										</div>
										<div className="mb-3 flex items-center justify-between gap-3">
											<div className="text-sm text-muted-foreground">
												{scanT(
													t,
													"scan.candidate.latestVerification",
													"Latest Verification Result",
												)}
											</div>
											{verificationTruthBadge ? (
												<Badge
													variant="outline"
													className={verificationTruthBadge.className}
												>
													{verificationTruthBadge.label}
												</Badge>
											) : null}
										</div>
										<div className="grid gap-3 md:grid-cols-2">
											<div className="rounded-md border p-3">
												<div className="text-xs text-muted-foreground">
													{scanT(t, "scan.field.result", "Result")}
												</div>
												<div className="mt-1 text-sm">
													{candidate.latestVerificationResult?.result
														? formatTruthResultLabel(
																t,
																candidate.latestVerificationResult.result,
															)
														: "-"}
												</div>
											</div>
											<div className="rounded-md border p-3">
												<div className="text-xs text-muted-foreground">
													{scanT(t, "scan.field.score", "Score")}
												</div>
												<div className="mt-1 text-sm">
													{typeof candidate.latestVerificationResult?.score ===
													"number"
														? candidate.latestVerificationResult.score.toFixed(
																1,
															)
														: "-"}
												</div>
											</div>
											<div className="rounded-md border p-3">
												<div className="text-xs text-muted-foreground">
													{scanT(t, "scan.field.confidence", "Confidence")}
												</div>
												<div className="mt-1 text-sm">
													{typeof candidate.latestVerificationResult
														?.confidence === "number"
														? candidate.latestVerificationResult.confidence
														: "-"}
												</div>
											</div>
											{renderPathCard(
												scanT(t, "scan.field.reportPath", "Report Path"),
												candidate.latestVerificationResult?.reportPath,
												scanT(
													t,
													"scan.field.verificationReportPath",
													"Verification Report Path",
												),
											)}
										</div>
									</section>

									<section className="rounded-lg border p-4">
										<div className="mb-4 text-lg font-semibold">
											{scanT(t, "scan.section.triage", "Triage")}
										</div>
										<div className="mb-3 text-sm text-muted-foreground">
											{scanT(t, "scan.candidate.latestTriage", "Latest Triage")}
										</div>
										<div className="grid gap-3 md:grid-cols-2">
											<div className="rounded-md border p-3">
												<div className="text-xs text-muted-foreground">
													{scanT(t, "scan.field.classification", "Classification")}
												</div>
												<div className="mt-1 text-sm">
													{candidate.latestTriageResult
														?.securityClassification || "-"}
												</div>
											</div>
											<div className="rounded-md border p-3">
												<div className="text-xs text-muted-foreground">
													{scanT(t, "scan.field.securityIssue", "Security Issue")}
												</div>
												<div className="mt-1 text-sm">
													{typeof candidate.latestTriageResult
														?.isSecurityIssue === "boolean"
															? candidate.latestTriageResult
																.isSecurityIssue
															? scanT(t, "scan.common.yes", "Yes")
															: scanT(t, "scan.common.no", "No")
														: "-"}
												</div>
											</div>
											<div className="rounded-md border p-3">
												<div className="text-xs text-muted-foreground">
													{scanT(t, "scan.field.disqualifier", "Disqualifier")}
												</div>
												<div className="mt-1 text-sm">
													{candidate.latestTriageResult?.disqualifier || "-"}
												</div>
											</div>
											<div className="rounded-md border p-3">
												<div className="text-xs text-muted-foreground">
													{scanT(t, "scan.field.impact", "Impact")}
												</div>
												<div className="mt-1 text-sm">
													{candidate.latestTriageResult?.impactType || "-"}
												</div>
											</div>
											<div className="rounded-md border p-3 md:col-span-2">
												<div className="text-xs text-muted-foreground">
													{scanT(
														t,
														"scan.field.disqualifierReason",
														"Disqualifier Reason",
													)}
												</div>
												<div className="mt-1 whitespace-pre-wrap break-words text-sm">
													{candidate.latestTriageResult
														?.disqualifierReason || "-"}
												</div>
											</div>
											<div className="rounded-md border p-3">
												<div className="text-xs text-muted-foreground">
													CVSS
												</div>
												<div className="mt-1 text-sm">
													{candidate.latestTriageResult?.cvssSeverity || "-"}
													{typeof candidate.latestTriageResult
														?.cvssScore === "number"
														? ` ${candidate.latestTriageResult.cvssScore.toFixed(1)}`
														: ""}
												</div>
											</div>
											<div className="rounded-md border p-3">
												<div className="text-xs text-muted-foreground">
													EPSS 30d
												</div>
												<div className="mt-1 text-sm">
													{typeof candidate.latestTriageResult
														?.epssProbability30d === "number"
														? `${(candidate.latestTriageResult.epssProbability30d * 100).toFixed(2)}%`
														: "-"}
												</div>
											</div>
											{renderPathCard(
												scanT(t, "scan.field.reportPath", "Report Path"),
												candidate.latestTriageResult?.reportPath,
												scanT(
													t,
													"scan.field.triageReportPath",
													"Triage Report Path",
												),
											)}
										</div>
									</section>
								</div>
							)}
						</TabsContent>

						<TabsContent value="task-lineage" className="pt-4">
							<CandidateTaskLineagePanel
								candidateId={candidateId}
								projectId={projectId}
								environmentId={environmentId}
								serviceType={serviceType}
								routeSegment={routeSegment}
								serviceId={serviceId}
								scanJobId={scanJobId}
								scanFunctionTaskId={scanFunctionTaskId || undefined}
								enabled={activeTab === "task-lineage"}
							/>
						</TabsContent>

						<TabsContent value="files" className="pt-4">
							<div className="rounded-lg border">
								<div className="border-b px-4 py-3">
									<div className="font-medium">
										{scanT(t, "scan.files.title", "Files")}
									</div>
										<div className="text-sm text-muted-foreground">
											{scanT(
												t,
												"scan.files.candidateDescription",
												"Browse candidate context files.",
											)}
									</div>
								</div>
								<div className="grid min-h-[65vh] grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)]">
									<div className="border-b lg:border-b-0 lg:border-r">
										{isLoadingFileTree ? (
											<div className="flex h-full min-h-[320px] items-center justify-center gap-2 text-muted-foreground">
												<Loader2 className="size-4 animate-spin" />
												{scanT(t, "scan.files.loading", "Loading files...")}
											</div>
										) : !fileTree || fileTree.length === 0 ? (
											<div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-2 text-muted-foreground">
												<Folder className="size-6" />
												{scanT(t, "scan.files.empty", "No files available")}
											</div>
										) : (
											<Tree
												data={fileTree}
												className="h-[65vh] w-full rounded-none border-0"
												onSelectChange={(item) =>
													setSelectedFilePath(item?.id || null)
												}
												folderIcon={Folder}
												itemIcon={Workflow}
											/>
										)}
									</div>
									<div className="min-w-0">
										<div className="border-b px-4 py-3">
											<div className="flex items-center justify-between gap-3">
												<div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
													<FileIcon className="size-4 shrink-0" />
													<span className="truncate">
														{selectedFile?.relativePath ||
															selectedFilePath ||
															scanT(
																t,
																"scan.files.noFileSelected",
																"No file selected",
															)}
													</span>
												</div>
												{selectedFile?.content ? (
													<CopyValueButton
														value={selectedFile.content}
														label={scanT(t, "scan.files.content", "File Content")}
														className="size-7 shrink-0"
													/>
												) : null}
											</div>
										</div>
										<div className="max-h-[calc(65vh-49px)] overflow-auto px-4 py-3">
											{!selectedFilePath ? (
												<div className="flex min-h-[280px] flex-col items-center justify-center gap-2 text-muted-foreground">
													<FileIcon className="size-6" />
													{scanT(
														t,
														"scan.files.noFileSelected",
														"No file selected",
													)}
												</div>
											) : isLoadingSelectedFile ? (
												<div className="flex min-h-[280px] items-center justify-center gap-2 text-muted-foreground">
													<Loader2 className="size-4 animate-spin" />
													{scanT(t, "scan.files.loadingFile", "Loading file...")}
												</div>
											) : (
												<pre className="whitespace-pre-wrap break-words font-mono text-sm">
													{selectedFile?.content ||
														scanT(t, "scan.files.emptyFile", "(empty)")}
												</pre>
											)}
										</div>
									</div>
								</div>
							</div>
						</TabsContent>
					</Tabs>
					<div className="pt-6">
						<Link
							className="text-sm text-muted-foreground underline"
							href={`/dashboard/project/${projectId}/environment/${environmentId}/${routeSegment}/${serviceType}/${serviceId}/jobs/${scanJobId}`}
						>
							Back to Job
						</Link>
					</div>
				</CardContent>
			</Card>
		</div>
	);
};
