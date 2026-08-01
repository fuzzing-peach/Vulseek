import {
	ChevronLeft,
	ChevronRight,
	ChevronsUpDown,
	Database,
	Loader2,
	Search,
} from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { TabsContent } from "@/components/ui/tabs";
import { api, type RouterOutputs } from "@/utils/api";
import {
	applyResearchRegistryListState,
	parseResearchRegistryListState,
	RESEARCH_REGISTRY_FILTER_OPTIONS,
	RESEARCH_REGISTRY_SORT_OPTIONS,
	type ResearchRegistryListState,
	type ResearchRegistrySortDirection,
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

type Column<T> = {
	label: string;
	sortKey?: string;
	className?: string;
	render: (item: T) => React.ReactNode;
};

type RegistryListController = ResearchRegistryListState & {
	request: ResearchRegistryListState;
	setPage: (value: number) => void;
	setPageSize: (value: number) => void;
	setQuery: (value: string) => void;
	setStatuses: (value: string[]) => void;
	setTrustLevels: (value: string[]) => void;
	setSort: (key: string, direction: ResearchRegistrySortDirection) => void;
};

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;

const formatDate = (value: string) => new Date(value).toLocaleString();

const formatStatus = (status: string) =>
	status.replace(/[_-]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());

const RegistryStatus = ({ status }: { status: string }) => (
	<Badge variant="outline" className="whitespace-nowrap capitalize">
		{formatStatus(status)}
	</Badge>
);

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

const RegistryDetails = <T extends RegistryRecord>({
	item,
	title,
	onClose,
}: {
	item: T | null;
	title: string;
	onClose: () => void;
}) => (
	<Sheet open={item !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
		<SheetContent className="w-full overflow-y-auto sm:max-w-xl">
			<SheetHeader>
				<SheetTitle>{title}</SheetTitle>
				<SheetDescription>
					Persisted Research Registry record for this scan job.
				</SheetDescription>
			</SheetHeader>
			{item ? (
				<div className="mt-6 space-y-5">
					{Object.entries(item).map(([key, value]) => (
						<div key={key} className="space-y-1.5 border-b pb-4 last:border-0">
							<div className="font-mono text-xs font-semibold uppercase tracking-wide text-muted-foreground">
								{key}
							</div>
							<JsonValue value={value} />
						</div>
					))}
				</div>
			) : null}
		</SheetContent>
	</Sheet>
);

const FindingDetails = ({
	item,
	onClose,
}: {
	item: Finding | null;
	onClose: () => void;
}) => {
	const detailQuery = api.scan.researchFinding.useQuery(
		{ scanJobId: item?.scanJobId ?? "", findingId: item?.findingId ?? "" },
		{ enabled: item !== null },
	);
	const finding = detailQuery.data ?? item;
	return (
		<Sheet open={item !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
			<SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
				<SheetHeader>
					<SheetTitle>{finding?.content.title ?? "Finding"}</SheetTitle>
					<SheetDescription>{finding?.findingId ?? "Research Finding"}</SheetDescription>
				</SheetHeader>
				{finding ? (
					<div className="mt-6 space-y-5">
						<div className="grid gap-4 sm:grid-cols-2">
							<div>
								<div className="text-xs font-semibold uppercase text-muted-foreground">Track</div>
								<div className="break-words text-sm">{finding.trackKey}</div>
							</div>
							<div>
								<div className="text-xs font-semibold uppercase text-muted-foreground">Status</div>
								<RegistryStatus status={finding.status} />
							</div>
							<div>
								<div className="text-xs font-semibold uppercase text-muted-foreground">Class</div>
								<div className="break-words text-sm">{finding.content.vulnerabilityClass ?? "Unclassified"}</div>
							</div>
							<div>
								<div className="text-xs font-semibold uppercase text-muted-foreground">Confidence</div>
								<div className="text-sm">{finding.content.confidence}</div>
							</div>
									<div className="sm:col-span-2">
										<div className="text-xs font-semibold uppercase text-muted-foreground">Location</div>
										<div className="break-words font-mono text-sm">
											{finding.content.location?.filePath ?? "Unknown location"}:{finding.content.location?.line ?? "?"} {finding.content.location?.symbol ?? ""}
										</div>
									</div>
						</div>
						<div className="space-y-1.5 border-b pb-4"><div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Description</div><JsonValue value={finding.content.description} /></div>
						<div className="space-y-1.5 border-b pb-4"><div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Claim</div><JsonValue value={finding.content.claim} /></div>
						<div className="space-y-1.5 border-b pb-4"><div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Root cause</div><JsonValue value={finding.content.rootCauseKey} /></div>
						<div className="space-y-1.5 border-b pb-4"><div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Source / sink</div><JsonValue value={{ source: finding.content.source, sink: finding.content.sink }} /></div>
						<div className="space-y-1.5 border-b pb-4"><div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Attacker control and preconditions</div><JsonValue value={{ attackerControl: finding.content.attackerControl, preconditions: finding.content.preconditions }} /></div>
						<div className="space-y-1.5 border-b pb-4"><div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Evidence</div><JsonValue value={finding.content.evidence} /></div>
						<div className="space-y-1.5 border-b pb-4"><div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Quick disproof attempt</div><JsonValue value={finding.content.quickDisproofAttempt} /></div>
					</div>
				) : null}
			</SheetContent>
		</Sheet>
	);
};

const useRegistryListState = (tab: ResearchRegistryTab): RegistryListController => {
	const router = useRouter();
	const parsedState = useMemo(
		() => parseResearchRegistryListState(router.query, tab),
		[router.query, tab],
	);
	const [state, setState] = useState<ResearchRegistryListState>(parsedState);
	const parsedStateKey = JSON.stringify(parsedState);

	useEffect(() => {
		setState(parsedState);
	}, [parsedStateKey]);

	const updateState = (patch: Partial<ResearchRegistryListState>) => {
		const nextState = { ...state, ...patch };
		setState(nextState);
		if (!router.isReady) return;
		void router.replace(
			{
				pathname: router.pathname,
				query: applyResearchRegistryListState(router.query, tab, nextState),
			},
			undefined,
			{ shallow: true },
		);
	};

	const resetPage = (patch: Partial<ResearchRegistryListState>) =>
		updateState({ ...patch, page: 1 });
	const deferredQuery = useDeferredValue(state.query);

	return {
		...state,
		request: { ...state, query: deferredQuery },
		setPage: (value) => updateState({ page: value }),
		setPageSize: (value) => resetPage({ pageSize: value }),
		setQuery: (value) => resetPage({ query: value }),
		setStatuses: (value) => resetPage({ statuses: value }),
		setTrustLevels: (value) => resetPage({ trustLevels: value }),
		setSort: (key, direction) => resetPage({ sortKey: key, sortDirection: direction }),
	};
};

const RegistryFilterPopover = ({
	label,
	options,
	selected,
	onChange,
}: {
	label: string;
	options: readonly string[];
	selected: string[];
	onChange: (values: string[]) => void;
}) => {
	if (options.length === 0) return null;
	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button variant="outline" className="justify-between">
					<span>{label}{selected.length > 0 ? ` (${selected.length})` : ""}</span>
					<ChevronsUpDown className="size-4 text-muted-foreground" />
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-72 p-3">
				<div className="mb-3 flex items-center justify-between">
					<div className="text-sm font-medium">{label}</div>
					<Button type="button" variant="ghost" size="sm" className="h-auto px-2 py-1 text-xs" onClick={() => onChange([])}>
						Clear
					</Button>
				</div>
				<div className="max-h-64 space-y-2 overflow-y-auto">
					{options.map((value) => (
						<label key={value} className="flex cursor-pointer items-center gap-2 text-sm">
							<Checkbox checked={selected.includes(value)} onCheckedChange={() => onChange(selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value])} />
							<span>{formatStatus(value)}</span>
						</label>
					))}
				</div>
			</PopoverContent>
		</Popover>
	);
};

const RegistryToolbar = ({
	title,
	state,
	tab,
}: {
	title: string;
	state: RegistryListController;
	tab: ResearchRegistryTab;
}) => {
	const filters = RESEARCH_REGISTRY_FILTER_OPTIONS[tab];
	return (
		<div className="flex flex-col gap-3 rounded-lg border bg-card p-3 lg:flex-row lg:items-center lg:justify-between">
			<div>
				<h3 className="font-semibold">{title}</h3>
			</div>
			<div className="flex w-full flex-wrap gap-2 lg:w-auto lg:min-w-[520px]">
				<div className="relative min-w-[240px] flex-1">
					<Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
					<Input value={state.query} onChange={(event) => state.setQuery(event.target.value)} placeholder={`Search ${title.toLowerCase()}`} className="pl-9" />
				</div>
				<RegistryFilterPopover label="Status" options={filters.statuses} selected={state.statuses} onChange={state.setStatuses} />
				<RegistryFilterPopover label="Trust level" options={filters.trustLevels} selected={state.trustLevels} onChange={state.setTrustLevels} />
			</div>
		</div>
	);
};

const RegistryPagination = <T,>({
	title,
	data,
	state,
}: {
	title: string;
	data: RegistryPage<T> | undefined;
	state: RegistryListController;
}) => {
	const total = data?.total ?? 0;
	const page = data?.page ?? state.page;
	const pageSize = data?.pageSize ?? state.pageSize;
	const totalPages = data?.totalPages ?? 1;
	const start = total > 0 ? (page - 1) * pageSize + 1 : 0;
	const end = Math.min(total, page * pageSize);

	return (
		<div className="flex flex-col gap-3 border-t px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
			<div className="text-muted-foreground">Showing {start}-{end} of {total}</div>
			<div className="flex flex-wrap items-center gap-2">
				<label htmlFor={`${title}-page-size`} className="text-muted-foreground">Page size</label>
				<select id={`${title}-page-size`} value={state.pageSize} onChange={(event) => state.setPageSize(Number(event.target.value))} className="h-9 rounded-md border border-input bg-background px-2">
					{PAGE_SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size}</option>)}
				</select>
				<Button type="button" variant="outline" size="sm" disabled={page <= 1} onClick={() => state.setPage(Math.max(1, page - 1))}><ChevronLeft className="size-4" /> Previous</Button>
				<span className="min-w-20 text-center text-muted-foreground">Page {page} / {totalPages}</span>
				<Button type="button" variant="outline" size="sm" disabled={page >= totalPages} onClick={() => state.setPage(Math.min(totalPages, page + 1))}>Next <ChevronRight className="size-4" /></Button>
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
	columns,
	itemKey,
	detailTitle,
	state,
	detailRenderer,
}: {
	title: string;
	description: string;
	tab: ResearchRegistryTab;
	data: RegistryPage<T> | undefined;
	isLoading: boolean;
	isFetching: boolean;
	columns: Column<T>[];
	itemKey: (item: T) => string;
	detailTitle: (item: T) => string;
	state: RegistryListController;
	detailRenderer?: (item: T | null, onClose: () => void) => React.ReactNode;
}) => {
	const [selectedItem, setSelectedItem] = useState<T | null>(null);

	return (
		<div className="space-y-3">
			<RegistryToolbar title={title} state={state} tab={tab} />
			<p className="mt-1 text-sm text-muted-foreground">{description}</p>
			<div className={`overflow-hidden rounded-lg border bg-card ${isFetching ? "opacity-60" : ""}`}>
				{isLoading && !data ? (
					<div className="flex min-h-56 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading {title.toLowerCase()}...</div>
				) : data?.items.length ? (
					<Table>
						<TableHeader>
							<TableRow>
								{columns.map((column) => (
									<TableHead key={column.label} className={column.className}>
										{column.sortKey ? (
											<Button type="button" variant="ghost" className="h-auto gap-1 p-0 font-medium" onClick={() => state.setSort(column.sortKey as string, state.sortKey === column.sortKey && state.sortDirection === "asc" ? "desc" : "asc")}>
												{column.label}<ChevronsUpDown className="size-3.5 text-muted-foreground" />
											</Button>
										) : column.label}
									</TableHead>
								))}
							</TableRow>
						</TableHeader>
						<TableBody>
							{data.items.map((item) => (
								<TableRow key={itemKey(item)}>
									{columns.map((column, index) => (
										<TableCell key={column.label} className={["align-top [overflow-wrap:anywhere]", column.className].filter(Boolean).join(" ")}>
											{index === 0 ? (
												<button type="button" onClick={() => setSelectedItem(item)} className="block max-w-full whitespace-normal break-words [overflow-wrap:anywhere] text-left font-medium text-primary hover:underline">
													{column.render(item)}
												</button>
											) : column.render(item)}
										</TableCell>
									))}
								</TableRow>
							))}
						</TableBody>
					</Table>
				) : (
					<div className="flex min-h-56 flex-col items-center justify-center gap-2 text-sm text-muted-foreground"><Database className="size-5" /> No matching {title.toLowerCase()}.</div>
				)}
				<RegistryPagination title={title} data={data} state={state} />
			</div>
			{detailRenderer ? detailRenderer(selectedItem, () => setSelectedItem(null)) : <RegistryDetails item={selectedItem} title={selectedItem ? detailTitle(selectedItem) : title} onClose={() => setSelectedItem(null)} />}
		</div>
	);
};

