import type { ColumnDef } from "@tanstack/react-table";
import { useRouter } from "next/router";
import { useCallback, useMemo } from "react";
import {
	CollectionView,
	EntityDetailSheet,
	StatusBadge,
	useCollectionQuery,
} from "@/components/dashboard/ui-system";
import { TabsContent } from "@/components/ui/tabs";
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
import {
	RESEARCH_REGISTRY_FILTER_OPTIONS,
	RESEARCH_REGISTRY_SORT_OPTIONS,
} from "./research-registry-query-state";
import type { ResearchRegistryTab } from "./research-registry-tabs";

type Track = RouterOutputs["scan"]["researchTracks"]["items"][number];
type Finding = RouterOutputs["scan"]["researchFindings"]["items"][number];
type Primitive = RouterOutputs["scan"]["exploitPrimitives"]["items"][number];
type Chain = RouterOutputs["scan"]["exploitChains"]["items"][number];
type RegistryRecord = Track | Finding | Primitive | Chain;
type RegistryPage<T> = {
	items: T[];
	total: number;
	page: number;
	pageSize: number;
	totalPages: number;
};

const formatDate = (value: string) => new Date(value).toLocaleString();

const formatStatus = (status: string) =>
	status
		.replace(/[_-]/g, " ")
		.replace(/\b\w/g, (letter) => letter.toUpperCase());

const registryConfig = (tab: ResearchRegistryTab): ListQueryConfig => ({
	prefix: tab,
	sortOptions: RESEARCH_REGISTRY_SORT_OPTIONS[tab],
	filterKeys: ["status", "trustLevel"],
	allowedFilterValues: RESEARCH_REGISTRY_FILTER_OPTIONS[tab],
	defaultSortKey: "updatedAt",
	defaultSortDirection: "desc",
	defaultPageSize: 20,
});

/** ListQueryState -> research registry API request shape. */
const toRegistryRequest = (state: ListQueryState) => ({
	query: state.query,
	statuses: state.filters.status ?? [],
	trustLevels: state.filters.trustLevel ?? [],
	sortKey: state.sortKey,
	sortDirection: state.sortDirection,
	page: state.page,
	pageSize: state.pageSize,
});

