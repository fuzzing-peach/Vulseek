import {
	Activity,
	AlertCircle,
	ExternalLink,
	FileIcon,
	FileText,
	Folder,
	Loader2,
	ShieldCheck,
	Workflow,
} from "lucide-react";
import Head from "next/head";
import Link from "next/link";
import { useRouter } from "next/router";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { api } from "@/utils/api";

interface Props {
	serviceType: "application" | "compose";
	routeSegment: "profiles" | "services";
}

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
	result?: string | null,
): { label: string; className: string } | null => {
	if (!result) {
		return null;
	}

	if (result === "true") {
		return {
			label: "Facts True",
			className:
				"border-emerald-200 bg-emerald-100 text-emerald-700 dark:border-emerald-500/60 dark:bg-emerald-950/50 dark:text-emerald-100",
		};
	}

	if (result === "likely") {
		return {
			label: "Facts Likely",
			className:
				"border-amber-200 bg-amber-100 text-amber-700 dark:border-amber-500/60 dark:bg-amber-950/50 dark:text-amber-100",
		};
	}

	return {
		label: "Facts False",
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

const getTaskStageLabel = (stage?: string | null) => {
	if (stage === "repository-scan") {
		return "Repository";
	}
	if (stage === "module-scan") {
		return "Module";
	}
	if (stage === "function-scan") {
		return "Function";
	}
	if (stage === "analyze") {
		return "Analyze";
	}
	if (stage === "criticize") {
		return "Criticize";
	}
	if (stage === "build-fuzzer") {
		return "Build Fuzzer";
	}
	if (stage === "run-fuzzer") {
		return "Run Fuzzer";
	}
	if (stage === "verify") {
		return "Verify";
	}
	if (stage === "triage") {
		return "Triage";
	}
	return stage || "-";
};

const getTaskStatusBadgeClassName = (status?: string | null) => {
	if (status === "completed") {
		return "border-emerald-200 bg-emerald-100 text-emerald-700 dark:border-emerald-500/60 dark:bg-emerald-950/50 dark:text-emerald-100";
	}
	if (status === "failed") {
		return "border-red-200 bg-red-100 text-red-700 dark:border-red-500/60 dark:bg-red-950/50 dark:text-red-100";
	}
	if (status === "running" || status === "launching") {
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
	enabled,
}: {
	candidateId: string;
	projectId: string;
	environmentId: string;
	serviceType: "application" | "compose";
	routeSegment: "profiles" | "services";
	serviceId: string;
	scanJobId: string;
	enabled: boolean;
}) => {
	const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
	const [taskOutputView, setTaskOutputView] = useState<"activities" | "text">(
		"activities",
	);
	const textContainerRef = useRef<HTMLPreElement | null>(null);
	const textAutoScrollRef = useRef(true);
	const { data, isLoading, isError, error } =
		api.scan.candidateTaskLineage.useQuery(
			{ vulnerabilityCandidateId: candidateId, scanJobId },
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
					No tasks.
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
										{getTaskStageLabel(task.stageName)}
									</Badge>
									<Badge
										variant="outline"
										className={getTaskStatusBadgeClassName(task.status)}
									>
										{task.status}
									</Badge>
								</div>
							</div>
						</button>
						<Button
							asChild
							variant="ghost"
							size="icon"
							className="size-8 shrink-0"
							title="Open task detail"
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
				Loading task lineage...
			</div>
		);
	}

	if (isError) {
		return (
			<div className="flex items-center gap-2 text-muted-foreground">
				<AlertCircle className="size-4" />
				{error?.message || "Unable to load task lineage"}
			</div>
		);
	}

	return (
		<div className="grid min-h-[65vh] grid-cols-1 overflow-hidden rounded-lg border lg:grid-cols-[360px_minmax(0,1fr)]">
			<div className="border-b bg-muted/10 lg:border-b-0 lg:border-r">
				<div className="border-b px-4 py-3">
					<div className="font-medium">Task Lineage</div>
					<div className="text-sm text-muted-foreground">
						Repository to candidate-specific tasks.
					</div>
				</div>
				<div className="max-h-[65vh] space-y-4 overflow-auto p-3">
					{tasks.length === 0 ? (
						<div className="flex min-h-[280px] flex-col items-center justify-center gap-2 text-muted-foreground">
							<Workflow className="size-6" />
							No lineage tasks found
						</div>
					) : (
						<>
							{renderTaskGroup("Upstream", upstreamTasks)}
							{renderTaskGroup("Candidate Tasks", downstreamTasks)}
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
										{getTaskStageLabel(selectedTask.stageName)}
									</Badge>
									<Badge
										variant="outline"
										className={getTaskStatusBadgeClassName(selectedTask.status)}
									>
										{selectedTask.status}
									</Badge>
									<span>{selectedTask.taskId}</span>
								</div>
							</div>
							<Button asChild variant="outline" size="sm">
								<Link href={taskHref(selectedTask.taskId)}>
									<ExternalLink className="mr-2 size-4" />
									Task Detail
								</Link>
							</Button>
						</div>
					) : (
						<div className="text-sm text-muted-foreground">
							No task selected
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
									Activities
								</TabsTrigger>
								<TabsTrigger value="text">
									<FileText className="mr-2 size-4" />
									Text
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
											connected
										</span>
									) : (
										<span className="flex items-center gap-1">
											<Loader2 className="size-3 animate-spin" />
											connecting
										</span>
									)}
									<span>{textState.text.length.toLocaleString()} chars</span>
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
									{textState.text || "No text output yet."}
								</pre>
							</TabsContent>
						</Tabs>
					</div>
				) : (
					<div className="flex min-h-[360px] items-center justify-center text-muted-foreground">
						Select a task to inspect output.
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
	const candidateListQueryState = useMemo(
		() => parseCandidateListQueryState(router.query),
		[router.query],
	);
	const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
	const [previewFilePath, setPreviewFilePath] = useState<string | null>(null);
	const [activeTab, setActiveTab] = useState<
		"overview" | "task-lineage" | "files"
	>("overview");

	const jobCandidatesHref = buildCandidateListStateHref(
		`/dashboard/project/${projectId}/environment/${environmentId}/${routeSegment}/${serviceType}/${serviceId}/jobs/${scanJobId}`,
		candidateListQueryState,
		"candidates",
	);

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
	const verifyCandidateMutation = api.scan.verifyCandidate.useMutation();

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
			getVerificationTruthBadge(candidate?.latestVerificationResult?.result),
		[candidate?.latestVerificationResult?.result],
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
	const verifyButtonLabel = candidate?.latestVerificationResult
		? "Reverify"
		: "Verify";
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
						href: jobCandidatesHref,
					},
					{
						name: "Candidates",
						href: jobCandidatesHref,
					},
					{ name: `Candidate ${candidateId.slice(0, 6)}` },
				]}
			/>
			<Head>
				<title>Candidate {candidateId.slice(0, 6)} | Dokploy</title>
			</Head>
			<Dialog
				open={!!previewFilePath}
				onOpenChange={(open) => !open && setPreviewFilePath(null)}
			>
				<DialogContent className="max-w-5xl">
					<DialogHeader>
						<DialogTitle>File Preview</DialogTitle>
					</DialogHeader>
					<div className="rounded-md border">
						<div className="flex items-start justify-between gap-3 border-b px-4 py-3 text-sm text-muted-foreground">
							<span className="break-all">
								{previewFile?.relativePath ||
									previewFilePath ||
									"No file selected"}
							</span>
							{previewFile?.content ? (
								<CopyValueButton
									value={previewFile.content}
									label="File Content"
									className="size-7 shrink-0"
								/>
							) : null}
						</div>
						<div className="max-h-[70vh] overflow-auto px-4 py-3">
							{!previewFilePath ? null : isLoadingPreviewFile ? (
								<div className="flex min-h-[280px] items-center justify-center gap-2 text-muted-foreground">
									<Loader2 className="size-4 animate-spin" />
									Loading file...
								</div>
							) : (
								<pre className="whitespace-pre-wrap break-words font-mono text-sm">
									{previewFile?.content || "(empty)"}
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
									label="Candidate ID"
									className="size-7 shrink-0"
								/>
							</CardDescription>
						</div>
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
							<TabsTrigger value="overview">Overview</TabsTrigger>
							<TabsTrigger value="task-lineage">Task Lineage</TabsTrigger>
							<TabsTrigger value="files">Files</TabsTrigger>
						</TabsList>

						<TabsContent value="overview" className="pt-4">
							{isLoadingCandidate ? (
								<div className="flex items-center gap-2 text-muted-foreground">
									<Loader2 className="size-4 animate-spin" />
									Loading candidate...
								</div>
							) : !candidate ? (
								<div className="flex items-center gap-2 text-muted-foreground">
									<AlertCircle className="size-4" />
									Candidate not found
								</div>
							) : (
								<div className="grid gap-6">
									<section className="rounded-lg border p-4">
										<div className="mb-4 text-lg font-semibold">General</div>
										<div className="grid gap-3 md:grid-cols-2">
											<div className="rounded-lg border p-3">
												<div className="text-sm text-muted-foreground">
													Status
												</div>
												<div className="mt-1 font-medium capitalize">
													{candidate.status}
												</div>
											</div>
											<div className="rounded-lg border p-3">
												<div className="text-sm text-muted-foreground">
													Current Stage
												</div>
												<div className="mt-1 font-medium capitalize">
													{candidate.currentStage}
												</div>
											</div>
											<div className="rounded-lg border p-3">
												<div className="text-sm text-muted-foreground">
													Sanity Check
												</div>
												<div className="mt-1 font-medium">
													{candidate.latestVerificationResult
														? candidate.latestVerificationResult.result
														: "-"}
												</div>
											</div>
											<div className="rounded-lg border p-3">
												<div className="text-sm text-muted-foreground">
													Location
												</div>
												<div className="mt-1 break-all font-medium">
													{candidate.filePath || "-"}
													{candidate.line ? `:${candidate.line}` : ""}
												</div>
											</div>
											<div className="rounded-lg border p-3">
												<div className="text-sm text-muted-foreground">
													Score
												</div>
												<div className="mt-1 font-medium">
													{typeof candidate.score === "number"
														? candidate.score.toFixed(1)
														: "-"}
												</div>
											</div>
											<div className="rounded-lg border p-3">
												<div className="text-sm text-muted-foreground">
													Confidence
												</div>
												<div className="mt-1 font-medium">
													{typeof candidate.confidence === "number"
														? candidate.confidence
														: "-"}
												</div>
											</div>
											<div className="rounded-lg border p-3">
												<div className="text-sm text-muted-foreground">
													Created
												</div>
												<div className="mt-1 font-medium">
													<DateTooltip date={candidate.createdAt} />
												</div>
											</div>
											<div className="rounded-lg border p-3">
												<div className="text-sm text-muted-foreground">
													Updated
												</div>
												<div className="mt-1 font-medium">
													<DateTooltip date={candidate.updatedAt} />
												</div>
											</div>
										</div>

										<div className="rounded-lg border p-3">
											<div className="text-sm text-muted-foreground">
												Description
											</div>
											<div className="mt-1 whitespace-pre-wrap break-words text-sm">
												{candidate.description || "-"}
											</div>
										</div>
									</section>

									{candidate.status === "running" ? (
										<section className="rounded-lg border p-4">
											<div className="mb-4 text-lg font-semibold">
												Live Output
											</div>
											<div className="mb-3 flex items-center justify-between gap-3">
												<div className="text-sm text-muted-foreground">
													Live Agent Output
												</div>
												<Badge variant="outline" className="capitalize">
													{candidate.currentStage || candidateStreamStage}
												</Badge>
											</div>
											<JsonRpcSummaryPanel
												messages={liveJsonRpcMessages}
												maxHeightClassName="max-h-[420px]"
											/>
										</section>
									) : null}

									<section className="rounded-lg border p-4">
										<div className="mb-4 text-lg font-semibold">Analysis</div>
										<div className="mb-3 flex items-center justify-between gap-3">
											<div className="text-sm text-muted-foreground">
												Latest Analysis Result
											</div>
											{candidate.latestAnalysisResult?.result ? (
												<Badge
													variant="outline"
													className={`capitalize ${getAnalysisResultBadgeClassName(candidate.latestAnalysisResult.result)}`}
												>
													{candidate.latestAnalysisResult.result.replace(
														/_/g,
														" ",
													)}
												</Badge>
											) : null}
										</div>
										<div className="grid gap-3 md:grid-cols-2">
											<div className="rounded-md border p-3">
												<div className="text-xs text-muted-foreground">
													Summary
												</div>
												<div className="mt-1 whitespace-pre-wrap break-words text-sm">
													{candidate.latestAnalysisResult?.summary || "-"}
												</div>
											</div>
											{renderPathCard(
												"Report Path",
												candidate.latestAnalysisResult?.reportPath,
												"Analysis Report Path",
											)}
											<div className="rounded-md border p-3">
												<div className="text-xs text-muted-foreground">
													Score
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
													Confidence
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
													Runtime Seconds
												</div>
												<div className="mt-1 text-sm">
													{candidate.latestAnalysisResult?.runtimeSeconds ??
														"-"}
												</div>
											</div>
											<div className="rounded-md border p-3">
												<div className="text-xs text-muted-foreground">
													Thread ID
												</div>
												<div className="mt-1 flex items-center gap-2 break-all text-sm">
													<span>
														{candidate.latestAnalysisResult?.threadId || "-"}
													</span>
													{candidate.latestAnalysisResult?.threadId ? (
														<CopyValueButton
															value={candidate.latestAnalysisResult.threadId}
															label="Analysis Thread ID"
															className="size-6 shrink-0"
														/>
													) : null}
												</div>
											</div>
										</div>
									</section>

									<section className="rounded-lg border p-4">
										<div className="mb-4 text-lg font-semibold">Verify</div>
										<div className="mb-3 flex items-center justify-between gap-3">
											<div className="text-sm text-muted-foreground">
												Latest Verification Result
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
													Result
												</div>
												<div className="mt-1 text-sm">
													{candidate.latestVerificationResult?.result || "-"}
												</div>
											</div>
											<div className="rounded-md border p-3">
												<div className="text-xs text-muted-foreground">
													Score
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
													Confidence
												</div>
												<div className="mt-1 text-sm">
													{typeof candidate.latestVerificationResult
														?.confidence === "number"
														? candidate.latestVerificationResult.confidence
														: "-"}
												</div>
											</div>
											{renderPathCard(
												"Report Path",
												candidate.latestVerificationResult?.reportPath,
												"Verification Report Path",
											)}
										</div>
									</section>

									<section className="rounded-lg border p-4">
										<div className="mb-4 text-lg font-semibold">Triage</div>
										<div className="mb-3 text-sm text-muted-foreground">
											Latest Triage
										</div>
										<div className="grid gap-3 md:grid-cols-2">
											<div className="rounded-md border p-3">
												<div className="text-xs text-muted-foreground">
													Classification
												</div>
												<div className="mt-1 text-sm">
													{candidate.latestTriageResult
														?.securityClassification || "-"}
												</div>
											</div>
											<div className="rounded-md border p-3">
												<div className="text-xs text-muted-foreground">
													Security Issue
												</div>
												<div className="mt-1 text-sm">
													{typeof candidate.latestTriageResult
														?.isSecurityIssue === "boolean"
														? candidate.latestTriageResult
																.isSecurityIssue
															? "Yes"
															: "No"
														: "-"}
												</div>
											</div>
											<div className="rounded-md border p-3">
												<div className="text-xs text-muted-foreground">
													Impact
												</div>
												<div className="mt-1 text-sm">
													{candidate.latestTriageResult?.impactType || "-"}
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
												"Report Path",
												candidate.latestTriageResult?.reportPath,
												"Triage Report Path",
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
								enabled={activeTab === "task-lineage"}
							/>
						</TabsContent>

						<TabsContent value="files" className="pt-4">
							<div className="rounded-lg border">
								<div className="border-b px-4 py-3">
									<div className="font-medium">Files</div>
									<div className="text-sm text-muted-foreground">
										Browse candidate context files.
									</div>
								</div>
								<div className="grid min-h-[65vh] grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)]">
									<div className="border-b lg:border-b-0 lg:border-r">
										{isLoadingFileTree ? (
											<div className="flex h-full min-h-[320px] items-center justify-center gap-2 text-muted-foreground">
												<Loader2 className="size-4 animate-spin" />
												Loading files...
											</div>
										) : !fileTree || fileTree.length === 0 ? (
											<div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-2 text-muted-foreground">
												<Folder className="size-6" />
												No files available
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
															"No file selected"}
													</span>
												</div>
												{selectedFile?.content ? (
													<CopyValueButton
														value={selectedFile.content}
														label="File Content"
														className="size-7 shrink-0"
													/>
												) : null}
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