type RegistryPanelProps = {
	scanJobId: string;
	active: boolean;
	live: boolean;
};

const TracksPanel = ({ scanJobId, active, live }: RegistryPanelProps) => {
	const state = useRegistryListState("tracks");
	const query = api.scan.researchTracks.useQuery({ scanJobId, ...state.request }, { enabled: active, keepPreviousData: true, refetchInterval: active && live ? 4000 : false });
	return <RegistryList title="Tracks" description="Research approach families, current coverage, and planned next steps." tab="tracks" data={query.data} isLoading={query.isLoading} isFetching={query.isFetching} state={state} itemKey={(item) => item.trackId} detailTitle={(item) => item.trackKey} columns={[
		{ label: "Track", sortKey: "trackKey", render: (item) => item.trackKey },
		{ label: "Approach family", sortKey: "approachFamily", render: (item) => item.approachFamily },
		{ label: "Research idea", sortKey: "researchIdea", className: "min-w-64", render: (item) => item.researchIdea },
		{ label: "Status", sortKey: "status", render: (item) => <RegistryStatus status={item.status} /> },
		{ label: "Iteration", sortKey: "iteration", render: (item) => item.iteration },
		{ label: "Updated", sortKey: "updatedAt", className: "whitespace-nowrap", render: (item) => formatDate(item.updatedAt) },
	]} />;
};

