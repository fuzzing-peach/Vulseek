import { Database } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/router";
import type { ReactElement } from "react";
import { CreateDatasetProfileDialog } from "@/components/dashboard/datasets/create-dataset-profile-dialog";
import {
	CollectionSection,
	CollectionView,
	DashboardPage,
	DashboardPageBody,
	DashboardPageHeader,
	DashboardPageTabContent,
	DashboardPageTabs,
	ResourceCard,
	RowListItem,
	StatusBadge,
	useCollectionQuery,
} from "@/components/dashboard/ui-system";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { BreadcrumbSidebar } from "@/components/shared/breadcrumb-sidebar";
import { CopyValueButton } from "@/components/shared/copy-value-button";
import type { ListQueryConfig } from "@/lib/ui-system/list-query";
import { parseTabParam } from "@/lib/ui-system/tab-query";
import { api } from "@/utils/api";

const DATASET_TAB_VALUES = ["profiles", "evaluations"] as const;

const PROFILE_STATUS_LABEL = (status: string) =>
	status
		.replace(/[_-]/g, " ")
		.replace(/\b\w/g, (letter) => letter.toUpperCase());

const PROFILES_CONFIG: ListQueryConfig = {
	prefix: "profiles",
	sortOptions: [],
	filterKeys: ["status"],
	allowedFilterValues: { status: [] },
	defaultSortKey: "",
	defaultPageSize: 12,
	pageSizes: [12, 24, 48],
};

const EVALUATIONS_CONFIG: ListQueryConfig = {
	prefix: "evaluations",
	sortOptions: [],
	filterKeys: [],
	defaultSortKey: "",
	defaultPageSize: 12,
	pageSizes: [12, 24, 48],
};

const PROFILE_STATUS_OPTIONS = [
	{ value: "preparing", label: "Preparing" },
	{ value: "ready", label: "Ready" },
	{ value: "failed", label: "Failed" },
];