const JsonValue = ({ value }: { value: unknown }) => {
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

const Field = ({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) => (
	<div className="space-y-1.5 border-b pb-4 last:border-0">
		<div className="font-mono text-xs font-semibold uppercase tracking-wide text-muted-foreground">
			{label}
		</div>
		{children}
	</div>
);

const RegistryDetails = ({
	item,
	title,
	open,
	onClose,
}: {
	item: RegistryRecord | null;
	title: string;
	open: boolean;
	onClose: () => void;
}) => (
	<EntityDetailSheet
		open={open}
		onOpenChange={(next) => (next ? undefined : onClose())}
		title={title}
		description="Persisted Research Registry record for this scan job."
	>
		{item ? (
			<div className="space-y-5">
				{Object.entries(item).map(([key, value]) => (
					<Field key={key} label={key}>
						<JsonValue value={value} />
					</Field>
				))}
			</div>
		) : null}
	</EntityDetailSheet>
);

const FindingDetails = ({
	item,
	open,
	onClose,
}: {
	item: Finding | null;
	open: boolean;
	onClose: () => void;
}) => {
	const detailQuery = api.scan.researchFinding.useQuery(
		{ scanJobId: item?.scanJobId ?? "", findingId: item?.findingId ?? "" },
		{ enabled: item !== null },
	);
	const finding = detailQuery.data ?? item;
	return (
		<EntityDetailSheet
			open={open}
			onOpenChange={(next) => (next ? undefined : onClose())}
			title={finding?.content.title ?? "Finding"}
			description={finding?.findingId ?? "Research Finding"}
			size="wide"
		>
			{finding ? (
				<div className="space-y-5">
					<div className="grid gap-4 sm:grid-cols-2">
						<div>
							<div className="text-xs font-semibold uppercase text-muted-foreground">
								Track
							</div>
							<div className="break-words text-sm">{finding.trackKey}</div>
						</div>
						<div>
							<div className="text-xs font-semibold uppercase text-muted-foreground">
								Status
							</div>
							<StatusBadge
								value={finding.status}
								label={formatStatus(finding.status)}
							/>
						</div>
						<div>
							<div className="text-xs font-semibold uppercase text-muted-foreground">
								Class
							</div>
							<div className="break-words text-sm">
								{finding.content.vulnerabilityClass ?? "Unclassified"}
							</div>
						</div>
						<div>
							<div className="text-xs font-semibold uppercase text-muted-foreground">
								Confidence
							</div>
							<div className="text-sm">{finding.content.confidence}</div>
						</div>
						<div className="sm:col-span-2">
							<div className="text-xs font-semibold uppercase text-muted-foreground">
								Location
							</div>
							<div className="break-words font-mono text-sm">
								{finding.content.location?.filePath ?? "Unknown location"}:
								{finding.content.location?.line ?? "?"}{" "}
								{finding.content.location?.symbol ?? ""}
							</div>
						</div>
					</div>
					<Field label="Description">
						<JsonValue value={finding.content.description} />
					</Field>
					<Field label="Claim">
						<JsonValue value={finding.content.claim} />
					</Field>
					<Field label="Root cause">
						<JsonValue value={finding.content.rootCauseKey} />
					</Field>
					<Field label="Source / sink">
						<JsonValue
							value={{
								source: finding.content.source,
								sink: finding.content.sink,
							}}
						/>
					</Field>
					<Field label="Attacker control and preconditions">
						<JsonValue
							value={{
								attackerControl: finding.content.attackerControl,
								preconditions: finding.content.preconditions,
							}}
						/>
					</Field>
					<Field label="Evidence">
						<JsonValue value={finding.content.evidence} />
					</Field>
					<Field label="Quick disproof attempt">
						<JsonValue value={finding.content.quickDisproofAttempt} />
					</Field>
				</div>
			) : null}
		</EntityDetailSheet>
	);
};

type RegistryColumn<T> = {
	label: string;
	sortKey?: string;
	className?: string;
	render: (item: T) => React.ReactNode;
};

/** Convert registry column descriptors to TanStack columns; first column opens detail. */
const toColumns = <T extends RegistryRecord>(
	columns: RegistryColumn<T>[],
	onOpen: (item: T) => void,
): ColumnDef<T, unknown>[] =>
	columns.map((column, index) => ({
		id: column.sortKey ?? column.label,
		accessorKey: column.sortKey,
		header: column.label,
		cell: ({ row }) => {
			const content = column.render(row.original);
			return index === 0 ? (
				<button
					type="button"
					onClick={() => onOpen(row.original)}
					className="block max-w-full whitespace-normal break-words text-left font-medium text-primary hover:underline [overflow-wrap:anywhere]"
				>
					{content}
				</button>
			) : (
				content
			);
		},
		meta: { className: column.className },
	}));

/**
 * Mobile fallback card for a registry row: the first column becomes the
 * tappable title (opens the route-backed detail), followed by up to three
 * more columns as labeled rows. The trailing "Updated" timestamp is dropped
 * from the card — it lives in the detail sheet. Long values wrap instead of
 * stretching the page.
 */
const registryMobileCard =
	<T extends RegistryRecord>(
		columns: RegistryColumn<T>[],
		onOpen: (item: T) => void,
	) =>
	(item: T) => {
		// Every registry list defines at least a title column.
		const titleColumn = columns[0];
		if (!titleColumn) return null;
		const bodyColumns = columns.slice(1);
		return (
			<div className="rounded-lg border bg-card p-3">
				<button
					type="button"
					onClick={() => onOpen(item)}
					className="block w-full text-left font-medium text-primary hover:underline [overflow-wrap:anywhere]"
				>
					{titleColumn.render(item)}
				</button>
				<div className="mt-2 space-y-1.5">
					{bodyColumns
						.filter((column) => column.label !== "Updated")
						.slice(0, 3)
						.map((column) => (
							<div
								key={column.label}
								className="grid grid-cols-[7rem_1fr] gap-2 text-sm"
							>
								<span className="truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground">
									{column.label}
								</span>
								<span className="min-w-0 break-words [overflow-wrap:anywhere]">
									{column.render(item)}
								</span>
							</div>
						))}
				</div>
			</div>
		);
	};

const RegistryList = <T extends RegistryRecord>({
	title,
	description,
	tab,
	data,
	isLoading,
	isFetching,
	state,
	setState,
	searchInput,
	setSearchInput,
	columns,
	itemKey,
	detailTitle,
	detailRenderer,
}: {
	title: string;
	description: string;
	tab: ResearchRegistryTab;
	data: RegistryPage<T> | undefined;
	isLoading: boolean;
	isFetching: boolean;
	state: ListQueryState;
	setState: (updater: (previous: ListQueryState) => ListQueryState) => void;
	searchInput: string;
	setSearchInput: (value: string) => void;
	columns: RegistryColumn<T>[];
	itemKey: (item: T) => string;
	detailTitle: (item: T) => string;
	detailRenderer?: (item: T | null, onClose: () => void) => React.ReactNode;
}) => {
	const router = useRouter();
	const detailId = parseDetailId(router.query);
	const selectedItem =
		data?.items.find((item) => itemKey(item) === detailId) ?? null;
	const detailOpen = detailId !== null;

	const openDetail = useCallback(
		(item: T) => {
			void router.replace(
				{
					query: { ...router.query, ...detailQueryParam(itemKey(item)) },
				},
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

	const filters = [
		...(RESEARCH_REGISTRY_FILTER_OPTIONS[tab].statuses.length > 0
			? [
					{
						key: "status",
						label: "Status",
						options: RESEARCH_REGISTRY_FILTER_OPTIONS[tab].statuses.map(
							(value) => ({ value, label: formatStatus(value) }),
						),
					},
				]
			: []),
		...(RESEARCH_REGISTRY_FILTER_OPTIONS[tab].trustLevels.length > 0
			? [
					{
						key: "trustLevel",
						label: "Trust level",
						options: RESEARCH_REGISTRY_FILTER_OPTIONS[tab].trustLevels.map(
							(value) => ({ value, label: formatStatus(value) }),
						),
					},
				]
			: []),
	];

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
				mobileRender={registryMobileCard(columns, openDetail)}
				onRowClick={openDetail}
			/>
			{detailRenderer ? (
				detailRenderer(selectedItem, closeDetail)
			) : (
				<RegistryDetails
					item={selectedItem as RegistryRecord | null}
					title={selectedItem ? detailTitle(selectedItem) : title}
					open={detailOpen}
					onClose={closeDetail}
				/>
			)}
		</div>
	);
};

type RegistryPanelProps = {
	scanJobId: string;
	active: boolean;
	live: boolean;
};

const TracksPanel = ({ scanJobId, active, live }: RegistryPanelProps) => {
	const router = useRouter();
	const { state, setState, searchInput, setSearchInput, deferredQuery } =
		useCollectionQuery(router, registryConfig("tracks"));
	const request = useMemo(
		() => toRegistryRequest({ ...state, query: deferredQuery }),
		[state, deferredQuery],
	);
	const query = api.scan.researchTracks.useQuery(
		{ scanJobId, ...request },
		{
			enabled: active,
			keepPreviousData: true,
			refetchInterval: active && live ? 4000 : false,
		},
	);
	return (
		<RegistryList
			title="Tracks"
			description="Research approach families, current coverage, and planned next steps."
			tab="tracks"
			data={query.data}
			isLoading={query.isLoading}
			isFetching={query.isFetching}
			state={state}
			setState={setState}
			searchInput={searchInput}
			setSearchInput={setSearchInput}
			itemKey={(item) => item.trackId}
			detailTitle={(item) => item.trackKey}
			columns={[
				{
					label: "Track",
					sortKey: "trackKey",
					render: (item) => item.trackKey,
				},
				{
					label: "Approach family",
					sortKey: "approachFamily",
					render: (item) => item.approachFamily,
				},
				{
					label: "Research idea",
					sortKey: "researchIdea",
					className: "min-w-64",
					render: (item) => item.researchIdea,
				},
				{
					label: "Status",
					sortKey: "status",
					render: (item) => (
						<StatusBadge
							value={item.status}
							label={formatStatus(item.status)}
						/>
					),
				},
				{
					label: "Iteration",
					sortKey: "iteration",
					render: (item) => item.iteration,
				},
				{
					label: "Updated",
					sortKey: "updatedAt",
					className: "whitespace-nowrap",
					render: (item) => formatDate(item.updatedAt),
				},
			]}
		/>
	);
};

const FindingsPanel = ({ scanJobId, active, live }: RegistryPanelProps) => {
	const router = useRouter();
	const { state, setState, searchInput, setSearchInput, deferredQuery } =
		useCollectionQuery(router, registryConfig("findings"));
	const request = useMemo(
		() => toRegistryRequest({ ...state, query: deferredQuery }),
		[state, deferredQuery],
	);
	const query = api.scan.researchFindings.useQuery(
		{ scanJobId, ...request },
		{
			enabled: active,
			keepPreviousData: true,
			refetchInterval: active && live ? 4000 : false,
		},
	);
	return (
		<RegistryList
			title="Findings"
			description="Evidence-backed security findings discovered by the Research pipeline."
			tab="findings"
			data={query.data}
			isLoading={query.isLoading}
			isFetching={query.isFetching}
			state={state}
			setState={setState}
			searchInput={searchInput}
			setSearchInput={setSearchInput}
			itemKey={(item) => item.findingId}
			detailTitle={(item) => item.content.title}
			detailRenderer={(item, onClose) => (
				<FindingDetails item={item} open={item !== null} onClose={onClose} />
			)}
			columns={[
				{
					label: "Finding",
					sortKey: "title",
					render: (item) => (
						<>
							<span>{item.content.title}</span>
							<div className="mt-1 break-all font-mono text-xs text-muted-foreground">
								{item.findingId}
							</div>
						</>
					),
				},
				{
					label: "Track",
					sortKey: "trackKey",
					render: (item) => item.trackKey,
				},
				{
					label: "Class",
					sortKey: "vulnerabilityClass",
					render: (item) => item.content.vulnerabilityClass ?? "Unclassified",
				},
				{
					label: "Location",
					sortKey: "location",
					render: (item) => (
						<span className="font-mono text-xs">
							{item.content.location?.filePath ?? "Unknown location"}:
							{item.content.location?.line ?? "?"}
						</span>
					),
				},
				{
					label: "Status",
					sortKey: "status",
					render: (item) => (
						<StatusBadge
							value={item.status}
							label={formatStatus(item.status)}
						/>
					),
				},
				{
					label: "Confidence",
					sortKey: "confidence",
					render: (item) => item.content.confidence,
				},
				{
					label: "Updated",
					sortKey: "updatedAt",
					className: "whitespace-nowrap",
					render: (item) => formatDate(item.updatedAt),
				},
			]}
		/>
	);
};

const PrimitivesPanel = ({ scanJobId, active, live }: RegistryPanelProps) => {
	const router = useRouter();
	const { state, setState, searchInput, setSearchInput, deferredQuery } =
		useCollectionQuery(router, registryConfig("primitives"));
	const request = useMemo(
		() => toRegistryRequest({ ...state, query: deferredQuery }),
		[state, deferredQuery],
	);
	const query = api.scan.exploitPrimitives.useQuery(
		{ scanJobId, ...request },
		{
			enabled: active,
			keepPreviousData: true,
			refetchInterval: active && live ? 4000 : false,
		},
	);
	return (
		<RegistryList
			title="Primitives"
			description="Validated exploit capabilities extracted from Research Findings."
			tab="primitives"
			data={query.data}
			isLoading={query.isLoading}
			isFetching={query.isFetching}
			state={state}
			setState={setState}
			searchInput={searchInput}
			setSearchInput={setSearchInput}
			itemKey={(item) => item.primitiveId}
			detailTitle={(item) => item.name}
			columns={[
				{ label: "Primitive", sortKey: "name", render: (item) => item.name },
				{
					label: "Capability",
					sortKey: "capability",
					className: "min-w-64",
					render: (item) => item.capability,
				},
				{
					label: "Finding",
					sortKey: "findingId",
					render: (item) => item.findingId,
				},
				{
					label: "Trust level",
					sortKey: "trustLevel",
					render: (item) => item.trustLevel,
				},
				{
					label: "Status",
					sortKey: "status",
					render: (item) => (
						<StatusBadge
							value={item.status}
							label={formatStatus(item.status)}
						/>
					),
				},
				{
					label: "Updated",
					sortKey: "updatedAt",
					className: "whitespace-nowrap",
					render: (item) => formatDate(item.updatedAt),
				},
			]}
		/>
	);
};

const ChainsPanel = ({ scanJobId, active, live }: RegistryPanelProps) => {
	const router = useRouter();
	const { state, setState, searchInput, setSearchInput, deferredQuery } =
		useCollectionQuery(router, registryConfig("chains"));
	const request = useMemo(
		() => toRegistryRequest({ ...state, query: deferredQuery }),
		[state, deferredQuery],
	);
	const query = api.scan.exploitChains.useQuery(
		{ scanJobId, ...request },
		{
			enabled: active,
			keepPreviousData: true,
			refetchInterval: active && live ? 4000 : false,
		},
	);
	return (
		<RegistryList
			title="Chains"
			description="Composed exploit paths, capability transitions, and unresolved primitive gaps."
			tab="chains"
			data={query.data}
			isLoading={query.isLoading}
			isFetching={query.isFetching}
			state={state}
			setState={setState}
			searchInput={searchInput}
			setSearchInput={setSearchInput}
			itemKey={(item) => item.chainId}
			detailTitle={(item) => item.chainKey}
			columns={[
				{
					label: "Chain",
					sortKey: "chainKey",
					render: (item) => item.chainKey,
				},
				{
					label: "Status",
					sortKey: "status",
					render: (item) => (
						<StatusBadge
							value={item.status}
							label={formatStatus(item.status)}
						/>
					),
				},
				{ label: "Steps", render: (item) => item.steps.length },
				{
					label: "Required capabilities",
					render: (item) => item.requiredCapabilities.length,
				},
				{
					label: "Produced capabilities",
					render: (item) => item.producedCapabilities.length,
				},
				{
					label: "Primitive gaps",
					render: (item) => item.primitiveGaps.length,
				},
				{
					label: "Updated",
					sortKey: "updatedAt",
					className: "whitespace-nowrap",
					render: (item) => formatDate(item.updatedAt),
				},
			]}
		/>
	);
};

export const ResearchRegistryPanels = ({
	scanJobId,
	activeTab,
	live,
}: {
	scanJobId: string;
	activeTab: string;
	live: boolean;
}) => (
	<>
		<TabsContent value="findings" className="pt-2">
			<FindingsPanel
				scanJobId={scanJobId}
				active={activeTab === "findings"}
				live={live}
			/>
		</TabsContent>
		<TabsContent value="tracks" className="pt-2">
			<TracksPanel
				scanJobId={scanJobId}
				active={activeTab === "tracks"}
				live={live}
			/>
		</TabsContent>
		<TabsContent value="primitives" className="pt-2">
			<PrimitivesPanel
				scanJobId={scanJobId}
				active={activeTab === "primitives"}
				live={live}
			/>
		</TabsContent>
		<TabsContent value="chains" className="pt-2">
			<ChainsPanel
				scanJobId={scanJobId}
				active={activeTab === "chains"}
				live={live}
			/>
		</TabsContent>
	</>
);

export const RESEARCH_REGISTRY_TAB_VALUES: ResearchRegistryTab[] = [
	"findings",
	"tracks",
	"primitives",
	"chains",
];
