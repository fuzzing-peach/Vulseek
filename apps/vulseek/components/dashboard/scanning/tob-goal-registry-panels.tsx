import {
	ChevronLeft,
	ChevronRight,
	ChevronsUpDown,
	Database,
	Loader2,
	Search,
} from "lucide-react";
import { useTranslation } from "next-i18next";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
type GoalListState = {
	query: string;
	statuses: string[];
	huntGoalIds: string[];
	page: number;
	pageSize: number;
};
type GoalColumn<T> = {
	label: string;
	className?: string;
	render: (item: T) => React.ReactNode;
};

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;

const formatDate = (value: string) => new Date(value).toLocaleString();
const toDomId = (value: string) =>
	value.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const formatStatus = (value: string) =>
	value
		.replace(/[_-]/g, " ")
		.replace(/\b\w/g, (letter) => letter.toUpperCase());

const useGoalListState = () => {
	const [state, setState] = useState<GoalListState>({
		query: "",
		statuses: [],
		huntGoalIds: [],
		page: 1,
		pageSize: 20,
	});

	const update = (patch: Partial<GoalListState>, resetPage = false) => {
		setState((current) => ({
			...current,
			...patch,
			...(resetPage ? { page: 1 } : {}),
		}));
	};

	return {
		...state,
		setQuery: (value: string) => update({ query: value }, true),
		setStatuses: (value: string[]) => update({ statuses: value }, true),
		setHuntGoalIds: (value: string[]) => update({ huntGoalIds: value }, true),
		setPage: (value: number) => update({ page: value }),
		setPageSize: (value: number) => update({ pageSize: value }, true),
	};
};

const GoalFilterPopover = ({
	label,
	idPrefix,
	options,
	selected,
	onChange,
}: {
	idPrefix: string;
	label: string;
	options: string[];
	selected: string[];
	onChange: (value: string[]) => void;
}) => {
	if (options.length === 0) return null;
	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button variant="outline" className="justify-between">
					<span>
						{label}
						{selected.length > 0 ? ` (${selected.length})` : ""}
					</span>
					<ChevronsUpDown className="size-4 text-muted-foreground" />
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-72 p-3">
				<div className="mb-3 flex items-center justify-between">
					<div className="text-sm font-medium">{label}</div>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="h-auto px-2 py-1 text-xs"
						onClick={() => onChange([])}
					>
						Clear
					</Button>
				</div>
				<div className="max-h-64 space-y-2 overflow-y-auto">
					{options.map((option) => (
						<label
							key={option}
							htmlFor={`goal-filter-${idPrefix}-${toDomId(label)}-${toDomId(option)}`}
							className="flex cursor-pointer items-center gap-2 text-sm"
						>
							<Checkbox
								id={`goal-filter-${idPrefix}-${toDomId(label)}-${toDomId(option)}`}
								checked={selected.includes(option)}
								onCheckedChange={() =>
									onChange(
										selected.includes(option)
											? selected.filter((item) => item !== option)
											: [...selected, option],
									)
								}
							/>
							<span className="break-words">{formatStatus(option)}</span>
						</label>
					))}
				</div>
			</PopoverContent>
		</Popover>
	);
};

const GoalListToolbar = ({
	title,
	state,
	filterOptions,
}: {
	title: string;
	state: ReturnType<typeof useGoalListState>;
	filterOptions: GoalPage<GoalRecord>["filterOptions"];
}) => (
	<div className="flex flex-col gap-3 rounded-lg border bg-card p-3 lg:flex-row lg:items-center">
		<div className="relative min-w-0 flex-1">
			<Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
			<Input
				value={state.query}
				onChange={(event) => state.setQuery(event.target.value)}
				placeholder={`Search ${title.toLowerCase()}`}
				className="pl-9"
			/>
		</div>
		<div className="flex flex-wrap gap-2">
			<GoalFilterPopover
				label="Status"
				idPrefix={toDomId(title)}
				options={filterOptions?.statuses ?? []}
				selected={state.statuses}
				onChange={state.setStatuses}
			/>
			<GoalFilterPopover
				label="Hunt goal"
				idPrefix={toDomId(title)}
				options={filterOptions?.huntGoalIds ?? []}
				selected={state.huntGoalIds}
				onChange={state.setHuntGoalIds}
			/>
		</div>
	</div>
);

