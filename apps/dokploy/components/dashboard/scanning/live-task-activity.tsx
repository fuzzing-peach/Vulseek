import { Activity, Loader2 } from "lucide-react";
import { useState } from "react";
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

export const LiveTaskActivity = ({
	taskId,
	title,
	subtitle,
	viewButtonVariant = "secondary",
	viewButtonSize = "sm",
	iconOnlyViewButton = false,
}: {
	taskId: string;
	title: string;
	subtitle?: string | null;
	viewButtonVariant?: "default" | "secondary" | "outline" | "ghost";
	viewButtonSize?: "default" | "sm" | "lg" | "icon";
	iconOnlyViewButton?: boolean;
}) => {
	const { activity, isConnected } = useSandboxAgentActivity({
		taskId,
		enabled: !!taskId,
	});

	return (
		<div className="flex min-w-0 items-start justify-between gap-3">
			<LiveTaskActivityBadge activity={activity} isConnected={isConnected} />
			<LiveTaskActivityButton
				taskId={taskId}
				title={title}
				subtitle={subtitle}
				activity={activity}
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
	activity?: { kind: string; label: string };
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
	activity?: { kind: string; label: string };
	variant?: "default" | "secondary" | "outline" | "ghost";
	size?: "default" | "sm" | "lg" | "icon";
	iconOnly?: boolean;
}) => {
	const [isOpen, setIsOpen] = useState(false);
	const liveActivity = useSandboxAgentActivity({
		taskId,
		enabled: !!taskId && (!activity || isOpen),
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
					/>
				</DialogContent>
			</Dialog>
		</>
	);
};
