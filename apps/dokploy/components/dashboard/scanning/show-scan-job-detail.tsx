import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, FileSearch, Loader2, Radio, Search } from "lucide-react";
import Head from "next/head";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { DateTooltip } from "@/components/shared/date-tooltip";
import { BreadcrumbSidebar } from "@/components/shared/breadcrumb-sidebar";
import { Badge } from "@/components/ui/badge";
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
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/utils/api";

interface Props {
	projectId: string;
	environmentId: string;
	serviceId: string;
	scanJobId: string;
	serviceType: "application" | "compose";
	routeSegment: "profiles" | "services";
}

type JsonRpcStreamMessage = {
	line: number;
	message: Record<string, unknown>;
};

type SummaryLine = {
	id: string;
	kind: "system" | "reasoning" | "command" | "agent" | "error";
	text: string;
};

const trimSummary = (value: string, max = 220) => {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (!normalized) {
		return "";
	}
	return normalized.length > max
		? `${normalized.slice(0, Math.max(0, max - 3))}...`
		: normalized;
};

const summarizeCommandResult = (input: string, command: string) => {
	const summary = trimSummary(input, 240);
	if (!summary) {
		return "";
	}

	const normalizedCommand = trimSummary(command, 240);
	if (normalizedCommand && summary === normalizedCommand) {
		return "";
	}

	if (normalizedCommand && summary === `$ ${normalizedCommand}`) {
		return "";
	}

	return summary;
};

const extractScanningSummaryLines = (
	messages: JsonRpcStreamMessage[],
): SummaryLine[] => {
	const lines: SummaryLine[] = [];
	const commandOutputByItemId = new Map<string, string>();
	const reasoningByItemId = new Map<string, string>();
	const commandByItemId = new Map<string, string>();
	const reasoningLineIndexByItemId = new Map<string, number>();

	for (const entry of messages) {
		const message = entry.message;
		const method = typeof message.method === "string" ? message.method : "";
		const params = (message.params as Record<string, unknown> | undefined) || {};

		if (
			method === "item/reasoning/textDelta" ||
			method === "item/reasoning/summaryTextDelta"
		) {
			const itemId = typeof params.itemId === "string" ? params.itemId : "";
			const delta = typeof params.delta === "string" ? params.delta : "";
			if (itemId && delta) {
				reasoningByItemId.set(
					itemId,
					`${reasoningByItemId.get(itemId) || ""}${delta}`,
				);
			}
			continue;
		}

		if (method === "item/commandExecution/outputDelta") {
			const itemId = typeof params.itemId === "string" ? params.itemId : "";
			const delta = typeof params.delta === "string" ? params.delta : "";
			if (itemId && delta) {
				commandOutputByItemId.set(
					itemId,
					`${commandOutputByItemId.get(itemId) || ""}${delta}`,
				);
			}
			continue;
		}

		if (method === "item/started") {
			const item = (params.item as Record<string, unknown> | undefined) || {};
			const itemType = typeof item.type === "string" ? item.type : "";
			const itemId = typeof item.id === "string" ? item.id : "";
			if (itemType === "commandExecution") {
				const command =
					typeof item.command === "string" ? trimSummary(item.command) : "command";
				if (itemId) {
					commandByItemId.set(itemId, command);
				}
				lines.push({
					id: `line-${entry.line}`,
					kind: "command",
					text: `$ ${command}`,
				});
				continue;
			}
			if (itemType === "reasoning") {
				const lineId = itemId || `line-${entry.line}`;
				reasoningLineIndexByItemId.set(lineId, lines.length);
				lines.push({
					id: lineId,
					kind: "reasoning",
					text: "[reasoning started]",
				});
				continue;
			}
		}

		if (method === "item/completed") {
			const item = (params.item as Record<string, unknown> | undefined) || {};
			const itemType = typeof item.type === "string" ? item.type : "";
			const itemId = typeof item.id === "string" ? item.id : "";

			if (itemType === "commandExecution") {
				const aggregatedOutput =
					typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "";
				const command = commandByItemId.get(itemId) || "command";
				const output = summarizeCommandResult(
					aggregatedOutput || commandOutputByItemId.get(itemId) || "",
					command,
				);
				if (output) {
					lines.push({
						id: `${itemId}-output-${entry.line}`,
						kind: "command",
						text: output,
					});
				} else {
					const status =
						typeof item.status === "string" ? item.status.toLowerCase() : "completed";
					lines.push({
						id: `${itemId}-done-${entry.line}`,
						kind: status === "failed" ? "error" : "command",
						text:
							status === "failed"
								? `${command} failed`
								: `${command} finished without output`,
					});
				}
				commandOutputByItemId.delete(itemId);
				commandByItemId.delete(itemId);
				continue;
			}

			if (itemType === "reasoning") {
				const summary = trimSummary(reasoningByItemId.get(itemId) || "");
				const lineIndex = reasoningLineIndexByItemId.get(itemId);
				if (lineIndex !== undefined) {
					lines[lineIndex] = {
						id: itemId,
						kind: "reasoning",
						text: summary || "[reasoning completed]",
					};
					reasoningLineIndexByItemId.delete(itemId);
				} else {
					lines.push({
						id: `${itemId}-reasoning-${entry.line}`,
						kind: "reasoning",
						text: summary || "[reasoning completed]",
					});
				}
				reasoningByItemId.delete(itemId);
				continue;
			}

			if (itemType === "agentMessage") {
				const text = typeof item.text === "string" ? item.text : "";
				const summary = trimSummary(text, 260);
				if (summary) {
					lines.push({
						id: `${itemId}-agent-${entry.line}`,
						kind: "agent",
						text: summary,
					});
				}
				continue;
			}
		}

		if (method === "error") {
			const error = (params.error as Record<string, unknown> | undefined) || {};
			const errorMessage =
				typeof error.message === "string"
					? error.message
					: typeof params.message === "string"
						? params.message
						: "Unknown error";
			lines.push({
				id: `line-${entry.line}`,
				kind: "error",
				text: `[error] ${trimSummary(errorMessage, 240)}`,
			});
		}
	}

	return lines.slice(-80);
};