const FindingsPanel = ({ scanJobId, active, live }: RegistryPanelProps) => {
	const state = useRegistryListState("findings");
	const query = api.scan.researchFindings.useQuery({ scanJobId, ...state.request }, { enabled: active, keepPreviousData: true, refetchInterval: active && live ? 4000 : false });
	return <RegistryList title="Findings" description="Evidence-backed security findings discovered by the Research pipeline." tab="findings" data={query.data} isLoading={query.isLoading} isFetching={query.isFetching} state={state} itemKey={(item) => item.findingId} detailTitle={(item) => item.content.title} detailRenderer={(item, onClose) => <FindingDetails item={item} onClose={onClose} />} columns={[
		{ label: "Finding", sortKey: "title", render: (item) => <><span>{item.content.title}</span><div className="mt-1 break-all font-mono text-xs text-muted-foreground">{item.findingId}</div></> },
		{ label: "Track", sortKey: "trackKey", render: (item) => item.trackKey },
		{ label: "Class", sortKey: "vulnerabilityClass", render: (item) => item.content.vulnerabilityClass ?? "Unclassified" },
		{ label: "Location", sortKey: "location", render: (item) => <span className="font-mono text-xs">{item.content.location?.filePath ?? "Unknown location"}:{item.content.location?.line ?? "?"}</span> },
		{ label: "Status", sortKey: "status", render: (item) => <RegistryStatus status={item.status} /> },
		{ label: "Confidence", sortKey: "confidence", render: (item) => item.content.confidence },
		{ label: "Updated", sortKey: "updatedAt", className: "whitespace-nowrap", render: (item) => formatDate(item.updatedAt) },
	]} />;
};

