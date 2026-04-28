import {
	AlertCircle,
	FileIcon,
	Folder,
	Loader2,
	ShieldCheck,
	Workflow,
} from "lucide-react";
import Head from "next/head";
import Link from "next/link";
import { useRouter } from "next/router";
import { useEffect, useMemo, useState } from "react";
import {
	buildCandidateListStateHref,
	parseCandidateListQueryState,
} from "@/components/dashboard/scanning/candidate-list-query-state";
import { JsonRpcSummaryPanel } from "@/components/dashboard/scanning/jsonrpc-summary";
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
import { api } from "@/utils/api";

interface Props {
	serviceType: "application" | "compose";
	routeSegment: "profiles" | "services";
}

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
			label: "Verified 0day",
			className: "border-red-200 bg-red-100 text-red-700",
		};
	}

	return {
		label: "Verified Not 0day",
		className: "border-muted-foreground/20 bg-muted text-muted-foreground",
	};
};

export const ShowScanCandidateDetail = ({
	serviceType,
	routeSegment,
}: Props) => {
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
	const candidateId =
		typeof router.query.candidateId === "string" ? router.query.candidateId : "";
	const candidateListQueryState = useMemo(
		() => parseCandidateListQueryState(router.query),
		[router.query],
	);
	const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
	const [previewFilePath, setPreviewFilePath] = useState<string | null>(null);

	const jobCandidatesHref = buildCandidateListStateHref(
		`/dashboard/project/${projectId}/environment/${environmentId}/${routeSegment}/${serviceType}/${serviceId}/jobs/${scanJobId}`,
		candidateListQueryState,
		"candidates",
	);

	const serviceQuery =
		serviceType === "application"
			? api.application.one.useQuery({ applicationId: serviceId })
			: api.compose.one.useQuery({ composeId: serviceId });
	const serviceData = serviceQuery.data;

	const { data: candidate, isLoading: isLoadingCandidate } = api.scan.candidate.useQuery(
		{ vulnerabilityCandidateId: candidateId },
		{ enabled: !!candidateId, refetchInterval: 2000 },
	);
	const { data: fileTree, isLoading: isLoadingFileTree } =
		api.scan.candidateFilesTree.useQuery(
			{ vulnerabilityCandidateId: candidateId },
			{ enabled: !!candidateId, refetchInterval: 4000 },
		);
	const { data: selectedFile, isLoading: isLoadingSelectedFile } =
		api.scan.readCandidateFile.useQuery(
			{ vulnerabilityCandidateId: candidateId, filePath: selectedFilePath || "" },
			{ enabled: !!candidateId && !!selectedFilePath },
		);
	const { data: previewFile, isLoading: isLoadingPreviewFile } =
		api.scan.readCandidateFile.useQuery(
			{ vulnerabilityCandidateId: candidateId, filePath: previewFilePath || "" },
			{ enabled: !!candidateId && !!previewFilePath },
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

		setSelectedFilePath((current) => current || walk(fileTree as Array<Record<string, unknown>>));
	}, [fileTree]);

	const verificationTruthBadge = useMemo(
		() => getVerificationTruthBadge(candidate?.latestVerificationResult?.result),
		[candidate?.latestVerificationResult?.result],
	);
	const candidateStreamStage =
		candidate?.currentStage === "verifying" ? "verifying" : "analyzing";
	const candidateTaskId =
		candidateStreamStage === "verifying"
			? candidate?.latestVerificationResult?.candidateVerificationTaskId || ""
			: candidate?.latestAnalysisResult?.candidateAnalysisTaskId || "";
	const {
		messages: liveJsonRpcMessages,
	} = useSandboxAgentSession({
		taskId: candidateTaskId,
		enabled: !!candidateTaskId && candidate?.status === "running",
	});
	const canVerify =
		candidate?.latestAnalysisResult?.result === "real_vulnerability" ||
		candidate?.latestAnalysisResult?.result === "likely_vulnerability";
	const verifyButtonLabel = candidate?.latestVerificationResult ? "Reverify" : "Verify";
	const renderPathCard = (label: string, value?: string | null, copyLabel?: string) => (
		<button
			type="button"
			disabled={!value}
			onClick={() => value && setPreviewFilePath(value)}
			className="rounded-md border p-3 text-left transition-colors enabled:hover:border-foreground/20 enabled:hover:bg-muted/40 disabled:cursor-default"
		>
			<div className="text-xs text-muted-foreground">{label}</div>
			<div className="mt-1 flex items-start gap-2 break-all text-sm">
				<span className="min-w-0 flex-1">{value || "-"}</span>
				{value ? (
					<div onClick={(event) => event.stopPropagation()}>
						<CopyValueButton
							value={value}
							label={copyLabel || label}
							className="size-6 shrink-0"
						/>
					</div>
				) : null}
			</div>
		</button>
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
			<Dialog open={!!previewFilePath} onOpenChange={(open) => !open && setPreviewFilePath(null)}>
				<DialogContent className="max-w-5xl">
					<DialogHeader>
						<DialogTitle>File Preview</DialogTitle>
					</DialogHeader>
					<div className="rounded-md border">
						<div className="flex items-start justify-between gap-3 border-b px-4 py-3 text-sm text-muted-foreground">
							<span className="break-all">
								{previewFile?.relativePath || previewFilePath || "No file selected"}
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
					<Tabs defaultValue="overview" className="w-full">
						<TabsList className="flex gap-4 justify-start">
							<TabsTrigger value="overview">Overview</TabsTrigger>
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
									<div className="grid gap-3 md:grid-cols-2">
										<div className="rounded-lg border p-3">
											<div className="text-sm text-muted-foreground">Status</div>
											<div className="mt-1 font-medium capitalize">{candidate.status}</div>
										</div>
										<div className="rounded-lg border p-3">
											<div className="text-sm text-muted-foreground">Current Stage</div>
											<div className="mt-1 font-medium capitalize">{candidate.currentStage}</div>
										</div>
										<div className="rounded-lg border p-3">
											<div className="text-sm text-muted-foreground">Verified</div>
											<div className="mt-1 font-medium">
												{candidate.latestVerificationResult
													? candidate.latestVerificationResult.result === "real_vulnerability"
														? "Yes"
														: "No"
													: "-"}
											</div>
										</div>
										<div className="rounded-lg border p-3">
											<div className="text-sm text-muted-foreground">Location</div>
											<div className="mt-1 break-all font-medium">
												{candidate.filePath || "-"}
												{candidate.line ? `:${candidate.line}` : ""}
											</div>
										</div>
										<div className="rounded-lg border p-3">
											<div className="text-sm text-muted-foreground">Score</div>
											<div className="mt-1 font-medium">
												{typeof candidate.score === "number"
													? candidate.score.toFixed(1)
													: "-"}
											</div>
										</div>
										<div className="rounded-lg border p-3">
											<div className="text-sm text-muted-foreground">Confidence</div>
											<div className="mt-1 font-medium">
												{typeof candidate.confidence === "number" ? candidate.confidence : "-"}
											</div>
										</div>
										<div className="rounded-lg border p-3">
											<div className="text-sm text-muted-foreground">Created</div>
											<div className="mt-1 font-medium"><DateTooltip date={candidate.createdAt} /></div>
										</div>
										<div className="rounded-lg border p-3">
											<div className="text-sm text-muted-foreground">Updated</div>
											<div className="mt-1 font-medium"><DateTooltip date={candidate.updatedAt} /></div>
										</div>
									</div>

									<div className="rounded-lg border p-3">
										<div className="text-sm text-muted-foreground">Description</div>
										<div className="mt-1 whitespace-pre-wrap break-words text-sm">
											{candidate.description || "-"}
										</div>
									</div>

									{candidate.status === "running" ? (
										<div className="rounded-lg border p-3">
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
										</div>
									) : null}

									<div className="rounded-lg border p-3">
										<div className="mb-3 flex items-center justify-between gap-3">
											<div className="text-sm text-muted-foreground">Latest Analysis Result</div>
											{candidate.latestAnalysisResult?.result ? (
												<Badge
													variant="outline"
													className={`capitalize ${getAnalysisResultBadgeClassName(candidate.latestAnalysisResult.result)}`}
												>
													{candidate.latestAnalysisResult.result.replace(/_/g, " ")}
												</Badge>
											) : null}
										</div>
										<div className="grid gap-3 md:grid-cols-2">
											<div className="rounded-md border p-3">
												<div className="text-xs text-muted-foreground">Summary</div>
												<div className="mt-1 whitespace-pre-wrap break-words text-sm">{candidate.latestAnalysisResult?.summary || "-"}</div>
											</div>
											{renderPathCard(
												"Report Path",
												candidate.latestAnalysisResult?.reportPath,
												"Analysis Report Path",
											)}
											<div className="rounded-md border p-3">
												<div className="text-xs text-muted-foreground">Score</div>
												<div className="mt-1 text-sm">
													{typeof candidate.latestAnalysisResult?.score === "number"
														? candidate.latestAnalysisResult.score.toFixed(1)
														: "-"}
												</div>
											</div>
											<div className="rounded-md border p-3">
												<div className="text-xs text-muted-foreground">Confidence</div>
												<div className="mt-1 text-sm">
													{typeof candidate.latestAnalysisResult?.confidence === "number"
														? candidate.latestAnalysisResult.confidence
														: "-"}
												</div>
											</div>
											<div className="rounded-md border p-3">
												<div className="text-xs text-muted-foreground">Runtime Seconds</div>
												<div className="mt-1 text-sm">{candidate.latestAnalysisResult?.runtimeSeconds ?? "-"}</div>
											</div>
											<div className="rounded-md border p-3">
												<div className="text-xs text-muted-foreground">Thread ID</div>
												<div className="mt-1 flex items-center gap-2 break-all text-sm">
													<span>{candidate.latestAnalysisResult?.threadId || "-"}</span>
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
									</div>

									<div className="rounded-lg border p-3">
										<div className="mb-3 flex items-center justify-between gap-3">
											<div className="text-sm text-muted-foreground">Latest Verification Result</div>
											{verificationTruthBadge ? (
												<Badge variant="outline" className={verificationTruthBadge.className}>
													{verificationTruthBadge.label}
												</Badge>
											) : null}
										</div>
										<div className="grid gap-3 md:grid-cols-2">
											<div className="rounded-md border p-3">
												<div className="text-xs text-muted-foreground">Result</div>
												<div className="mt-1 text-sm">{candidate.latestVerificationResult?.result || "-"}</div>
											</div>
											<div className="rounded-md border p-3">
												<div className="text-xs text-muted-foreground">Score</div>
												<div className="mt-1 text-sm">
													{typeof candidate.latestVerificationResult?.score === "number"
														? candidate.latestVerificationResult.score.toFixed(1)
														: "-"}
												</div>
											</div>
											<div className="rounded-md border p-3">
												<div className="text-xs text-muted-foreground">Confidence</div>
												<div className="mt-1 text-sm">
													{typeof candidate.latestVerificationResult?.confidence === "number"
														? candidate.latestVerificationResult.confidence
														: "-"}
												</div>
											</div>
											{renderPathCard(
												"Report Path",
												candidate.latestVerificationResult?.reportPath,
												"Verification Report Path",
											)}
											{renderPathCard(
												"Issue Draft Path",
												candidate.latestVerificationResult?.issueDraftPath,
												"Issue Draft Path",
											)}
											{renderPathCard(
												"PoC Path",
												candidate.latestVerificationResult?.pocPath,
												"PoC Path",
											)}
										</div>
									</div>
								</div>
							)}
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
												onSelectChange={(item) => setSelectedFilePath(item?.id || null)}
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
														{selectedFile?.relativePath || selectedFilePath || "No file selected"}
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
