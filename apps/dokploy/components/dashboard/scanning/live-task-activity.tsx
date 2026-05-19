import { Activity, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { JsonRpcSummaryPanel } from "@/components/dashboard/scanning/jsonrpc-summary";
import { useSandboxAgentActivity } from "@/components/dashboard/scanning/use-sandbox-agent-activity";
import { useSandboxAgentSession } from "@/components/dashboard/scanning/use-sandbox-agent-session";
import type { SandboxAgentActivity } from "@/lib/scan/sandbox-agent-activity";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";

const getActivityBadgeClassName = (kind: string) => {
	if (kind === "web") {
		return "border-sky-200 bg-sky-100 text-sky-700";
	}
	if (kind === "tool" || kind === "command") {
		return "border-emerald-200 bg-emerald-100 text-emerald-700";
	}
	if (kind === "reasoning" || kind === "planning") {
		return "border-amber-200 bg-amber-100 text-amber-700";
	}
	if (kind === "writing") {
		return "border-violet-200 bg-violet-100 text-violet-700";
	}
	if (kind === "error") {
		return "border-red-200 bg-red-100 text-red-700";
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
}: {
	taskId?: string;
	activity?: SandboxAgentActivity;
	isConnected?: boolean;
}) => {
	const liveActivity = useSandboxAgentActivity({
		taskId: taskId || "",
		enabled: !!taskId && !activity,
	});
	const resolvedActivity = activity || liveActivity.activity;
	const resolvedIsConnected = isConnected ?? liveActivity.isConnected;

	return (
		<div className="min-w-0 flex-1">
			<div className="flex flex-wrap items-center gap-2">
				{resolvedIsConnected ? (
					<span
						title="Live"
						className="size-1.5 shrink-0 rounded-full bg-emerald-500"
					/>
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
							title={`Token usage: ${resolvedActivity.tokenUsage.used}`}
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
			const now = typeof performance !== "undefined" ? performance.now() : Date.now();
			console.info("[sandbox-agent-output]", {
				taskId,
				event: "dialog.close",
				elapsedMs:
					openedAtRef.current === null ? null : Math.round(now - openedAtRef.current),
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
				title="View agent output"
				aria-label="View agent output"
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
				{iconOnly ? null : "View"}
			</Button>
			<Dialog open={isOpen} onOpenChange={setIsOpen}>
				<DialogContent className="max-w-5xl">
					<DialogHeader>
						<DialogTitle>{title}</DialogTitle>
						<DialogDescription>
							{subtitle || "Live sandbox agent operations"}
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
								connected
							</span>
						) : (
							<span className="flex items-center gap-1 text-xs text-muted-foreground">
								<Loader2 className="size-3 animate-spin" />
								connecting
							</span>
						)}
					</div>
					{errorMessage ? (
						<div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
							{errorMessage}
						</div>
					) : null}
					{metadata && messages.length === 0 ? (
						<div className="mb-3 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
							<div>status: {metadata.status || "-"}</div>
							<div>jsonl: {metadata.jsonlExists === false ? "missing" : "visible"}</div>
							{metadata.jsonlStatError ? (
								<div className="break-all">error: {metadata.jsonlStatError}</div>
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
