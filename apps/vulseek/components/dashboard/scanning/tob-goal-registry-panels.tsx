import type { ColumnDef } from "@tanstack/react-table";
import { useRouter } from "next/router";
import { useTranslation } from "next-i18next";
import { useCallback, useMemo } from "react";
import {
	CollectionView,
	EntityDetailSheet,
	StatusBadge,
	useCollectionQuery,
} from "@/components/dashboard/ui-system";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
	detailQueryParam,
	parseDetailId,
	withoutDetailParam,
} from "@/lib/ui-system/detail-query";
import type {
	ListQueryConfig,
	ListQueryState,
} from "@/lib/ui-system/list-query";
import { api, type RouterOutputs } from "@/utils/api";
import { scanT } from "./scan-i18n";

type GoalCandidate =
	RouterOutputs["scan"]["tobGoalCandidates"]["items"][number];
type GoalFinding = RouterOutputs["scan"]["tobGoalFindings"]["items"][number];
type GoalRecord = GoalCandidate | GoalFinding;
type GoalPage<T> = {
	items: T[];
	total: number;
	page: number;
	pageSize: number;
	totalPages: number;
	filterOptions?: { statuses: string[]; huntGoalIds: string[] };
};

const formatDate = (value: string) => new Date(value).toLocaleString();

const formatStatus = (value: string) =>
	value
		.replace(/[_-]/g, " ")
		.replace(/\b\w/g, (letter) => letter.toUpperCase());

const goalConfig = (prefix: string): ListQueryConfig => ({
	prefix,
	sortOptions: [],
	filterKeys: ["status", "huntGoal"],
	allowedFilterValues: { status: [], huntGoal: [] },
	defaultSortKey: "",
	defaultPageSize: 20,
});

/** ListQueryState -> tob-goal registry API request shape. */
const toGoalRequest = (state: ListQueryState) => ({
	query: state.query || undefined,
	status: (state.filters.status ?? []).join(",") || undefined,
	huntGoalId: (state.filters.huntGoal ?? []).join(",") || undefined,
	page: state.page,
	pageSize: state.pageSize,
});

const GoalLocation = ({
	location,
}: {
	location?: { filePath?: string; line?: number | null } | null;
}) => (
	<span className="break-words font-mono text-xs">
		{location?.filePath ?? "Unknown location"}:{location?.line ?? "?"}
	</span>
);

const GoalValue = ({ value }: { value: unknown }) => {
	if (value === null || value === undefined || value === "") {
		return <span className="text-muted-foreground">None</span>;
	}
	if (typeof value === "object") {
		return (
			<pre className="max-h-72 overflow-auto rounded-md bg-muted/50 p-3 font-mono text-xs leading-relaxed">
				{JSON.stringify(value, null, 2)}
			</pre>
		);
	}
	return <span className="break-words text-sm">{String(value)}</span>;
};

const GoalField = ({ label, value }: { label: string; value: unknown }) => (
	<div className="space-y-1.5 border-b pb-4 last:border-0">
		<div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
			{label}
		</div>
		<GoalValue value={value} />
	</div>
);

