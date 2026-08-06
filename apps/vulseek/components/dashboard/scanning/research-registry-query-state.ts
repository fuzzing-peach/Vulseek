import type { ParsedUrlQuery } from "node:querystring";
import {
	applyListQuery,
	type ListQueryConfig,
	type ListQueryState,
	parseListQuery,
} from "@/lib/ui-system/list-query";
import type { ResearchRegistryTab } from "./research-registry-tabs";

/**
 * Thin adapter over the shared ListQuery contract — keeps the registry
 * tab-scoped URL namespace (`findingsQuery`, `findingsStatus`, ...) while
 * reusing the canonical parse/serialize implementation.
 */

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

const configFor = (tab: ResearchRegistryTab): ListQueryConfig => ({
	prefix: tab,
	sortOptions: RESEARCH_REGISTRY_SORT_OPTIONS[tab],
	filterKeys: ["status", "trustLevel"],
	allowedFilterValues: {
		status: RESEARCH_REGISTRY_FILTER_OPTIONS[tab].statuses,
		trustLevel: RESEARCH_REGISTRY_FILTER_OPTIONS[tab].trustLevels,
	},
	defaultSortKey: "updatedAt",
	defaultSortDirection: "desc",
	defaultPageSize: 20,
});

export const parseResearchRegistryListState = (
	query: ParsedUrlQuery,
	tab: ResearchRegistryTab,
): ResearchRegistryListState => {
	const state = parseListQuery(query, configFor(tab));
	return {
		query: state.query,
		statuses: state.filters.status ?? [],
		trustLevels: state.filters.trustLevel ?? [],
		sortKey: state.sortKey,
		sortDirection: state.sortDirection,
		page: state.page,
		pageSize: state.pageSize,
	};
};

export const applyResearchRegistryListState = (
	query: ParsedUrlQuery,
	tab: ResearchRegistryTab,
	state: ResearchRegistryListState,
): Record<string, string> =>
	applyListQuery(query, configFor(tab), toListQueryState(state));

export const toListQueryState = (
	state: ResearchRegistryListState,
): ListQueryState => ({
	query: state.query,
	filters: { status: state.statuses, trustLevel: state.trustLevels },
	sortKey: state.sortKey,
	sortDirection: state.sortDirection,
	page: state.page,
	pageSize: state.pageSize,
});