const getScanJobStatusLabel = (status?: string) => {
	if (status === "queued") {
		return "Queued";
	}

	if (status === "scanning") {
		return "Scanning";
	}

	if (status === "analyzing") {
		return "Analyzing";
	}

	if (status === "completed") {
		return "Completed";
	}

	if (status === "failed") {
		return "Failed";
	}

	return "Queued";
};

const getScanJobStatusClassName = (status?: string) => {
	if (status === "completed") {
		return "text-green-600";
	}

	if (status === "failed") {
		return "text-destructive";
	}

	if (status === "analyzing") {
		return "text-sky-600";
	}

	if (status === "scanning") {
		return "text-amber-600";
	}

	return "text-muted-foreground";
};

const getSummaryLineClassName = (line: SummaryLine) => {
	if (line.kind === "reasoning") {
		return line.text === "[reasoning started]"
			? "text-sm font-medium italic text-amber-700/90"
			: "text-sm font-medium text-amber-700/90";
	}

	if (line.kind === "error") {
		return "text-sm font-semibold text-destructive";
	}

	if (line.kind === "command" && line.text.startsWith("$ ")) {
		return "text-sm font-semibold tracking-tight text-sky-700";
	}

	if (line.kind === "command") {
		return "text-sm font-normal text-emerald-700/95";
	}

	if (line.kind === "agent") {
		return "text-sm font-normal text-foreground/90";
	}

	return "text-sm font-medium text-muted-foreground";
};