const GoalPagination = <T,>({
	data,
	state,
	idPrefix,
}: {
	data: GoalPage<T> | undefined;
	state: ReturnType<typeof useGoalListState>;
	idPrefix: string;
}) => {
	const total = data?.total ?? 0;
	const page = data?.page ?? state.page;
	const pageSize = data?.pageSize ?? state.pageSize;
	const totalPages = data?.totalPages ?? 1;
	const start = total > 0 ? (page - 1) * pageSize + 1 : 0;
	const end = Math.min(total, page * pageSize);
	return (
		<div className="flex flex-col gap-3 border-t px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
			<div className="text-muted-foreground">
				Showing {start}-{end} of {total}
			</div>
			<div className="flex flex-wrap items-center gap-2">
				<label
					className="text-muted-foreground"
					htmlFor={`goal-page-size-${idPrefix}`}
				>
					Page size
				</label>
				<select
					id={`goal-page-size-${idPrefix}`}
					value={state.pageSize}
					onChange={(event) => state.setPageSize(Number(event.target.value))}
					className="h-9 rounded-md border border-input bg-background px-2 text-sm"
				>
					{PAGE_SIZE_OPTIONS.map((size) => (
						<option key={size} value={size}>
							{size}
						</option>
					))}
				</select>
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={page <= 1}
					onClick={() => state.setPage(Math.max(1, page - 1))}
				>
					<ChevronLeft className="size-4" /> Previous
				</Button>
				<span className="min-w-20 text-center text-muted-foreground">
					Page {page} / {totalPages}
				</span>
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={page >= totalPages}
					onClick={() => state.setPage(Math.min(totalPages, page + 1))}
				>
					Next <ChevronRight className="size-4" />
				</Button>
			</div>
		</div>
	);
};

const GoalList = <T,>({
	title,
	description,
	data,
	isLoading,
	isFetching,
	state,
	columns,
	itemKey,
	detailRenderer,
}: {
	title: string;
	description: string;
	data: GoalPage<T> | undefined;
	isLoading: boolean;
	isFetching: boolean;
	state: ReturnType<typeof useGoalListState>;
	columns: GoalColumn<T>[];
	itemKey: (item: T) => string;
	detailRenderer: (item: T | null, onClose: () => void) => React.ReactNode;
}) => {
	const [selectedItem, setSelectedItem] = useState<T | null>(null);

	return (
		<div className="space-y-3">
			<GoalListToolbar
				title={title}
				state={state}
				filterOptions={data?.filterOptions}
			/>
			<p className="text-sm text-muted-foreground">{description}</p>
			<div
				className={`overflow-hidden rounded-lg border bg-card ${isFetching ? "opacity-60" : ""}`}
			>
				{isLoading && !data ? (
					<div className="flex min-h-56 items-center justify-center gap-2 text-sm text-muted-foreground">
						<Loader2 className="size-4 animate-spin" /> Loading{" "}
						{title.toLowerCase()}...
					</div>
				) : data?.items.length ? (
					<div className="overflow-x-auto">
						<Table className="min-w-[900px]">
							<TableHeader>
								<TableRow>
									{columns.map((column, index) => (
										<TableHead
											key={`${column.label}-${index}`}
											className={column.className}
										>
											{column.label}
										</TableHead>
									))}
								</TableRow>
							</TableHeader>
							<TableBody>
								{data.items.map((item) => (
									<TableRow key={itemKey(item)}>
										{columns.map((column, index) => (
											<TableCell
												key={`${column.label}-${index}`}
												className={[
													"align-top [overflow-wrap:anywhere]",
													column.className,
												]
													.filter(Boolean)
													.join(" ")}
											>
												{index === 0 ? (
													<button
														type="button"
														onClick={() => setSelectedItem(item)}
														className="block w-full text-left hover:text-primary"
													>
														{column.render(item)}
													</button>
												) : (
													column.render(item)
												)}
											</TableCell>
										))}
									</TableRow>
								))}
							</TableBody>
						</Table>
					</div>
				) : (
					<div className="flex min-h-56 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
						<Database className="size-5" />
						{state.query || state.statuses.length || state.huntGoalIds.length
							? `No matching ${title.toLowerCase()}.`
							: `No ${title.toLowerCase()} yet.`}
					</div>
				)}
				<GoalPagination data={data} state={state} idPrefix={toDomId(title)} />
			</div>
			{detailRenderer(selectedItem, () => setSelectedItem(null))}
		</div>
	);
};

