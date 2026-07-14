import { Activity, FileText, Loader2 } from "lucide-react";
import { useTranslation } from "next-i18next";
import { useEffect, useRef, useState } from "react";
import { JsonRpcSummaryPanel } from "@/components/dashboard/scanning/jsonrpc-summary";
import { useSandboxAgentActivity } from "@/components/dashboard/scanning/use-sandbox-agent-activity";
import { useSandboxAgentSession } from "@/components/dashboard/scanning/use-sandbox-agent-session";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import type { SandboxAgentActivity } from "@/lib/scan/sandbox-agent-activity";
import { scanT } from "./scan-i18n";

const getActivityBadgeClassName = (kind: string) => {
	if (kind === "web") {
		return "border-sky-200 bg-sky-100 text-sky-700 dark:border-sky-500/60 dark:bg-sky-950/50 dark:text-sky-100";
	}
	if (kind === "tool" || kind === "command" || kind === "completed") {
		return "border-emerald-200 bg-emerald-100 text-emerald-700 dark:border-emerald-500/60 dark:bg-emerald-950/50 dark:text-emerald-100";
	}
	if (kind === "usage" || kind === "result") {
		return "border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-500/60 dark:bg-slate-900/70 dark:text-slate-100";
	}
	if (kind === "reasoning" || kind === "planning") {
		return "border-amber-200 bg-amber-100 text-amber-700 dark:border-amber-500/60 dark:bg-amber-950/50 dark:text-amber-100";
	}
	if (kind === "writing") {
		return "border-violet-200 bg-violet-100 text-violet-700 dark:border-violet-500/60 dark:bg-violet-950/50 dark:text-violet-100";
	}
	if (kind === "error") {
		return "border-red-200 bg-red-100 text-red-700 dark:border-red-500/60 dark:bg-red-950/50 dark:text-red-100";
	}
	return "border-muted-foreground/20 bg-muted text-muted-foreground";
};

const formatTokenUsage = (value: number) => {
	if (value >= 1_000_000) {
		return `${(value / 1_000_000).toFixed(1)}M`;
	}
	if (value >= 1_000) {
		return `${(value / 1_000).toFixed(1)}k`;
	}
	return String(value);
};

const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 16;

const isContainerNearBottom = (container: HTMLElement) =>
	container.scrollHeight - container.scrollTop - container.clientHeight <=
	AUTO_SCROLL_BOTTOM_THRESHOLD_PX;

const scrollContainerToBottom = (container: HTMLElement) => {
	container.scrollTop = container.scrollHeight;
};

type SandboxAgentTextMetadata = {
	taskId: string;
	scanJobId: string;
	taskKind: string;
	containerName?: string | null;
	baseUrl?: string | null;
	provider?: "codex" | "claude";
	status?: string;
	textPath?: string;
	textExists?: boolean;
	textStatError?: string | null;
};

export const useSandboxAgentText = ({
	taskId,
	enabled,
}: {
	taskId: string;
	enabled: boolean;
}) => {
	const [state, setState] = useState<{
		text: string;
		isConnected: boolean;
		metadata: SandboxAgentTextMetadata | null;
		errorMessage: string | null;
	}>({
		text: "",
		isConnected: false,
		metadata: null,
		errorMessage: null,
	});

	useEffect(() => {
		if (!enabled || !taskId || typeof window === "undefined") {
			return;
		}

		setState({
			text: "",
			isConnected: false,
			metadata: null,
			errorMessage: null,
		});

		const eventSource = new EventSource(
			`/api/scan/tasks/${encodeURIComponent(taskId)}/sandbox-agent-text`,
		);
		eventSource.onopen = () => {
			setState((current) => ({ ...current, isConnected: true }));
		};
		eventSource.addEventListener("snapshot", (event) => {
			const payload = JSON.parse((event as MessageEvent).data) as {
				metadata?: SandboxAgentTextMetadata;
				text?: string;
			};
			setState({
				text: payload.text || "",
				isConnected: true,
				metadata: payload.metadata || null,
				errorMessage: null,
			});
		});
		eventSource.addEventListener("append", (event) => {
			const payload = JSON.parse((event as MessageEvent).data) as {
				text?: string;
			};
			setState((current) => ({
				...current,
				text: current.text + (payload.text || ""),
				isConnected: true,
				errorMessage: null,
			}));
		});
		eventSource.addEventListener("stream_error", (event) => {
			const payload = JSON.parse((event as MessageEvent).data) as {
				message?: string;
			};
			setState((current) => ({
				...current,
				isConnected: false,
				errorMessage: payload.message || "Sandbox agent text stream error",
			}));
		});
		eventSource.addEventListener("done", () => {
			setState((current) => ({ ...current, isConnected: false }));
			eventSource.close();
		});
		eventSource.onerror = () => {
			setState((current) => ({
				...current,
				isConnected: false,
				errorMessage:
					current.errorMessage || "Sandbox agent text stream disconnected",
			}));
		};

		return () => {
			eventSource.close();
		};
	}, [enabled, taskId]);

	return state;
};