const GoalDetails = ({
	kind,
	item,
	open,
	onClose,
}: {
	kind: "candidate" | "finding";
	item: GoalRecord | null;
	open: boolean;
	onClose: () => void;
}) => {
	const candidateId = item && "candidateId" in item ? item.candidateId : "";
	const findingId = item && "findingId" in item ? item.findingId : "";
	const candidateQuery = api.scan.tobGoalCandidate.useQuery(
		{ scanJobId: item?.scanJobId ?? "", candidateId },
		{ enabled: kind === "candidate" && item !== null },
	);
	const findingQuery = api.scan.tobGoalFinding.useQuery(
		{ scanJobId: item?.scanJobId ?? "", findingId },
		{ enabled: kind === "finding" && item !== null },
	);
	const record =
		kind === "candidate"
			? (candidateQuery.data ?? (item as GoalCandidate | null))
			: (findingQuery.data ?? (item as GoalFinding | null));
	const content = record?.content;

	return (
		<EntityDetailSheet
			open={open}
			onOpenChange={(next) => (next ? undefined : onClose())}
			title={record?.title ?? (kind === "candidate" ? "Candidate" : "Finding")}
			description={
				record
					? "candidateId" in record
						? record.candidateId
						: record.findingId
					: kind === "candidate"
						? "Goal Candidate"
						: "Goal Finding"
			}
			size="wide"
		>
			{record && content ? (
				<div className="space-y-5">
					<div className="grid gap-4 sm:grid-cols-2">
						<div>
							<div className="text-xs font-semibold uppercase text-muted-foreground">
								Status
							</div>
							<StatusBadge
								value={record.status}
								label={formatStatus(record.status)}
							/>
						</div>
						<div>
							<div className="text-xs font-semibold uppercase text-muted-foreground">
								Hunt goal
							</div>
							<div className="break-words text-sm">{record.huntGoalId}</div>
						</div>
						{"sourceCandidateId" in record ? (
							<div>
								<div className="text-xs font-semibold uppercase text-muted-foreground">
									Source candidate
								</div>
								<div className="break-words font-mono text-xs">
									{record.sourceCandidateId}
								</div>
							</div>
						) : null}
						<div>
							<div className="text-xs font-semibold uppercase text-muted-foreground">
								Updated
							</div>
							<div className="text-sm">{formatDate(record.updatedAt)}</div>
						</div>
						<div className="sm:col-span-2">
							<div className="text-xs font-semibold uppercase text-muted-foreground">
								Location
							</div>
							<GoalLocation location={content.location} />
						</div>
					</div>
					<GoalField label="Summary" value={record.summary} />
					<GoalField label="Description" value={content.description} />
					<GoalField
						label="Vulnerability class"
						value={content.vulnerabilityClass}
					/>
					<GoalField label="Claim" value={content.claim} />
					<GoalField label="Root cause" value={content.rootCauseKey} />
					<GoalField label="Confidence" value={content.confidence} />
					<GoalField label="Attacker control" value={content.attackerControl} />
					<GoalField label="Preconditions" value={content.preconditions} />
					<GoalField label="Evidence" value={content.evidence} />
					<GoalField
						label="Quick disproof attempt"
						value={content.quickDisproofAttempt}
					/>
					{"novelty" in content ? (
						<GoalField label="Novelty" value={content.novelty} />
					) : null}
					{"references" in content ? (
						<GoalField label="References" value={content.references} />
					) : null}
				</div>
			) : null}
		</EntityDetailSheet>
	);
};

type GoalColumn<T> = {
	label: string;
	className?: string;
	render: (item: T) => React.ReactNode;
};

/** Convert goal column descriptors to TanStack columns; first column opens detail. */
const toColumns = <T extends GoalRecord>(
	columns: GoalColumn<T>[],
	onOpen: (item: T) => void,
): ColumnDef<T, unknown>[] =>
	columns.map((column, index) => ({
		id: column.label,
		header: column.label,
		cell: ({ row }) => {
			const content = column.render(row.original);
			return index === 0 ? (
				<button
					type="button"
					onClick={() => onOpen(row.original)}
					className="block w-full text-left hover:text-primary"
				>
					{content}
				</button>
			) : (
				content
			);
		},
		meta: { className: column.className },
	}));