const getSummaryLinePrefix = (line: SummaryLine) => {
	if (line.kind === "command" && line.text.startsWith("$ ")) {
		return "$";
	}

	if (line.kind === "command") {
		return "";
	}

	return ">";
};

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

	return "border-muted-foreground/20 bg-muted text-muted-foreground";
};

export const ShowScanJobDetail = ({
	projectId,
	environmentId,
	serviceId,
	scanJobId,
	serviceType,
	routeSegment,
}: Props) => {
	const [candidateQuery, setCandidateQuery] = useState("");
	const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(
		null,
	);
	const [streamText, setStreamText] = useState("");
	const [streamState, setStreamState] = useState<
		"connecting" | "streaming" | "completed" | "failed" | "disconnected"
	>("connecting");
	const [jsonRpcMessages, setJsonRpcMessages] = useState<JsonRpcStreamMessage[]>([]);
	const [jsonRpcState, setJsonRpcState] = useState<
		"connecting" | "streaming" | "completed" | "failed" | "disconnected"
	>("connecting");
	const streamContainerRef = useRef<HTMLDivElement | null>(null);
	const scanningSummaryContainerRef = useRef<HTMLDivElement | null>(null);

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
	const { data: statusView, isLoading: isLoadingStatusView } =
		api.scan.statusView.useQuery(
			{ scanJobId },
			{ enabled: !!scanJobId, refetchInterval: 2000 },
		);

	useEffect(() => {
		setStreamText("");
		setStreamState("connecting");

		const eventSource = new EventSource(
			`/api/scan/jobs/${scanJobId}/text-stream`,
		);
		eventSource.addEventListener("snapshot", (event) => {
			const payload = JSON.parse((event as MessageEvent).data) as { text?: string };
			setStreamText(payload.text || "");
			setStreamState("streaming");
		});
		eventSource.addEventListener("append", (event) => {
			const payload = JSON.parse((event as MessageEvent).data) as { text?: string };
			if (payload.text) {
				setStreamText((current) => `${current}${payload.text}`);
			}
			setStreamState("streaming");
		});
		eventSource.addEventListener("done", (event) => {
			const payload = JSON.parse((event as MessageEvent).data) as {
				status?: string;
			};
			setStreamState(payload.status === "failed" ? "failed" : "completed");
			eventSource.close();
		});
		eventSource.addEventListener("error", () => {
			setStreamState((current) =>
				current === "completed" || current === "failed"
					? current
					: "disconnected",
			);
		});

		return () => {
			eventSource.close();
		};
	}, [scanJobId]);

	useEffect(() => {
		const container = streamContainerRef.current;
		if (!container) {
			return;
		}
		container.scrollTop = container.scrollHeight;
	}, [streamText]);

	const scanningSummaryLines = useMemo(
		() => extractScanningSummaryLines(jsonRpcMessages),
		[jsonRpcMessages],
	);
	const filteredCandidates = useMemo(() => {
		if (!candidates) {
			return [];
		}
		const query = candidateQuery.trim().toLowerCase();
		if (!query) {
			return candidates;
		}
		return candidates.filter((candidate) => {
			const haystack = [
				candidate.title,
				candidate.description || "",
				candidate.filePath || "",
				candidate.status,
				typeof candidate.line === "number" ? String(candidate.line) : "",
				candidate.latestAnalysisResult?.result || "",
				candidate.latestAnalysisResult?.reportPath || "",
				candidate.latestAnalysisResult?.threadId || "",
			]
				.join("\n")
				.toLowerCase();
			return haystack.includes(query);
		});
	}, [candidateQuery, candidates]);
	const selectedCandidate = useMemo(
		() =>
			candidates?.find(
				(candidate) =>
					candidate.vulnerabilityCandidateId === selectedCandidateId,
			) || null,
		[candidates, selectedCandidateId],
	);

	useEffect(() => {
		setJsonRpcMessages([]);
		setJsonRpcState("connecting");

		const eventSource = new EventSource(
			`/api/scan/jobs/${scanJobId}/jsonrpc-stream`,
		);
		eventSource.addEventListener("snapshot", (event) => {
			const payload = JSON.parse((event as MessageEvent).data) as {
				messages?: JsonRpcStreamMessage[];
			};
			setJsonRpcMessages(payload.messages || []);
			setJsonRpcState("streaming");
		});
		eventSource.addEventListener("append", (event) => {
			const payload = JSON.parse((event as MessageEvent).data) as {
				messages?: JsonRpcStreamMessage[];
			};
			if (payload.messages?.length) {
				setJsonRpcMessages((current) => [...current, ...payload.messages!]);
			}
			setJsonRpcState("streaming");
		});
		eventSource.addEventListener("done", (event) => {
			const payload = JSON.parse((event as MessageEvent).data) as {
				status?: string;
			};
			setJsonRpcState(payload.status === "failed" ? "failed" : "completed");
			eventSource.close();
		});
		eventSource.addEventListener("error", () => {
			setJsonRpcState((current) =>
				current === "completed" || current === "failed"
					? current
					: "disconnected",
			);
		});

		return () => {
			eventSource.close();
		};
	}, [scanJobId]);

	useEffect(() => {
		const container = scanningSummaryContainerRef.current;
		if (!container) {
			return;
		}
		container.scrollTop = container.scrollHeight;
	}, [scanningSummaryLines]);

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
					<CardDescription>{scanJobId}</CardDescription>
				</CardHeader>
				<CardContent>
					<Tabs defaultValue="overview" className="w-full">
						<TabsList className="flex gap-4 justify-start">
							<TabsTrigger value="overview">Overview</TabsTrigger>
							<TabsTrigger value="status">Status</TabsTrigger>
							<TabsTrigger value="candidates">Candidates</TabsTrigger>
							<TabsTrigger value="stream">Scanning</TabsTrigger>
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
										<div className="font-medium">{scanJob.triggerSource}</div>
									</div>
									<div className="border rounded-lg p-3">
										<div className="text-sm text-muted-foreground">Commit Window</div>
										<div className="font-medium">k={scanJob.commitWindow}</div>
									</div>
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
								</div>
							)}
						</TabsContent>

						<TabsContent value="status" className="pt-4">
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
								<div className="flex flex-col gap-6">
									<div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
										<div className="rounded-lg border p-4">
											<div className="text-sm text-muted-foreground">
												Total Candidates
											</div>
											<div className="mt-2 text-2xl font-semibold">
												{statusView.summary.totalCandidates}
											</div>
										</div>
										<div className="rounded-lg border p-4">
											<div className="text-sm text-muted-foreground">
												Completed Candidates
											</div>
											<div className="mt-2 text-2xl font-semibold">
												{statusView.summary.completedCandidates}
											</div>
										</div>
										<div className="rounded-lg border p-4">
											<div className="text-sm text-muted-foreground">
												Excluded Candidates
											</div>
											<div className="mt-2 text-2xl font-semibold">
												{statusView.summary.excludedCandidates}
											</div>
										</div>
										<div className="rounded-lg border p-4">
											<div className="text-sm text-muted-foreground">
												Issue Candidates
											</div>
											<div className="mt-2 text-2xl font-semibold">
												{statusView.summary.issueCandidates}
											</div>
										</div>
									</div>

									<div className="rounded-lg border">
										<div className="border-b px-4 py-3">
											<div className="font-medium">In Progress Candidates</div>
											<div className="text-sm text-muted-foreground">
												Currently active candidate workers and their latest state.
											</div>
										</div>
										<div className="overflow-x-auto">
											<table className="w-full text-sm">
												<thead className="border-b bg-muted/30 text-left">
													<tr>
														<th className="px-4 py-3 font-medium">Candidate</th>
														<th className="px-4 py-3 font-medium">Stage</th>
														<th className="px-4 py-3 font-medium">Action Type</th>
														<th className="px-4 py-3 font-medium">Current Action</th>
														<th className="px-4 py-3 font-medium">Updated</th>
													</tr>
												</thead>
												<tbody>
													{statusView.inProgressCandidates.length === 0 ? (
														<tr>
															<td
																colSpan={5}
																className="px-4 py-6 text-center text-muted-foreground"
															>
																No active candidates
															</td>
														</tr>
													) : (
														statusView.inProgressCandidates.map((candidate) => (
															<tr
																key={candidate.vulnerabilityCandidateId}
																className="border-b last:border-b-0"
															>
																<td className="px-4 py-3 align-top">
																	<div className="font-medium">{candidate.title}</div>
																	<div className="text-xs text-muted-foreground break-all">
																		{candidate.filePath || "-"}
																		{candidate.line ? `:${candidate.line}` : ""}
																	</div>
																</td>
																<td className="px-4 py-3 align-top capitalize">
																	{candidate.stage}
																</td>
																<td className="px-4 py-3 align-top capitalize">
																	{candidate.actionType}
																</td>
																<td className="px-4 py-3 align-top">
																	<div
																		className="max-w-[420px] truncate"
																		title={candidate.actionText}
																	>
																		{candidate.actionText}
																	</div>
																</td>
																<td className="px-4 py-3 align-top">
																	<DateTooltip date={candidate.updatedAt} />
																</td>
															</tr>
														))
													)}
												</tbody>
											</table>
										</div>
									</div>

									<div className="rounded-lg border">
										<div className="border-b px-4 py-3">
											<div className="font-medium">Queued Candidates</div>
											<div className="text-sm text-muted-foreground">
												Top 10 pending candidates waiting for processing.
											</div>
										</div>
										<div className="overflow-x-auto">
											<table className="w-full text-sm">
												<thead className="border-b bg-muted/30 text-left">
													<tr>
														<th className="px-4 py-3 font-medium">Candidate</th>
														<th className="px-4 py-3 font-medium">Location</th>
														<th className="px-4 py-3 font-medium">Confidence</th>
														<th className="px-4 py-3 font-medium">Created</th>
													</tr>
												</thead>
												<tbody>
													{statusView.queuedCandidates.length === 0 ? (
														<tr>
															<td
																colSpan={4}
																className="px-4 py-6 text-center text-muted-foreground"
															>
																No queued candidates
															</td>
														</tr>
													) : (
														statusView.queuedCandidates.map((candidate) => (
															<tr
																key={candidate.vulnerabilityCandidateId}
																className="border-b last:border-b-0"
															>
																<td className="px-4 py-3 align-top font-medium">
																	{candidate.title}
																</td>
																<td className="px-4 py-3 align-top text-muted-foreground break-all">
																	{candidate.filePath || "-"}
																	{candidate.line ? `:${candidate.line}` : ""}
																</td>
																<td className="px-4 py-3 align-top">
																	{typeof candidate.confidence === "number"
																		? candidate.confidence
																		: "-"}
																</td>
																<td className="px-4 py-3 align-top">
																	<DateTooltip date={candidate.createdAt} />
																</td>
															</tr>
														))
													)}
												</tbody>
											</table>
										</div>
									</div>
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
									<div className="relative">
										<Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
										<input
											type="text"
											value={candidateQuery}
											onChange={(event) => setCandidateQuery(event.target.value)}
											placeholder="Search candidates"
											className="flex h-10 w-full rounded-md border border-input bg-background pl-9 pr-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
										/>
									</div>
									{filteredCandidates.length === 0 ? (
										<div className="flex items-center gap-2 text-muted-foreground">
											<FileSearch className="size-4" />
											No matching candidates
										</div>
									) : (
										filteredCandidates.map((candidate) => (
											<button
												type="button"
												key={candidate.vulnerabilityCandidateId}
												onClick={() =>
													setSelectedCandidateId(
														candidate.vulnerabilityCandidateId,
													)
												}
												className="flex w-full flex-col gap-1 rounded-lg border p-3 text-left transition-colors hover:border-foreground/20 hover:bg-muted/40"
											>
												<div className="flex items-center gap-2">
													<Badge variant="outline" className="capitalize">
														{candidate.status}
													</Badge>
													{typeof candidate.confidence === "number" && (
														<span className="text-xs text-muted-foreground">
															confidence: {candidate.confidence}
														</span>
													)}
												</div>
												<div className="font-medium">{candidate.title}</div>
												{candidate.description && (
													<div className="text-sm text-muted-foreground break-all">
														{candidate.description}
													</div>
												)}
											{candidate.filePath && (
												<div className="text-xs text-muted-foreground break-all">
													{candidate.filePath}
													{candidate.line ? `:${candidate.line}` : ""}
												</div>
											)}
										</button>
									))
								)}
								</div>
							)}
						</TabsContent>

						<TabsContent value="stream" className="pt-4">
							<div className="flex flex-col gap-4">
								<div className="border rounded-lg">
									<div className="flex items-center gap-2 border-b px-4 py-3 text-sm text-muted-foreground">
										<Radio className="size-4" />
										<span>JSON-RPC Summary</span>
										<span>·</span>
										<span className="capitalize">{jsonRpcState}</span>
										<span>·</span>
										<span>{jsonRpcMessages.length} messages</span>
									</div>
									<div
										ref={scanningSummaryContainerRef}
										className="max-h-[18vh] overflow-auto bg-muted/20 px-4 py-3"
									>
										<div className="font-mono text-xs leading-6">
											{scanningSummaryLines.length === 0 ? (
												<div className="text-muted-foreground">(empty)</div>
											) : (
												<AnimatePresence initial={false}>
													{scanningSummaryLines.map((line) => (
														<motion.div
															key={line.id}
															initial={{ opacity: 0, y: 8, scale: 0.995 }}
															animate={{ opacity: 1, y: 0, scale: 1 }}
															exit={{ opacity: 0, y: -4 }}
															transition={{ duration: 0.2, ease: "easeOut" }}
															className={`whitespace-pre-wrap break-words ${getSummaryLineClassName(line)} ${
																line.kind === "command" && !line.text.startsWith("$ ")
																	? "mt-1"
																	: "mt-4 first:mt-0"
															}`}
														>
															<div className="grid grid-cols-[20px_minmax(0,1fr)] gap-3">
																<div className="text-muted-foreground/80 text-center">
																	{getSummaryLinePrefix(line)}
																</div>
																<div>
																	{line.kind === "command" &&
																	line.text.startsWith("$ ")
																		? line.text.slice(2)
																		: line.text}
																</div>
															</div>
														</motion.div>
													))}
												</AnimatePresence>
											)}
										</div>
									</div>
								</div>

								<div className="border rounded-lg">
									<div className="flex items-center gap-2 border-b px-4 py-3 text-sm text-muted-foreground">
										<Radio className="size-4" />
										<span>Scanning</span>
										<span>·</span>
										<span className="capitalize">{streamState}</span>
									</div>
									<div
										ref={streamContainerRef}
										className="max-h-[65vh] overflow-auto px-4 py-3"
									>
										<pre className="whitespace-pre-wrap break-words text-sm">
											{streamText || "(empty)"}
										</pre>
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
			<Dialog
				open={Boolean(selectedCandidate)}
				onOpenChange={(open) => {
					if (!open) {
						setSelectedCandidateId(null);
					}
				}}
			>
				<DialogContent className="max-w-3xl">
					<DialogHeader>
						<DialogTitle>{selectedCandidate?.title || "Candidate Detail"}</DialogTitle>
						<DialogDescription>
							{selectedCandidate?.vulnerabilityCandidateId || "-"}
						</DialogDescription>
					</DialogHeader>
					{selectedCandidate ? (
						<div className="grid gap-6">
							<div className="grid gap-3 md:grid-cols-2">
								<div className="rounded-lg border p-3">
									<div className="text-sm text-muted-foreground">Status</div>
									<div className="mt-1 font-medium capitalize">
										{selectedCandidate.status}
									</div>
								</div>
								<div className="rounded-lg border p-3">
									<div className="text-sm text-muted-foreground">Current Stage</div>
									<div className="mt-1 font-medium capitalize">
										{selectedCandidate.currentStage}
									</div>
								</div>
								<div className="rounded-lg border p-3">
									<div className="text-sm text-muted-foreground">Location</div>
									<div className="mt-1 break-all font-medium">
										{selectedCandidate.filePath || "-"}
										{selectedCandidate.line ? `:${selectedCandidate.line}` : ""}
									</div>
								</div>
								<div className="rounded-lg border p-3">
									<div className="text-sm text-muted-foreground">Confidence</div>
									<div className="mt-1 font-medium">
										{typeof selectedCandidate.confidence === "number"
											? selectedCandidate.confidence
											: "-"}
									</div>
								</div>
								<div className="rounded-lg border p-3">
									<div className="text-sm text-muted-foreground">Created</div>
									<div className="mt-1 font-medium">
										<DateTooltip date={selectedCandidate.createdAt} />
									</div>
								</div>
								<div className="rounded-lg border p-3">
									<div className="text-sm text-muted-foreground">Updated</div>
									<div className="mt-1 font-medium">
										<DateTooltip date={selectedCandidate.updatedAt} />
									</div>
								</div>
							</div>

							<div className="rounded-lg border p-3">
								<div className="text-sm text-muted-foreground">Description</div>
								<div className="mt-1 whitespace-pre-wrap break-words text-sm">
									{selectedCandidate.description || "-"}
								</div>
							</div>

							<div className="rounded-lg border p-3">
								<div className="mb-3 flex items-center justify-between gap-3">
									<div className="text-sm text-muted-foreground">
										Latest Analysis Result
									</div>
									{selectedCandidate.latestAnalysisResult?.result ? (
										<Badge
											variant="outline"
											className={`capitalize ${getAnalysisResultBadgeClassName(
												selectedCandidate.latestAnalysisResult.result,
											)}`}
										>
											{selectedCandidate.latestAnalysisResult.result.replace(
												/_/g,
												" ",
											)}
										</Badge>
									) : null}
								</div>
								<div className="grid gap-3 md:grid-cols-2">
									<div className="rounded-md border p-3">
										<div className="text-xs text-muted-foreground">Summary</div>
										<div className="mt-1 whitespace-pre-wrap break-words text-sm">
											{selectedCandidate.latestAnalysisResult?.summary || "-"}
										</div>
									</div>
									<div className="rounded-md border p-3">
										<div className="text-xs text-muted-foreground">Report Path</div>
										<div className="mt-1 break-all text-sm">
											{selectedCandidate.latestAnalysisResult?.reportPath || "-"}
										</div>
									</div>
									<div className="rounded-md border p-3">
										<div className="text-xs text-muted-foreground">
											Runtime Seconds
										</div>
										<div className="mt-1 text-sm">
											{typeof selectedCandidate.latestAnalysisResult
												?.runtimeSeconds === "number"
												? selectedCandidate.latestAnalysisResult.runtimeSeconds
												: "-"}
										</div>
									</div>
									<div className="rounded-md border p-3">
										<div className="text-xs text-muted-foreground">Thread ID</div>
										<div className="mt-1 break-all text-sm">
											{selectedCandidate.latestAnalysisResult?.threadId || "-"}
										</div>
									</div>
								</div>
							</div>
						</div>
					) : null}
				</DialogContent>
			</Dialog>
		</div>
	);
};