const PrimitivesPanel = ({ scanJobId, active, live }: RegistryPanelProps) => {
	const state = useRegistryListState("primitives");
	const query = api.scan.exploitPrimitives.useQuery({ scanJobId, ...state.request }, { enabled: active, keepPreviousData: true, refetchInterval: active && live ? 4000 : false });
	return <RegistryList title="Primitives" description="Validated exploit capabilities extracted from Research Findings." tab="primitives" data={query.data} isLoading={query.isLoading} isFetching={query.isFetching} state={state} itemKey={(item) => item.primitiveId} detailTitle={(item) => item.name} columns={[
		{ label: "Primitive", sortKey: "name", render: (item) => item.name },
		{ label: "Capability", sortKey: "capability", className: "min-w-64", render: (item) => item.capability },
		{ label: "Finding", sortKey: "findingId", render: (item) => item.findingId },
		{ label: "Trust level", sortKey: "trustLevel", render: (item) => item.trustLevel },
		{ label: "Status", sortKey: "status", render: (item) => <RegistryStatus status={item.status} /> },
		{ label: "Updated", sortKey: "updatedAt", className: "whitespace-nowrap", render: (item) => formatDate(item.updatedAt) },
	]} />;
};

const ChainsPanel = ({ scanJobId, active, live }: RegistryPanelProps) => {
	const state = useRegistryListState("chains");
	const query = api.scan.exploitChains.useQuery({ scanJobId, ...state.request }, { enabled: active, keepPreviousData: true, refetchInterval: active && live ? 4000 : false });
	return <RegistryList title="Chains" description="Composed exploit paths, capability transitions, and unresolved primitive gaps." tab="chains" data={query.data} isLoading={query.isLoading} isFetching={query.isFetching} state={state} itemKey={(item) => item.chainId} detailTitle={(item) => item.chainKey} columns={[
		{ label: "Chain", sortKey: "chainKey", render: (item) => item.chainKey },
		{ label: "Status", sortKey: "status", render: (item) => <RegistryStatus status={item.status} /> },
		{ label: "Steps", render: (item) => item.steps.length },
		{ label: "Required capabilities", render: (item) => item.requiredCapabilities.length },
		{ label: "Produced capabilities", render: (item) => item.producedCapabilities.length },
		{ label: "Primitive gaps", render: (item) => item.primitiveGaps.length },
		{ label: "Updated", sortKey: "updatedAt", className: "whitespace-nowrap", render: (item) => formatDate(item.updatedAt) },
	]} />;
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
		<TabsContent value="findings" className="pt-2"><FindingsPanel scanJobId={scanJobId} active={activeTab === "findings"} live={live} /></TabsContent>
		<TabsContent value="tracks" className="pt-2"><TracksPanel scanJobId={scanJobId} active={activeTab === "tracks"} live={live} /></TabsContent>
		<TabsContent value="primitives" className="pt-2"><PrimitivesPanel scanJobId={scanJobId} active={activeTab === "primitives"} live={live} /></TabsContent>
		<TabsContent value="chains" className="pt-2"><ChainsPanel scanJobId={scanJobId} active={activeTab === "chains"} live={live} /></TabsContent>
	</>
);

export const RESEARCH_REGISTRY_TAB_VALUES: ResearchRegistryTab[] = [
	"findings",
	"tracks",
	"primitives",
	"chains",
];