const GoalList = <T extends GoalRecord>({
	title,
	description,
	kind,
	data,
	isLoading,
	isFetching,
	state,
	setState,
	searchInput,
	setSearchInput,
	columns,
	itemKey,
}: {
	title: string;
	description: string;
	kind: "candidate" | "finding";
	data: GoalPage<T> | undefined;
	isLoading: boolean;
	isFetching: boolean;
	state: ListQueryState;
	setState: (updater: (previous: ListQueryState) => ListQueryState) => void;
	searchInput: string;
	setSearchInput: (value: string) => void;
	columns: GoalColumn<T>[];
	itemKey: (item: T) => string;
}) => {
	const router = useRouter();
	const detailId = parseDetailId(router.query);
	const selectedItem =
		data?.items.find((item) => itemKey(item) === detailId) ?? null;
	const detailOpen = detailId !== null;

	const openDetail = useCallback(
		(item: T) => {
			void router.replace(
				{ query: { ...router.query, ...detailQueryParam(itemKey(item)) } },
				undefined,
				{ shallow: true },
			);
		},
		[router, itemKey],
	);

	const closeDetail = useCallback(() => {
		void router.replace(
			{ query: withoutDetailParam(router.query) },
			undefined,
			{ shallow: true },
		);
	}, [router]);

	const filters = useMemo(
		() =>
			[
				...(data?.filterOptions?.statuses.length
					? [
							{
								key: "status",
								label: "Status",
								options: data.filterOptions.statuses.map((value) => ({
									value,
									label: formatStatus(value),
								})),
							},
						]
					: []),
				...(data?.filterOptions?.huntGoalIds.length
					? [
							{
								key: "huntGoal",
								label: "Hunt goal",
								options: data.filterOptions.huntGoalIds.map((value) => ({
									value,
									label: value,
								})),
							},
						]
					: []),
			] as const,
		[data?.filterOptions],
	);

	return (
		<div className="flex flex-col gap-4">
			<p className="text-sm text-muted-foreground">{description}</p>
			<CollectionView
				state={state}
				onStateChange={setState}
				data={{ items: data?.items ?? [], total: data?.total ?? 0 }}
				isLoading={isLoading && !data}
				isRefreshing={isFetching}
				columns={toColumns(columns, openDetail)}
				getRowId={itemKey}
				searchValue={searchInput}
				onSearchValueChange={setSearchInput}
				searchPlaceholder={`Search ${title.toLowerCase()}`}
				filters={filters}
				emptyTitle={`No matching ${title.toLowerCase()}.`}
				emptyDescription="Try adjusting the search or filters."
				onRowClick={openDetail}
			/>
			<GoalDetails
				kind={kind}
				item={selectedItem}
				open={detailOpen}
				onClose={closeDetail}
			/>
		</div>
	);
};

const GOAL_CANDIDATES_CONFIG = goalConfig("goalCandidates");
const GOAL_FINDINGS_CONFIG = goalConfig("goalFindings");

export const TobGoalCandidatesPanel = ({
	scanJobId,
}: {
	scanJobId: string;
}) => {
	const router = useRouter();
	const config = GOAL_CANDIDATES_CONFIG;
	const { state, setState, searchInput, setSearchInput, deferredQuery } =
		useCollectionQuery(router, config);
	const request = useMemo(
		() => toGoalRequest({ ...state, query: deferredQuery }),
		[state, deferredQuery],
	);
	const { data, isLoading, isFetching } = api.scan.tobGoalCandidates.useQuery(
		{ scanJobId, ...request },
		{ refetchInterval: 5000, keepPreviousData: true },
	);
	return (
		<GoalList
			title="Goal Candidates"
			description="Candidate attack paths produced by the goal-directed hunt."
			kind="candidate"
			data={data}
			isLoading={isLoading}
			isFetching={isFetching}
			state={state}
			setState={setState}
			searchInput={searchInput}
			setSearchInput={setSearchInput}
			itemKey={(item) => item.candidateId}
			columns={[
				{
					label: "Candidate",
					className: "min-w-72",
					render: (item: GoalCandidate) => (
						<div>
							<div className="line-clamp-2 font-medium">{item.title}</div>
							<div className="mt-1 break-all font-mono text-xs text-muted-foreground">
								{item.candidateId}
							</div>
						</div>
					),
				},
				{
					label: "Status",
					render: (item: GoalCandidate) => (
						<StatusBadge
							value={item.status}
							label={formatStatus(item.status)}
						/>
					),
				},
				{
					label: "Hunt goal",
					className: "min-w-48",
					render: (item: GoalCandidate) => (
						<span className="break-words">{item.huntGoalId}</span>
					),
				},
				{
					label: "Location",
					className: "min-w-56",
					render: (item: GoalCandidate) => (
						<GoalLocation location={item.content.location} />
					),
				},
				{
					label: "Updated",
					className: "whitespace-nowrap",
					render: (item: GoalCandidate) => formatDate(item.updatedAt),
				},
			]}
		/>
	);
};

