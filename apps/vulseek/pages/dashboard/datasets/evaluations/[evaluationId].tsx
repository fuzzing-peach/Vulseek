import { Database, Loader2, Pause, Play, Square } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/router";
import { type ReactElement, useState } from "react";
import {
	CollectionSection,
	CollectionView,
	DashboardPage,
	DashboardPageBody,
	DashboardPageHeader,
	DashboardPageTabContent,
	DashboardPageTabs,
	StatusBadge,
	useCollectionQuery,
} from "@/components/dashboard/ui-system";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { BreadcrumbSidebar } from "@/components/shared/breadcrumb-sidebar";
import { CopyValueButton } from "@/components/shared/copy-value-button";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import type { ListQueryConfig } from "@/lib/ui-system/list-query";
import { api } from "@/utils/api";

const TRIALS_CONFIG: ListQueryConfig = {
	prefix: "trials",
	sortOptions: [],
	filterKeys: ["status"],
	allowedFilterValues: { status: [] },
	defaultSortKey: "",
	defaultPageSize: 20,
	pageSizes: [10, 20, 50],
};

const TRIAL_STATUS_OPTIONS = [
	{ value: "pending", label: "Pending" },
	{ value: "preparing", label: "Preparing" },
	{ value: "running", label: "Running" },
	{ value: "completed", label: "Completed" },
	{ value: "scan_failed", label: "Scan failed" },
	{ value: "scoring_failed", label: "Scoring failed" },
	{ value: "timed_out", label: "Timed out" },
	{ value: "canceled", label: "Canceled" },
];

const numberFormat = new Intl.NumberFormat();
const moneyFormat = new Intl.NumberFormat(undefined, {
	style: "currency",
	currency: "USD",
	maximumFractionDigits: 4,
});

const formatDateTime = (value?: string | null) =>
	value ? new Date(value).toLocaleString() : "-";

const STATUS_LABEL = (status: string) =>
	status
		.replace(/[_-]/g, " ")
		.replace(/\b\w/g, (letter) => letter.toUpperCase());

type TrialScoringResult = {
	groundTruthArtifacts: string[];
	jobOutputs: Array<{
		taskId: string;
		stageName: string;
		artifacts: string[];
		hit: boolean;
		matchedGroundTruthArtifacts: string[];
		reason: string;
	}>;
	unmatchedGroundTruthArtifacts: string[];
	summary: string;
};

const readTrialScoringResult = (
	result: Record<string, unknown> | null,
): TrialScoringResult | null => {
	if (!result || typeof result.scoring !== "object" || !result.scoring) {
		return null;
	}
	const scoring = result.scoring as Partial<TrialScoringResult>;
	return Array.isArray(scoring.groundTruthArtifacts) &&
		Array.isArray(scoring.jobOutputs) &&
		Array.isArray(scoring.unmatchedGroundTruthArtifacts) &&
		typeof scoring.summary === "string"
		? (scoring as TrialScoringResult)
		: null;
};

