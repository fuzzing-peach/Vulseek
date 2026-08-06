import { Database, Loader2, Play, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/router";
import type { FormEvent, ReactElement } from "react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	CollectionSection,
	CollectionView,
	DashboardPage,
	DashboardPageBody,
	DashboardPageHeader,
	DashboardPageTabContent,
	DashboardPageTabs,
	RowList,
	RowListItem,
	StatusBadge,
	useCollectionQuery,
} from "@/components/dashboard/ui-system";
import type { ListQueryStateSetter } from "@/components/dashboard/ui-system/use-collection-query";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { BreadcrumbSidebar } from "@/components/shared/breadcrumb-sidebar";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import type {
	ListQueryConfig,
	ListQueryState,
} from "@/lib/ui-system/list-query";
import { api } from "@/utils/api";

const PROFILE_EVALUATIONS_CONFIG: ListQueryConfig = {
	prefix: "evaluations",
	sortOptions: [],
	filterKeys: [],
	defaultSortKey: "",
	defaultPageSize: 20,
	pageSizes: [10, 20, 50],
};

const PROFILE_STATUS_LABEL = (status: string) =>
	status
		.replace(/[_-]/g, " ")
		.replace(/\b\w/g, (letter) => letter.toUpperCase());

const ProfileDetailPage = () => {
	const router = useRouter();
	const datasetId =
		typeof router.query.datasetId === "string" ? router.query.datasetId : "";
	const profileId =
		typeof router.query.profileId === "string" ? router.query.profileId : "";
	const profile = api.dataset.profiles.one.useQuery(
		{ profileId },
		{ enabled: Boolean(profileId) },
	);
	const { state: evaluationState, setState: setEvaluationState } =
		useCollectionQuery(router, PROFILE_EVALUATIONS_CONFIG);
	const evaluationsTab = router.query.tab === "evaluations";
	const evaluationList = api.dataset.evaluations.list.useQuery(
		{
			profileId,
			page: evaluationState.page,
			pageSize: evaluationState.pageSize,
		},
		{
			enabled: Boolean(profileId) && evaluationsTab,
			keepPreviousData: true,
		},
	);
	const samplesEnabled = profile.data?.status === "ready";
	const [sampleSearch, setSampleSearch] = useState("");
	const [samplePage, setSamplePage] = useState(1);
	const [selectedSampleIds, setSelectedSampleIds] = useState<string[]>([]);
	const [hostRoot, setHostRoot] = useState("");
	const samplePageSize = 20;
	const samples = api.dataset.samples.list.useQuery(
		{
			profileId,
			page: samplePage,
			pageSize: samplePageSize,
			search: sampleSearch || undefined,
		},
		{ enabled: samplesEnabled },
	);
	const updateSelectedSamples =
		api.dataset.profiles.updateSelectedSamples.useMutation();
	const updateHostRoot = api.dataset.profiles.updateHostRoot.useMutation();
	const checkout = api.dataset.profiles.checkout.useMutation();
	const createEvaluation = api.dataset.evaluations.create.useMutation();
	const [evaluationName, setEvaluationName] = useState("Evaluation");
	const [pipelineId, setPipelineId] = useState<
		"full" | "research" | "tob-goal"
	>("research");
	const [repetitions, setRepetitions] = useState(1);
	const [timeBudgetSeconds, setTimeBudgetSeconds] = useState("");

	useEffect(() => {
		if (profile.data?.profileId !== profileId) return;
		setSelectedSampleIds(profile.data.selectedSampleIds);
		setHostRoot(profile.data.hostRoot);
	}, [
		profile.data?.hostRoot,
		profile.data?.profileId,
		profile.data?.selectedSampleIds,
		profileId,
	]);
	// Reset pagination whenever the search input changes intentionally.
	// biome-ignore lint/correctness/useExhaustiveDependencies: search changes reset pagination.
	useEffect(() => {
		setSamplePage(1);
	}, [sampleSearch]);

	const toggleSample = (sampleId: string) => {
		setSelectedSampleIds((current) =>
			current.includes(sampleId)
				? current.filter((id) => id !== sampleId)
				: [...current, sampleId],
		);
	};
	const pageSampleIds = samples.data?.items.map((sample) => sample.id) ?? [];
	const allCurrentPageSelected =
		pageSampleIds.length > 0 &&
		pageSampleIds.every((id) => selectedSampleIds.includes(id));
	const toggleSamplesOnPage = () => {
		setSelectedSampleIds((current) =>
			allCurrentPageSelected
				? current.filter((id) => !pageSampleIds.includes(id))
				: Array.from(new Set([...current, ...pageSampleIds])),
		);
	};
	const saveSelection = async () => {
		try {
			const result = await updateSelectedSamples.mutateAsync({
				profileId,
				sampleIds: selectedSampleIds,
			});
			setSelectedSampleIds(result.selectedSampleIds);
			await profile.refetch();
			toast.success("Sample selection saved");
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Unable to save sample selection",
			);
		}
	};
	const saveHostRoot = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		try {
			const result = await updateHostRoot.mutateAsync({
				profileId,
				hostRoot: hostRoot.trim(),
			});
			setHostRoot(result.hostRoot);
			await profile.refetch();
			toast.success("Local path saved");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Unable to save local path",
			);
		}
	};
	const recheckout = async () => {
		try {
			await checkout.mutateAsync({ profileId });
			const refreshed = await profile.refetch();
			setSelectedSampleIds(refreshed.data?.selectedSampleIds ?? []);
			await samples.refetch();
			toast.success("Profile checkout completed");
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Checkout failed");
		}
	};
	const submitEvaluation = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!profile.data || selectedSampleIds.length === 0) return;
		try {
			await createEvaluation.mutateAsync({
				datasetId,
				profileId,
				name: evaluationName,
				pipelineId,
				sampleIds: selectedSampleIds,
				repetitions,
				timeBudgetSeconds: timeBudgetSeconds ? Number(timeBudgetSeconds) : null,
				scanRuntimeSettings: {},
			});
			await profile.refetch();
			toast.success("Evaluation queued");
			void router.replace(
				{ query: { ...router.query, tab: "evaluations" } },
				undefined,
				{ shallow: true },
			);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Unable to create evaluation",
			);
		}
	};

	if (profile.isLoading) {
		return (
			<div className="flex min-h-96 items-center justify-center">
				<Loader2 className="animate-spin" />
			</div>
		);
	}
	if (!profile.data)
		return <div className="p-8 text-center">Dataset profile not found.</div>;
	const data = profile.data;
	const totalPages = Math.max(
		1,
		Math.ceil((samples.data?.total ?? 0) / samplePageSize),
	);

	return (
		<>
			<BreadcrumbSidebar
				list={[
					{ name: "Datasets", href: "/dashboard/datasets" },
					{
						name: data.datasetName,
						href: `/dashboard/datasets/${datasetId}`,
					},
					{ name: data.profileKey },
				]}
			/>
			<DashboardPage>
				<DashboardPageHeader
					icon={<Database />}
					title={data.profileKey}
					description={`${data.datasetName} · ${data.hostRootSummary || "Local path not configured"}`}
					status={
						<StatusBadge
							value={data.status}
							label={PROFILE_STATUS_LABEL(data.status)}
						/>
					}
					actions={
						data.canManage ? (
							<Button
								variant="outline"
								onClick={recheckout}
								disabled={checkout.isLoading || !data.hostRoot.trim()}
							>
								{checkout.isLoading ? (
									<Loader2 className="size-4 animate-spin" />
								) : (
									<RefreshCw className="size-4" />
								)}
								{data.status === "ready" ? "Re-checkout" : "Checkout"}
							</Button>
						) : undefined
					}
				/>
				<DashboardPageTabs
					fallback="overview"
					tabs={[
						{ value: "overview", label: "Overview" },
						{ value: "evaluations", label: "Evaluations" },
					]}
				/>
				<DashboardPageBody>
					<DashboardPageTabContent>
						{evaluationsTab ? (
							<CollectionSection
								title="Evaluations"
								description="Evaluation runs created from this Profile."
							>
								<ProfileEvaluationsTable
									state={evaluationState}
									onStateChange={setEvaluationState}
									data={evaluationList.data}
									isLoading={evaluationList.isLoading}
									isRefreshing={evaluationList.isFetching}
								/>
							</CollectionSection>
						) : (
							<div className="flex flex-col gap-4">
								<Card>
									<CardHeader>
										<CardTitle>New Evaluation</CardTitle>
										<CardDescription>
											Run the selected pipeline sequentially over the saved
											sample selection.
										</CardDescription>
									</CardHeader>
									<CardContent>
										<form
											onSubmit={submitEvaluation}
											className="grid gap-4 md:grid-cols-5"
										>
											<Input
												className="md:col-span-2"
												value={evaluationName}
												onChange={(event) =>
													setEvaluationName(event.target.value)
												}
												placeholder="Evaluation name"
												required
											/>
											<select
												className="h-10 rounded-md border bg-background px-3"
												value={pipelineId}
												onChange={(event) =>
													setPipelineId(event.target.value as typeof pipelineId)
												}
											>
												<option value="full">Full Scan</option>
												<option value="research">Research</option>
												<option value="tob-goal">Goal</option>
											</select>
											<Input
												type="number"
												min={1}
												max={100}
												value={repetitions}
												onChange={(event) =>
													setRepetitions(Number(event.target.value))
												}
												placeholder="Repetitions"
											/>
											<Input
												type="number"
												min={1}
												max={86400}
												value={timeBudgetSeconds}
												onChange={(event) =>
													setTimeBudgetSeconds(event.target.value)
												}
												placeholder="Time budget (s)"
											/>
											<Button
												type="submit"
												disabled={
													!data.canManage ||
													data.status !== "ready" ||
													selectedSampleIds.length === 0 ||
													createEvaluation.isLoading
												}
											>
												<Play className="size-4" />
												Run Evaluation ({selectedSampleIds.length})
											</Button>
										</form>
									</CardContent>
								</Card>
								<Card>
									<CardHeader>
										<CardTitle>Local Dataset Path</CardTitle>
										<CardDescription>
											Set the directory mounted for this Profile. Checkout is
											separate and runs from the button above.
										</CardDescription>
									</CardHeader>
									<CardContent>
										<form
											onSubmit={saveHostRoot}
											className="flex flex-wrap items-end gap-3"
										>
											<label
												htmlFor="profile-host-root"
												className="grid min-w-0 flex-1 gap-2 text-sm font-medium"
											>
												Absolute local path
												<Input
													id="profile-host-root"
													required
													value={hostRoot}
													onChange={(event) => setHostRoot(event.target.value)}
													placeholder="/data/datasets/example"
												/>
											</label>
											<Button
												type="submit"
												disabled={updateHostRoot.isLoading || !hostRoot.trim()}
											>
												{updateHostRoot.isLoading ? (
													<Loader2 className="size-4 animate-spin" />
												) : null}
												Save Path
											</Button>
										</form>
									</CardContent>
								</Card>
								<Card>
									<CardHeader>
										<CardTitle>Samples</CardTitle>
										<CardDescription>
											{data.sampleCount} prepared samples;{" "}
											{data.selectedSampleCount} selected for evaluation.
										</CardDescription>
									</CardHeader>
									<CardContent className="flex h-[32rem] min-h-0 flex-col">
										{data.status === "ready" && (
											<>
												<div className="mb-3 flex shrink-0 gap-2">
													<Input
														value={sampleSearch}
														onChange={(event) =>
															setSampleSearch(event.target.value)
														}
														placeholder="Search samples"
													/>
													<Button
														type="button"
														variant="outline"
														onClick={() => setSampleSearch("")}
														disabled={!sampleSearch}
													>
														Clear
													</Button>
												</div>
												<div className="mb-3 flex shrink-0 items-center justify-between gap-3 text-xs text-muted-foreground">
													<span>{selectedSampleIds.length} selected</span>
													<div className="flex items-center gap-2">
														<Button
															type="button"
															size="sm"
															variant="ghost"
															onClick={toggleSamplesOnPage}
															disabled={!pageSampleIds.length}
														>
															{allCurrentPageSelected
																? "Clear page"
																: "Select page"}
														</Button>
														<Button
															type="button"
															size="sm"
															onClick={saveSelection}
															disabled={updateSelectedSamples.isLoading}
														>
															{updateSelectedSamples.isLoading ? (
																<Loader2 className="size-4 animate-spin" />
															) : null}
															Save Selection
														</Button>
													</div>
												</div>
											</>
										)}
										{data.status === "preparing" ? (
											<p className="flex-1 text-sm text-muted-foreground">
												Checkout has not been run for this profile. Click
												Checkout above to prepare samples.
											</p>
										) : data.status === "failed" ? (
											<p className="flex-1 text-sm text-destructive">
												Profile checkout failed. Re-checkout to try again.
											</p>
										) : data.status !== "ready" ? (
											<p className="flex-1 text-sm text-muted-foreground">
												No prepared samples.
											</p>
										) : samples.isFetching ? (
											<div className="flex flex-1 items-center justify-center">
												<Loader2 className="animate-spin" />
											</div>
										) : samples.data?.items.length ? (
											<>
												<div className="min-h-0 flex-1 overflow-y-auto pr-2">
													<RowList>
														{samples.data.items.map((sample) => (
															<RowListItem
																asChild
																key={sample.sampleId}
																className={[
																	"cursor-pointer flex-row items-start justify-start gap-3 hover:bg-muted/30 sm:items-center",
																	selectedSampleIds.includes(sample.id)
																		? "border-primary bg-primary/5"
																		: "",
																].join(" ")}
															>
																<label htmlFor={`sample-${sample.sampleId}`}>
																	<Checkbox
																		id={`sample-${sample.sampleId}`}
																		checked={selectedSampleIds.includes(
																			sample.id,
																		)}
																		onCheckedChange={() =>
																			toggleSample(sample.id)
																		}
																		aria-label={`Select sample ${sample.id}`}
																		className="mt-0.5 shrink-0 sm:mt-0"
																	/>
																	<span className="grid min-w-0 flex-1 gap-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] sm:items-center sm:gap-4">
																		<span className="break-words font-medium">
																			{sample.title || sample.id}
																		</span>
																		<span className="break-all font-mono text-xs text-muted-foreground sm:text-right">
																			{sample.id} · {sample.repositoryPath}
																		</span>
																	</span>
																</label>
															</RowListItem>
														))}
													</RowList>
												</div>
												<div className="mt-3 flex shrink-0 flex-col gap-2 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
													<span>{samples.data.total} samples</span>
													<div className="flex items-center gap-2">
														<Button
															type="button"
															size="sm"
															variant="outline"
															disabled={samplePage <= 1}
															onClick={() => setSamplePage((page) => page - 1)}
														>
															Previous
														</Button>
														<span className="whitespace-nowrap">
															Page {samplePage} of {totalPages}
														</span>
														<Button
															type="button"
															size="sm"
															variant="outline"
															disabled={samplePage >= totalPages}
															onClick={() => setSamplePage((page) => page + 1)}
														>
															Next
														</Button>
													</div>
												</div>
											</>
										) : (
											<p className="flex-1 text-sm text-muted-foreground">
												No prepared samples.
											</p>
										)}
									</CardContent>
								</Card>
							</div>
						)}
					</DashboardPageTabContent>
				</DashboardPageBody>
			</DashboardPage>
		</>
	);
};

