import type { ParsedUrlQuery } from "querystring";
import type { ResearchRegistryTab } from "./research-registry-tabs";

export type ResearchRegistrySortDirection = "asc" | "desc";

export type ResearchRegistryListState = {
	query: string;
	statuses: string[];
	trustLevels: string[];
	sortKey: string;
	sortDirection: ResearchRegistrySortDirection;
	page: number;
	pageSize: number;
};

export const RESEARCH_REGISTRY_FILTER_OPTIONS: Record<
	ResearchRegistryTab,
	{ statuses: readonly string[]; trustLevels: readonly string[] }
> = {
	findings: {
		statuses: [
			"discovered",
			"validated",
			"confirmed",
			"needs-more-evidence",
			"false-positive",
			"invalidated",
		],
		trustLevels: [],
	},
	tracks: {
		statuses: ["queued", "active", "blocked", "exhausted", "finding-found"],
		trustLevels: [],
	},
	primitives: {
		statuses: ["confirmed", "needs-more-evidence", "false-positive"],
		trustLevels: ["untrusted", "authenticated", "trusted", "unknown"],
	},
	chains: {
		statuses: [
			"candidate",
			"accepted",
			"revise-chain",
			"primitive-gap",
			"confirmed",
			"runtime-retry",
			"chain-revision",
			"invalidated",
		],
		trustLevels: [],
	},
};

export const RESEARCH_REGISTRY_SORT_OPTIONS: Record<
	ResearchRegistryTab,
	readonly { value: string; label: string }[]
> = {
	findings: [
		{ value: "updatedAt", label: "Updated" },
		{ value: "title", label: "Title" },
		{ value: "trackKey", label: "Track" },
		{ value: "vulnerabilityClass", label: "Class" },
		{ value: "location", label: "Location" },
		{ value: "confidence", label: "Confidence" },
		{ value: "status", label: "Status" },
		{ value: "findingId", label: "Finding ID" },
	],
	tracks: [
		{ value: "updatedAt", label: "Updated" },
		{ value: "trackKey", label: "Track" },
		{ value: "approachFamily", label: "Approach family" },
		{ value: "researchIdea", label: "Research idea" },
		{ value: "status", label: "Status" },
		{ value: "iteration", label: "Iteration" },
	],
	primitives: [
		{ value: "updatedAt", label: "Updated" },
		{ value: "primitiveId", label: "Primitive ID" },
		{ value: "findingId", label: "Finding" },
		{ value: "name", label: "Primitive" },
		{ value: "capability", label: "Capability" },
		{ value: "trustLevel", label: "Trust level" },
		{ value: "status", label: "Status" },
	],
	chains: [
		{ value: "updatedAt", label: "Updated" },
		{ value: "chainId", label: "Chain ID" },
		{ value: "chainKey", label: "Chain" },
		{ value: "status", label: "Status" },
	],
};

const PAGE_SIZES = [10, 20, 50, 100] as const;

const getFirstQueryValue = (value: string | string[] | undefined) => {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value[0] ?? "";
	return "";
};

const normalizeDelimitedValues = (
	value: string,
	allowedValues: readonly string[],
) => {
	const allowed = new Set(allowedValues);
	return [...new Set(value.split(",").map((item) => item.trim()))].filter(
		(item) => item.length > 0 && (allowed.size === 0 || allowed.has(item)),
	);
};

const normalizePositiveInteger = (value: string, fallback: number) => {
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const prefixForTab = (tab: ResearchRegistryTab) => tab;

export const parseResearchRegistryListState = (
	query: ParsedUrlQuery,
	tab: ResearchRegistryTab,
): ResearchRegistryListState => {
	const prefix = prefixForTab(tab);
	const sortOptions = RESEARCH_REGISTRY_SORT_OPTIONS[tab];
	const rawSortKey = getFirstQueryValue(query[`${prefix}SortKey`]);
	const rawSortDirection = getFirstQueryValue(query[`${prefix}SortDirection`]);
	const rawPageSize = normalizePositiveInteger(
		getFirstQueryValue(query[`${prefix}PageSize`]),
		20,
	);

	return {
		query: getFirstQueryValue(query[`${prefix}Query`]),
		statuses: normalizeDelimitedValues(
			getFirstQueryValue(query[`${prefix}Status`]),
			RESEARCH_REGISTRY_FILTER_OPTIONS[tab].statuses,
		),
		trustLevels: normalizeDelimitedValues(
			getFirstQueryValue(query[`${prefix}TrustLevel`]),
			RESEARCH_REGISTRY_FILTER_OPTIONS[tab].trustLevels,
		),
		sortKey: sortOptions.some((option) => option.value === rawSortKey)
			? rawSortKey
			: "updatedAt",
		sortDirection: rawSortDirection === "asc" ? "asc" : "desc",
		page: normalizePositiveInteger(getFirstQueryValue(query[`${prefix}Page`]), 1),
		pageSize: PAGE_SIZES.includes(rawPageSize as (typeof PAGE_SIZES)[number])
			? rawPageSize
			: 20,
	};
};

export const applyResearchRegistryListState = (
	query: ParsedUrlQuery,
	tab: ResearchRegistryTab,
	state: ResearchRegistryListState,
) => {
	const prefix = prefixForTab(tab);
	const keys = new Set([
		`${prefix}Query`,
		`${prefix}Status`,
		`${prefix}TrustLevel`,
		`${prefix}SortKey`,
		`${prefix}SortDirection`,
		`${prefix}Page`,
		`${prefix}PageSize`,
	]);
	const nextQuery: Record<string, string> = {};

	for (const [key, value] of Object.entries(query)) {
		if (keys.has(key)) continue;
		const normalizedValue = getFirstQueryValue(value);
		if (normalizedValue) nextQuery[key] = normalizedValue;
	}

	if (state.query) nextQuery[`${prefix}Query`] = state.query;
	if (state.statuses.length > 0) {
		nextQuery[`${prefix}Status`] = state.statuses.join(",");
	}
	if (state.trustLevels.length > 0) {
		nextQuery[`${prefix}TrustLevel`] = state.trustLevels.join(",");
	}
	if (state.sortKey !== "updatedAt") nextQuery[`${prefix}SortKey`] = state.sortKey;
	if (state.sortDirection !== "desc") {
		nextQuery[`${prefix}SortDirection`] = state.sortDirection;
	}
	if (state.page !== 1) nextQuery[`${prefix}Page`] = String(state.page);
	if (state.pageSize !== 20) nextQuery[`${prefix}PageSize`] = String(state.pageSize);

	return nextQuery;
};