const EvaluationDetailPage = () => {
	const router = useRouter();
	const [selectedScoring, setSelectedScoring] =
		useState<TrialScoringResult | null>(null);
	const evaluationId =
		typeof router.query.evaluationId === "string"
			? router.query.evaluationId
			: "";
	const {
		state: trialState,
		setState: setTrialState,
		searchInput,
		setSearchInput,
		deferredQuery,
	} = useCollectionQuery(router, TRIALS_CONFIG);
	const trialsTab = router.query.tab === "trials";
	const query = api.dataset.evaluations.one.useQuery(
		{ evaluationId },
		{
			enabled: Boolean(evaluationId),
			refetchInterval: (data) =>
				data && ["running", "pending", "paused"].includes(data.status)
					? 3000
					: false,
		},
	);
	const trialList = api.dataset.evaluations.trialsList.useQuery(
		{
			evaluationId,
			page: trialState.page,
			pageSize: trialState.pageSize,
			search: deferredQuery || undefined,
			status: trialState.filters.status?.[0] as
				| "preparing"
				| "pending"
				| "running"
				| "completed"
				| "canceled"
				| "scan_failed"
				| "scoring_failed"
				| "timed_out"
				| undefined,
		},
		{
			enabled: Boolean(evaluationId) && trialsTab,
			keepPreviousData: true,
			refetchInterval: (data) =>
				data?.items.some((trial) =>
					["pending", "preparing", "running"].includes(trial.status),
				)
					? 3000
					: false,
		},
	);
	const pause = api.dataset.pause.useMutation();
	const start = api.dataset.start.useMutation();
	const cancel = api.dataset.cancel.useMutation();
	const refresh = async (action: () => Promise<unknown>) => {
		try {
			await action();
			await query.refetch();
		} catch {}
	};

	if (query.isLoading) {
		return (
			<div className="flex min-h-96 items-center justify-center">
				<Loader2 className="animate-spin" />
			</div>
		);
	}
	if (!query.data)
		return <div className="p-8 text-center">Evaluation not found.</div>;
	const data = query.data;
	const active = ["running", "pending", "paused"].includes(data.status);
	const totals = data.totals;

	return (
		<>
			<Dialog
				open={selectedScoring !== null}
				onOpenChange={(open) => !open && setSelectedScoring(null)}
			>
				<DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
					<DialogHeader>
						<DialogTitle>Ground-truth comparison</DialogTitle>
						<DialogDescription>
							{selectedScoring?.summary ||
								"Per-output comparison against the sample ground truth."}
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-3">
						{selectedScoring?.jobOutputs.map((output) => (
							<div
								key={output.taskId}
								className="rounded-lg border bg-muted/20 p-4"
							>
								<div className="flex flex-wrap items-start justify-between gap-2">
									<div className="min-w-0">
										<div className="font-medium">{output.stageName}</div>
										<div className="break-all font-mono text-xs text-muted-foreground">
											{output.taskId}
										</div>
									</div>
									<StatusBadge
										value={output.hit ? "completed" : "failed"}
										label={output.hit ? "Hit" : "Miss"}
									/>
								</div>
								<p className="mt-3 text-sm text-muted-foreground">
									{output.reason}
								</p>
								<div className="mt-3 grid gap-3 text-xs sm:grid-cols-2">
									<div>
										<div className="font-medium">Output artifacts</div>
										{output.artifacts.length > 0 ? (
											output.artifacts.map((artifact) => (
												<div
													key={artifact}
													className="mt-1 break-all font-mono text-muted-foreground"
												>
													{artifact}
												</div>
											))
										) : (
											<div className="mt-1 text-muted-foreground">None</div>
										)}
									</div>
									<div>
										<div className="font-medium">Matched ground truth</div>
										{output.matchedGroundTruthArtifacts.length > 0 ? (
											output.matchedGroundTruthArtifacts.map((artifact) => (
												<div
													key={artifact}
													className="mt-1 break-all font-mono text-muted-foreground"
												>
													{artifact}
												</div>
											))
										) : (
											<div className="mt-1 text-muted-foreground">None</div>
										)}
									</div>
								</div>
							</div>
						))}
					</div>
				</DialogContent>
			</Dialog>
			<BreadcrumbSidebar
				list={[
					{ name: "Datasets", href: "/dashboard/datasets" },
					{
						name: data.datasetName,
						href: `/dashboard/datasets/${data.datasetId}`,
					},
					{
						name: data.profileKey,
						href: `/dashboard/datasets/${data.datasetId}/profiles/${data.profileId}`,
					},
					{ name: data.name },
				]}
			/>
			<DashboardPage>
				<DashboardPageHeader
					icon={<Database />}
					title={data.name}
					description={
						<span className="flex min-w-0 items-center gap-2 break-all">
							<span className="shrink-0 font-mono text-xs">
								{data.evaluationId}
							</span>
							<CopyValueButton
								value={data.evaluationId}
								label="Evaluation ID"
								className="size-7 shrink-0"
							/>
							<span className="truncate">
								{data.pipelineId} · {data.profileKey} · {data.trialCount} trials
							</span>
						</span>
					}
					status={
						<StatusBadge
							value={data.status}
							label={STATUS_LABEL(data.status)}
						/>
					}
					actions={
						<>
							{data.status === "running" && (
								<Button
									variant="outline"
									size="sm"
									onClick={() =>
										refresh(() => pause.mutateAsync({ evaluationId }))
									}
								>
									<Pause className="size-4" />
									Pause
								</Button>
							)}
							{data.status === "paused" && (
								<Button
									variant="outline"
									size="sm"
									onClick={() =>
										refresh(() => start.mutateAsync({ evaluationId }))
									}
								>
									<Play className="size-4" />
									Resume
								</Button>
							)}
							{active && (
								<Button
									variant="destructive"
									size="sm"
									onClick={() =>
										refresh(() => cancel.mutateAsync({ evaluationId }))
									}
								>
									<Square className="size-4" />
									Cancel
								</Button>
							)}
						</>
					}
				/>
				<DashboardPageTabs
					fallback="overview"
					tabs={[
						{ value: "overview", label: "Overview" },
						{ value: "trials", label: "Trials" },
					]}
				/>
				<DashboardPageBody>
					<DashboardPageTabContent>
						{trialsTab ? (
							<CollectionSection
								title="Trials"
								description="Samples run in round-robin order. Open a Trial's scan Job to inspect its full run."
							>
								<CollectionView
									state={trialState}
									onStateChange={setTrialState}
									data={{
										items: trialList.data?.items ?? [],
										total: trialList.data?.total ?? 0,
									}}
									isLoading={trialList.isLoading && !trialList.data}
									isRefreshing={trialList.isFetching && Boolean(trialList.data)}
									getRowId={(trial) => trial.trialId}
									getRowLabel={(trial) =>
										trial.sample?.title || trial.sample?.id || trial.sampleId
									}
									onRowClick={(trial) => {
										if (!trial.scanJobId) return;
										void router.push(
											`/dashboard/datasets/jobs/${encodeURIComponent(trial.scanJobId)}`,
										);
									}}
									searchValue={searchInput}
									onSearchValueChange={setSearchInput}
									searchPlaceholder="Filter trials..."
									filters={[
										{
											key: "status",
											label: "Status",
											options: TRIAL_STATUS_OPTIONS,
										},
									]}
									emptyTitle="No trials have been created for this Evaluation."
									columns={[
										{
											id: "sample",
											header: "Sample",
											cell: ({ row }) => (
												<div>
													<div className="font-medium">
														{row.original.sample?.title ||
															row.original.sample?.id ||
															row.original.sampleId}
													</div>
													<div className="font-mono text-xs text-muted-foreground">
														{row.original.sample?.id || row.original.sampleId}
													</div>
												</div>
											),
										},
										{
											id: "repetition",
											accessorKey: "repetition",
											header: "Repetition",
										},
										{
											id: "status",
											accessorKey: "status",
											header: "Status",
											cell: ({ row }) => (
												<StatusBadge
													value={row.original.status}
													label={STATUS_LABEL(row.original.status)}
												/>
											),
										},
										{
											id: "duration",
											header: "Duration",
											cell: ({ row }) =>
												row.original.durationMs
													? `${Math.round(row.original.durationMs / 1000)}s`
													: "-",
										},
										{
											id: "tokens",
											header: "Tokens",
											cell: ({ row }) =>
												numberFormat.format(row.original.totalTokens),
										},
										{
											id: "cost",
											header: "Cost",
											cell: ({ row }) =>
												moneyFormat.format(row.original.estimatedCost),
										},
										{
											id: "scoring",
											header: "Ground truth",
											cell: ({ row }) => {
												const scoring = readTrialScoringResult(
													row.original.result,
												);
												if (!scoring) return "-";
												const hits = scoring.jobOutputs.filter(
													(output) => output.hit,
												).length;
												return (
													<Button
														variant="ghost"
														size="sm"
														className="h-8 px-2"
														onClick={() => setSelectedScoring(scoring)}
													>
														{hits}/{scoring.jobOutputs.length} outputs hit
													</Button>
												);
											},
										},
										{
											id: "scanJob",
											header: "Scan Job",
											cell: ({ row }) => {
												const jobHref = row.original.scanJobId
													? `/dashboard/datasets/jobs/${encodeURIComponent(row.original.scanJobId)}`
													: null;
												return (
													<div>
														{jobHref ? (
															<Link
																className="inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline"
																href={jobHref}
															>
																{row.original.scanJobId?.slice(0, 12)}
															</Link>
														) : (
															"-"
														)}
														{row.original.errorMessage && (
															<div className="mt-1 max-w-xs text-xs text-destructive">
																{row.original.errorMessage}
															</div>
														)}
													</div>
												);
											},
										},
									]}
								/>
							</CollectionSection>
						) : (
							<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
								<Card className="sm:col-span-2 xl:col-span-4">
									<CardHeader>
										<CardTitle>Evaluation source</CardTitle>
									</CardHeader>
									<CardContent className="grid gap-4 sm:grid-cols-2">
										<div>
											<div className="text-xs text-muted-foreground">Dataset</div>
											<Link
												className="mt-1 inline-flex text-sm font-medium text-primary hover:underline"
												href={`/dashboard/datasets/${encodeURIComponent(data.datasetId)}`}
											>
												{data.datasetName}
											</Link>
										</div>
										<div>
											<div className="text-xs text-muted-foreground">
												Dataset profile
											</div>
											<Link
												className="mt-1 inline-flex text-sm font-medium text-primary hover:underline"
												href={`/dashboard/datasets/${encodeURIComponent(data.datasetId)}/profiles/${encodeURIComponent(data.profileId)}`}
											>
												{data.profileKey}
											</Link>
										</div>
										<div>
											<div className="text-xs text-muted-foreground">Started</div>
											<div className="mt-1 text-sm font-medium">
												{formatDateTime(data.startedAt)}
											</div>
										</div>
										<div>
											<div className="text-xs text-muted-foreground">Finished</div>
											<div className="mt-1 text-sm font-medium">
												{formatDateTime(data.finishedAt)}
											</div>
										</div>
									</CardContent>
								</Card>
								<Card>
									<CardContent className="p-5">
										<div className="text-xs text-muted-foreground">Trials</div>
										<div className="mt-1 text-xl font-semibold">
											{numberFormat.format(data.trialCount)}
										</div>
									</CardContent>
								</Card>
								<Card>
									<CardContent className="p-5">
										<div className="text-xs text-muted-foreground">
											Total tokens
										</div>
										<div className="mt-1 text-xl font-semibold">
											{numberFormat.format(totals.totalTokens)}
										</div>
									</CardContent>
								</Card>
								<Card>
									<CardContent className="p-5">
										<div className="text-xs text-muted-foreground">
											Total duration
										</div>
										<div className="mt-1 text-xl font-semibold">
											{Math.round(totals.durationMs / 1000).toLocaleString()}s
										</div>
									</CardContent>
								</Card>
								<Card>
									<CardContent className="p-5">
										<div className="text-xs text-muted-foreground">
											Estimated cost
										</div>
										<div className="mt-1 text-xl font-semibold">
											{moneyFormat.format(totals.estimatedCost)}
										</div>
									</CardContent>
								</Card>
								{data.errorMessage && (
									<Card className="sm:col-span-2 xl:col-span-4">
										<CardHeader>
											<CardTitle className="text-destructive">Error</CardTitle>
										</CardHeader>
										<CardContent className="text-sm text-destructive">
											{data.errorMessage}
										</CardContent>
									</Card>
								)}
							</div>
						)}
					</DashboardPageTabContent>
				</DashboardPageBody>
			</DashboardPage>
		</>
	);
};

EvaluationDetailPage.getLayout = (page: ReactElement) => (
	<DashboardLayout>{page}</DashboardLayout>
);
export default EvaluationDetailPage;