/** Evaluations tab — shared CollectionView row list backed by the paginated API. */
export const ProfileEvaluationsTable = ({
	state,
	onStateChange,
	data,
	isLoading,
	isRefreshing,
}: {
	state: ListQueryState;
	onStateChange: ListQueryStateSetter;
	data:
		| {
				items: {
					evaluationId: string;
					name: string;
					pipelineId: string | null;
					status: string;
					sampleIds: string[];
					repetitions: number;
				}[];
				total: number;
		  }
		| undefined;
	isLoading?: boolean;
	isRefreshing?: boolean;
}) => (
	<CollectionView
		state={state}
		onStateChange={onStateChange}
		data={{
			items: data?.items ?? [],
			total: data?.total ?? 0,
		}}
		isLoading={isLoading}
		isRefreshing={isRefreshing}
		getRowId={(evaluation) => evaluation.evaluationId}
		getRowLabel={(evaluation) => evaluation.name}
		emptyTitle="No evaluations have been created for this Profile."
		renderRow={(evaluation) => (
			<RowListItem
				asChild
				className="group gap-3 hover:bg-border"
			>
				<Link
					href={`/dashboard/datasets/evaluations/${evaluation.evaluationId}`}
				>
					<span className="min-w-0">
						<span className="block font-medium">{evaluation.name}</span>
						<span className="mt-1 block text-xs capitalize text-muted-foreground">
							Pipeline {evaluation.pipelineId}
						</span>
					</span>
					<span className="flex shrink-0 flex-wrap items-center gap-3 text-xs text-muted-foreground">
						<span>{evaluation.sampleIds.length} samples</span>
						<span>{evaluation.repetitions} repetitions</span>
						<StatusBadge value={evaluation.status} />
					</span>
				</Link>
			</RowListItem>
		)}
	/>
);

ProfileDetailPage.getLayout = (page: ReactElement) => (
	<DashboardLayout>{page}</DashboardLayout>
);
export default ProfileDetailPage;