export const LiveTaskActivity = ({
	taskId,
	title,
	subtitle,
	activity,
	isConnected,
	viewButtonVariant = "secondary",
	viewButtonSize = "sm",
	iconOnlyViewButton = false,
}: {
	taskId: string;
	title: string;
	subtitle?: string | null;
	activity?: SandboxAgentActivity;
	isConnected?: boolean;
	viewButtonVariant?: "default" | "secondary" | "outline" | "ghost";
	viewButtonSize?: "default" | "sm" | "lg" | "icon";
	iconOnlyViewButton?: boolean;
}) => {
	const liveActivity = useSandboxAgentActivity({
		taskId,
		enabled: !!taskId && !activity,
	});
	const resolvedActivity = activity || liveActivity.activity;
	const resolvedIsConnected = isConnected ?? liveActivity.isConnected;

	return (
		<div className="flex min-w-0 items-start justify-between gap-3">
			<LiveTaskActivityBadge
				activity={resolvedActivity}
				isConnected={resolvedIsConnected}
			/>
			<LiveTaskActivityButton
				taskId={taskId}
				title={title}
				subtitle={subtitle}
				activity={resolvedActivity}
				variant={viewButtonVariant}
				size={viewButtonSize}
				iconOnly={iconOnlyViewButton}
			/>
		</div>
	);
};

export const LiveTaskActivityBadge = ({
	taskId,
	activity,
	isConnected,
	noWrap = false,
}: {
	taskId?: string;
	activity?: SandboxAgentActivity;
	isConnected?: boolean;
	noWrap?: boolean;
}) => {
	const { t } = useTranslation("scan");
	const liveActivity = useSandboxAgentActivity({
		taskId: taskId || "",
		enabled: !!taskId && !activity,
	});
	const resolvedActivity = activity || liveActivity.activity;
	const resolvedIsConnected = isConnected ?? liveActivity.isConnected;

	return (
		<div className="min-w-0 flex-1">
			<div
				className={
					noWrap
						? "flex min-w-0 flex-nowrap items-center gap-2 overflow-hidden"
						: "flex flex-wrap items-center gap-2"
				}
			>
				{resolvedIsConnected ? (
					<span
						title={scanT(t, "scan.activity.live", "Live")}
						className="relative flex h-2 w-2 shrink-0"
					>
						<span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
						<span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
					</span>
				) : null}
				<Badge
					variant="outline"
					className={getActivityBadgeClassName(resolvedActivity.kind)}
				>
					{resolvedActivity.label}
				</Badge>
				{typeof resolvedActivity.tokenUsage?.used === "number" ? (
					<Badge
						variant="outline"
						className="border-muted-foreground/20 bg-background text-muted-foreground"
						title={scanT(
							t,
							"scan.activity.tokenUsage",
							"Token usage: {{count}}",
							{ count: resolvedActivity.tokenUsage.used },
						)}
					>
						{formatTokenUsage(resolvedActivity.tokenUsage.used)} tokens
					</Badge>
				) : null}
			</div>
		</div>
	);
};

