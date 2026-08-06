import { Database, Loader2, Pause, Play, Square } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/router";
import type { ReactElement } from "react";
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
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
	{ value: "timed_out", label: "Timed out" },
	{ value: "canceled", label: "Canceled" },
];

const numberFormat = new Intl.NumberFormat();
const moneyFormat = new Intl.NumberFormat(undefined, {
	style: "currency",
	currency: "USD",
	maximumFractionDigits: 4,
});

const STATUS_LABEL = (status: string) =>
	status
		.replace(/[_-]/g, " ")
		.replace(/\b\w/g, (letter) => letter.toUpperCase());

const EvaluationDetailPage = () => {
	const router = useRouter();
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
					description={`${data.pipelineId} · ${data.profileKey} · ${data.trialCount} trials`}
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