const TobGoalThreatDirection = ({ scanJobId }: { scanJobId: string }) => {
	const { t } = useTranslation("scan");
	const { data: job } = api.scan.one.useQuery({ scanJobId });
	const threatDirection =
		job?.scanRuntimeSettings &&
		typeof job.scanRuntimeSettings === "object" &&
		"threatDirection" in job.scanRuntimeSettings
			? (
					job.scanRuntimeSettings as {
						threatDirection?: {
							focus?: string;
							attackerModel?: string;
							notes?: string;
						};
					}
				).threatDirection
			: undefined;
	if (!threatDirection) return null;
	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-base">
					{scanT(t, "scan.goal.threatDirection", "Threat direction")}
				</CardTitle>
			</CardHeader>
			<CardContent className="space-y-1 text-sm text-muted-foreground">
				<div>
					<span className="font-medium text-foreground">
						{scanT(t, "scan.goal.focus", "Focus")}:{" "}
					</span>
					{threatDirection.focus}
				</div>
				<div>
					<span className="font-medium text-foreground">
						{scanT(t, "scan.goal.attackerModel", "Attacker model")}:{" "}
					</span>
					{threatDirection.attackerModel}
				</div>
				{threatDirection.notes ? (
					<div>
						<span className="font-medium text-foreground">
							{scanT(t, "scan.goal.notes", "Notes")}:{" "}
						</span>
						{threatDirection.notes}
					</div>
				) : null}
			</CardContent>
		</Card>
	);
};

export const TobGoalFindingsPanel = ({ scanJobId }: { scanJobId: string }) => {
	const router = useRouter();
	const config = GOAL_FINDINGS_CONFIG;
	const { state, setState, searchInput, setSearchInput, deferredQuery } =
		useCollectionQuery(router, config);
	const request = useMemo(
		() => toGoalRequest({ ...state, query: deferredQuery }),
		[state, deferredQuery],
	);
	const { data, isLoading, isFetching } = api.scan.tobGoalFindings.useQuery(
		{ scanJobId, ...request },
		{ refetchInterval: 5000, keepPreviousData: true },
	);
	return (
		<div className="flex flex-col gap-4">
			<TobGoalThreatDirection scanJobId={scanJobId} />
			<GoalList
				title="Goal Findings"
				description="Novel security findings promoted from goal-directed candidates."
				kind="finding"
				data={data}
				isLoading={isLoading}
				isFetching={isFetching}
				state={state}
				setState={setState}
				searchInput={searchInput}
				setSearchInput={setSearchInput}
				itemKey={(item) => item.findingId}
				columns={[
					{
						label: "Finding",
						className: "min-w-72",
						render: (item: GoalFinding) => (
							<div>
								<div className="line-clamp-2 font-medium">{item.title}</div>
								<div className="mt-1 break-all font-mono text-xs text-muted-foreground">
									{item.findingId}
								</div>
							</div>
						),
					},
					{
						label: "Hunt goal",
						className: "min-w-48",
						render: (item: GoalFinding) => (
							<span className="break-words">{item.huntGoalId}</span>
						),
					},
					{
						label: "Location",
						className: "min-w-56",
						render: (item: GoalFinding) => (
							<GoalLocation location={item.content.location} />
						),
					},
					{
						label: "Status",
						render: (item: GoalFinding) => (
							<StatusBadge
								value={item.status}
								label={formatStatus(item.status)}
							/>
						),
					},
					{
						label: "Updated",
						className: "whitespace-nowrap",
						render: (item: GoalFinding) => formatDate(item.updatedAt),
					},
				]}
			/>
		</div>
	);
};