const DatasetDetailPage = () => {
	const router = useRouter();
	const datasetId =
		typeof router.query.datasetId === "string" ? router.query.datasetId : "";
	const dataset = api.dataset.one.useQuery(
		{ datasetId },
		{ enabled: Boolean(datasetId) },
	);
	const activeTab = parseTabParam(router.query, DATASET_TAB_VALUES, "profiles");
	const evaluationsTab = activeTab === "evaluations";

	const {
		state: profileState,
		setState: setProfileState,
		searchInput: profileSearch,
		setSearchInput: setProfileSearch,
		deferredQuery: deferredProfileSearch,
	} = useCollectionQuery(router, PROFILES_CONFIG);
	const { state: evaluationState, setState: setEvaluationState } =
		useCollectionQuery(router, EVALUATIONS_CONFIG);

	const profileList = api.dataset.profiles.list.useQuery(
		{
			datasetId,
			page: profileState.page,
			pageSize: profileState.pageSize,
			status: profileState.filters.status?.[0] as
				| "preparing"
				| "ready"
				| "failed"
				| undefined,
			search: deferredProfileSearch || undefined,
		},
		{
			enabled: Boolean(datasetId) && !evaluationsTab,
			keepPreviousData: true,
		},
	);
	const evaluationList = api.dataset.evaluations.list.useQuery(
		{
			datasetId,
			page: evaluationState.page,
			pageSize: evaluationState.pageSize,
		},
		{
			enabled: Boolean(datasetId) && evaluationsTab,
			keepPreviousData: true,
		},
	);

	if (dataset.isLoading) {
		return (
			<div className="flex min-h-96 items-center justify-center">
				<span className="text-sm text-muted-foreground">Loading…</span>
			</div>
		);
	}
	if (!dataset.data)
		return <div className="p-8 text-center">Dataset not found.</div>;

	const { data } = dataset;

	return (
		<>
			<BreadcrumbSidebar
				list={[
					{ name: "Datasets", href: "/dashboard/datasets" },
					{ name: data.name },
				]}
			/>
			<DashboardPage>
				<DashboardPageHeader
					icon={<Database />}
					title={data.name}
					description={
						<div className="flex min-w-0 items-center gap-2 break-all">
							<span className="shrink-0 font-mono text-xs">{data.datasetId}</span>
							<CopyValueButton
								value={data.datasetId}
								label="Dataset ID"
								className="size-7 shrink-0"
							/>
							<span className="truncate">
								{data.description || "No description provided"}
							</span>
						</div>
					}
					actions={
						data.canManage ? (
							<CreateDatasetProfileDialog datasetId={datasetId} />
						) : undefined
					}
				/>
				<DashboardPageTabs
					fallback="profiles"
					tabs={[
						{ value: "profiles", label: "Profiles" },
						{ value: "evaluations", label: "Evaluations" },
					]}
				/>
				<DashboardPageBody>
					<DashboardPageTabContent>
						{evaluationsTab ? (
							<CollectionSection
								title="Evaluations"
								description="Evaluation runs created from all profiles in this dataset."
							>
								<CollectionView
									state={evaluationState}
									onStateChange={setEvaluationState}
									pageSizes={EVALUATIONS_CONFIG.pageSizes}
									data={{
										items: evaluationList.data?.items ?? [],
										total: evaluationList.data?.total ?? 0,
									}}
									isLoading={evaluationList.isLoading && !evaluationList.data}
									isRefreshing={
										evaluationList.isFetching && Boolean(evaluationList.data)
									}
									getRowId={(evaluation) => evaluation.evaluationId}
									getRowLabel={(evaluation) => evaluation.name}
									emptyTitle="No evaluations"
									emptyDescription="No evaluations have been created from this dataset's profiles."
									renderRow={(evaluation) => (
										<RowListItem
											asChild
											className="group gap-3 hover:bg-border"
										>
											<Link
												href={`/dashboard/datasets/evaluations/${evaluation.evaluationId}`}
											>
												<span className="min-w-0">
													<span className="block font-medium">
														{evaluation.name}
													</span>
													<span className="text-xs text-muted-foreground">
														Profile {evaluation.profileKey} ·
														{evaluation.pipelineId}
													</span>
												</span>
												<StatusBadge value={evaluation.status} />
											</Link>
										</RowListItem>
									)}
								/>
							</CollectionSection>
						) : (
							<CollectionSection
								title="Profiles"
								description="Prepared dataset states. Select a profile to configure samples and run an evaluation."
							>
								<CollectionView
									state={profileState}
									onStateChange={setProfileState}
									pageSizes={PROFILES_CONFIG.pageSizes}
									data={{
										items: profileList.data?.items ?? [],
										total: profileList.data?.total ?? 0,
									}}
									isLoading={profileList.isLoading && !profileList.data}
									isRefreshing={
										profileList.isFetching && Boolean(profileList.data)
									}
									getRowId={(profile) => profile.profileId}
									getRowLabel={(profile) => profile.profileKey}
									searchValue={profileSearch}
									onSearchValueChange={setProfileSearch}
									searchPlaceholder="Filter profiles..."
									filters={[
										{
											key: "status",
											label: "Status",
											options: PROFILE_STATUS_OPTIONS,
										},
									]}
									emptyTitle="No profiles yet"
									emptyDescription="Create one to prepare samples."
									renderCard={(profile) => (
										<ResourceCard
											key={profile.profileId}
											href={
												"/dashboard/datasets/" +
												datasetId +
												"/profiles/" +
												profile.profileId
											}
											title={profile.profileKey}
											description={
												profile.hostRootSummary || "Local path not configured"
											}
											// Status lives in footer (one line) so card height matches projects
											footer={
												<div className="flex w-full items-center justify-between gap-3 text-xs text-muted-foreground">
													<div className="flex min-w-0 items-center gap-2">
														<StatusBadge
															value={profile.status}
															label={PROFILE_STATUS_LABEL(profile.status)}
														/>
														<span className="truncate">
															{profile.sampleCount} samples
														</span>
													</div>
													<span className="shrink-0 text-foreground/80">
														{profile.selectedSampleCount} selected
													</span>
												</div>
											}
										/>
									)}
								/>
							</CollectionSection>
						)}
					</DashboardPageTabContent>
				</DashboardPageBody>
			</DashboardPage>
		</>
	);
};

DatasetDetailPage.getLayout = (page: ReactElement) => (
	<DashboardLayout>{page}</DashboardLayout>
);
export default DatasetDetailPage;