export const LiveTaskActivityButton = ({
	taskId,
	title,
	subtitle,
	activity,
	variant = "secondary",
	size = "sm",
	iconOnly = false,
}: {
	taskId: string;
	title: string;
	subtitle?: string | null;
	activity?: SandboxAgentActivity;
	variant?: "default" | "secondary" | "outline" | "ghost";
	size?: "default" | "sm" | "lg" | "icon";
	iconOnly?: boolean;
}) => {
	const { t } = useTranslation("scan");
	const [isOpen, setIsOpen] = useState(false);
	const openedAtRef = useRef<number | null>(null);
	const messageCountRef = useRef(0);
	const liveActivity = useSandboxAgentActivity({
		taskId,
		enabled: !!taskId && !activity,
	});
	const resolvedActivity = activity || liveActivity.activity;
	const {
		messages,
		isConnected: isDetailConnected,
		metadata,
		errorMessage,
	} = useSandboxAgentSession({
		taskId,
		enabled: isOpen && !!taskId,
	});

	useEffect(() => {
		messageCountRef.current = messages.length;
	}, [messages.length]);

	useEffect(() => {
		if (!isOpen || !taskId) {
			return;
		}
		if (openedAtRef.current === null) {
			openedAtRef.current =
				typeof performance !== "undefined" ? performance.now() : Date.now();
		}
		console.info("[sandbox-agent-output]", {
			taskId,
			event: "dialog.open",
			elapsedMs: 0,
			title,
		});
		return () => {
			const now =
				typeof performance !== "undefined" ? performance.now() : Date.now();
			console.info("[sandbox-agent-output]", {
				taskId,
				event: "dialog.close",
				elapsedMs:
					openedAtRef.current === null
						? null
						: Math.round(now - openedAtRef.current),
				messageCount: messageCountRef.current,
			});
			openedAtRef.current = null;
		};
	}, [isOpen, taskId, title]);

	return (
		<>
			<Button
				type="button"
				variant={variant}
				size={size}
				disabled={!taskId}
				title={scanT(t, "scan.activity.viewOutput", "View agent output")}
				aria-label={scanT(t, "scan.activity.viewOutput", "View agent output")}
				onClick={(event) => {
					event.stopPropagation();
					openedAtRef.current =
						typeof performance !== "undefined" ? performance.now() : Date.now();
					console.info("[sandbox-agent-output]", {
						taskId,
						event: "activity_button.click",
						elapsedMs: 0,
						title,
					});
					setIsOpen(true);
				}}
			>
				<Activity className={iconOnly ? "size-4" : "mr-2 size-4"} />
				{iconOnly ? null : scanT(t, "scan.activity.view", "View")}
			</Button>
			<Dialog open={isOpen} onOpenChange={setIsOpen}>
				<DialogContent className="max-w-5xl">
					<DialogHeader>
						<DialogTitle>{title}</DialogTitle>
						<DialogDescription>
							{subtitle ||
								scanT(
									t,
									"scan.activity.operations",
									"Live sandbox agent operations",
								)}
						</DialogDescription>
					</DialogHeader>
					<div className="mb-3 flex flex-wrap items-center gap-2">
						<Badge
							variant="outline"
							className={getActivityBadgeClassName(resolvedActivity.kind)}
						>
							{resolvedActivity.label}
						</Badge>
						{isDetailConnected ? (
							<span className="flex items-center gap-1 text-xs text-muted-foreground">
								<span className="size-1.5 rounded-full bg-emerald-500" />
								{scanT(t, "scan.activity.connected", "connected")}
							</span>
						) : (
							<span className="flex items-center gap-1 text-xs text-muted-foreground">
								<Loader2 className="size-3 animate-spin" />
								{scanT(t, "scan.activity.connecting", "connecting")}
							</span>
						)}
					</div>
					{errorMessage ? (
						<div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/60 dark:bg-red-950/50 dark:text-red-100">
							{errorMessage}
						</div>
					) : null}
					{metadata && messages.length === 0 ? (
						<div className="mb-3 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
							<div>status: {metadata.status || "-"}</div>
							<div>
								jsonl: {metadata.jsonlExists === false ? "missing" : "visible"}
							</div>
							{metadata.jsonlStatError ? (
								<div className="break-all">
									error: {metadata.jsonlStatError}
								</div>
							) : null}
							{metadata.jsonlPath ? (
								<div className="break-all">path: {metadata.jsonlPath}</div>
							) : null}
						</div>
					) : null}
					<JsonRpcSummaryPanel
						messages={messages}
						maxHeightClassName="max-h-[65vh]"
						className="min-w-0"
						debugTaskId={taskId}
					/>
				</DialogContent>
			</Dialog>
		</>
	);
};

export const LiveTaskTextButton = ({
	taskId,
	title,
	subtitle,
	variant = "secondary",
	size = "sm",
	iconOnly = false,
}: {
	taskId: string;
	title: string;
	subtitle?: string | null;
	variant?: "default" | "secondary" | "outline" | "ghost";
	size?: "default" | "sm" | "lg" | "icon";
	iconOnly?: boolean;
}) => {
	const { t } = useTranslation("scan");
	const [isOpen, setIsOpen] = useState(false);
	const textContainerRef = useRef<HTMLPreElement | null>(null);
	const textAutoScrollRef = useRef(true);
	const textState = useSandboxAgentText({
		taskId,
		enabled: isOpen && !!taskId,
	});

	useEffect(() => {
		if (!isOpen) {
			textAutoScrollRef.current = true;
			return;
		}
		const container = textContainerRef.current;
		if (!container || !textAutoScrollRef.current) {
			return;
		}
		scrollContainerToBottom(container);
	});

	return (
		<>
			<Button
				type="button"
				variant={variant}
				size={size}
				disabled={!taskId}
				title={scanT(t, "scan.activity.viewTextLog", "View agent text log")}
				aria-label={scanT(t, "scan.activity.viewTextLog", "View agent text log")}
				onClick={(event) => {
					event.stopPropagation();
					setIsOpen(true);
				}}
			>
				<FileText className={iconOnly ? "size-4" : "mr-2 size-4"} />
				{iconOnly ? null : scanT(t, "scan.activity.text", "Text")}
			</Button>
			<Dialog open={isOpen} onOpenChange={setIsOpen}>
				<DialogContent className="max-w-5xl">
					<DialogHeader>
						<DialogTitle>{title}</DialogTitle>
						<DialogDescription>
							{subtitle ||
								scanT(t, "scan.activity.textLog", "Live sandbox agent text log")}
						</DialogDescription>
					</DialogHeader>
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
							{textState.metadata.textPath ? (
								<div className="break-all">
									path: {textState.metadata.textPath}
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
						className="max-h-[65vh] min-h-[360px] w-full overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-words rounded-md border bg-muted/20 p-3 text-xs leading-relaxed text-foreground"
					>
						{textState.text || scanT(t, "scan.activity.noText", "No text output yet.")}
					</pre>
				</DialogContent>
			</Dialog>
		</>
	);
};