const GoalStatus = ({ status }: { status: string }) => (
	<Badge variant="outline" className="whitespace-nowrap">
		{formatStatus(status)}
	</Badge>
);

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
	onClose,
}: {
	kind: "candidate" | "finding";
	item: GoalRecord | null;
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
		<Sheet
			open={item !== null}
			onOpenChange={(open) => (open ? undefined : onClose())}
		>
			<SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
				<SheetHeader>
					<SheetTitle>
						{record?.title ?? (kind === "candidate" ? "Candidate" : "Finding")}
					</SheetTitle>
					<SheetDescription>
						{record
							? "candidateId" in record
								? record.candidateId
								: record.findingId
							: kind === "candidate"
								? "Goal Candidate"
								: "Goal Finding"}
					</SheetDescription>
				</SheetHeader>
				{record && content ? (
					<div className="mt-6 space-y-5">
						<div className="grid gap-4 sm:grid-cols-2">
							<div>
								<div className="text-xs font-semibold uppercase text-muted-foreground">
									Status
								</div>
								<GoalStatus status={record.status} />
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
						<GoalField
							label="Attacker control"
							value={content.attackerControl}
						/>
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
			</SheetContent>
		</Sheet>
	);
};

export const TobGoalCandidatesPanel = ({
	scanJobId,
}: {
	scanJobId: string;
}) => {
	const state = useGoalListState();
	const { data, isLoading, isFetching } = api.scan.tobGoalCandidates.useQuery(
		{
			scanJobId,
			page: state.page,
			pageSize: state.pageSize,
			query: state.query || undefined,
			status: state.statuses.join(",") || undefined,
			huntGoalId: state.huntGoalIds.join(",") || undefined,
		},
		{ refetchInterval: 5000, keepPreviousData: true },
	);
	return (
		<GoalList
			title="Goal Candidates"
			description="Candidate attack paths produced by the goal-directed hunt."
			data={data}
			isLoading={isLoading}
			isFetching={isFetching}
			state={state}
			itemKey={(item) => item.candidateId}
			detailRenderer={(item, onClose) => (
				<GoalDetails kind="candidate" item={item} onClose={onClose} />
			)}
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
					render: (item: GoalCandidate) => <GoalStatus status={item.status} />,
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
	const state = useGoalListState();
	const { data, isLoading, isFetching } = api.scan.tobGoalFindings.useQuery(
		{
			scanJobId,
			page: state.page,
			pageSize: state.pageSize,
			query: state.query || undefined,
			status: state.statuses.join(",") || undefined,
			huntGoalId: state.huntGoalIds.join(",") || undefined,
		},
		{ refetchInterval: 5000, keepPreviousData: true },
	);
	return (
		<div className="space-y-4">
			<TobGoalThreatDirection scanJobId={scanJobId} />
			<GoalList
				title="Goal Findings"
				description="Novel security findings promoted from goal-directed candidates."
				data={data}
				isLoading={isLoading}
				isFetching={isFetching}
				state={state}
				itemKey={(item) => item.findingId}
				detailRenderer={(item, onClose) => (
					<GoalDetails kind="finding" item={item} onClose={onClose} />
				)}
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
						render: (item: GoalFinding) => <GoalStatus status={item.status} />,
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
