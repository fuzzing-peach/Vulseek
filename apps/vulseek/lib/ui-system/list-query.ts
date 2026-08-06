/**
 * ListQuery — generic URL-backed list state (search / filters / sort / page).
 *
 * The URL is the single source of truth for every growing collection:
 * `q`, per-filter keys, `sort`, `order`, `page`, `pageSize`. Tabs switch by
 * dropping their own prefixed keys, never by stacking long parameter sets.
 *
 * Parameter naming follows the established research-registry convention:
 *   `${prefix}Query`, `${prefix}Status`, `${prefix}SortKey`, `${prefix}Page`, ...
 * prefix defaults to the tab name (e.g. "findings") and is optional.
 */

import type { ParsedUrlQuery } from "node:querystring";
import { DEFAULT_PAGE_SIZES } from "./pagination-contract";

export type ListSortDirection = "asc" | "desc";

export type ListQueryState = {
	/** Free-text search, reflected immediately (debounce only in the request layer). */
	query: string;
	/** Selected values per filter key (e.g. { status: ["running", "failed"] }). */
	filters: Record<string, string[]>;
	sortKey: string;
	sortDirection: ListSortDirection;
	page: number;
	pageSize: number;
};

export type ListSortOption = {
	value: string;
	label: string;
};

export type ListQueryConfig = {
	/** Optional tab prefix for the query parameters (e.g. "tracks" -> `tracksQuery`). */
	prefix?: string;
	sortOptions: readonly ListSortOption[];
	/** Filter keys, e.g. ["status", "trustLevel"]. */
	filterKeys: readonly string[];
	/** Optional allowed values per filter key; empty/missing means any value allowed. */
	allowedFilterValues?: Record<string, readonly string[]>;
	defaultSortKey?: string;
	defaultSortDirection?: ListSortDirection;
	defaultPageSize?: number;
	pageSizes?: readonly number[];
};

const getFirstQueryValue = (value: string | string[] | undefined) => {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value[0] ?? "";
	return "";
};

const normalizeDelimitedValues = (
	value: string,
	allowedValues: readonly string[] | undefined,
) => {
	const allowed = new Set(allowedValues ?? []);
	return [...new Set(value.split(",").map((item) => item.trim()))].filter(
		(item) => item.length > 0 && (allowed.size === 0 || allowed.has(item)),
	);
};

const normalizePositiveInteger = (value: string, fallback: number) => {
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const capitalizeKey = (key: string) =>
	key.length === 0 ? key : `${key.charAt(0).toUpperCase()}${key.slice(1)}`;

/** Parameter key for a filter, e.g. ("", "status") -> "Status". */
export const listFilterParam = (prefix: string, key: string) =>
	`${prefix}${capitalizeKey(key)}`;

/** Parameter key for a plain state field, e.g. ("tracks", "query") -> "tracksQuery". */
export const listFieldParam = (prefix: string, field: string) =>
	`${prefix}${capitalizeKey(field)}`;

export const parseListQuery = (
	query: ParsedUrlQuery,
	config: ListQueryConfig,
): ListQueryState => {
	const {
		prefix = "",
		sortOptions,
		filterKeys,
		allowedFilterValues = {},
		defaultSortKey,
		defaultSortDirection = "desc",
		defaultPageSize = 20,
		pageSizes = DEFAULT_PAGE_SIZES,
	} = config;

	const rawSortKey = getFirstQueryValue(
		query[listFieldParam(prefix, "sortKey")],
	);
	const rawSortDirection = getFirstQueryValue(
		query[listFieldParam(prefix, "sortDirection")],
	);
	const rawPageSize = normalizePositiveInteger(
		getFirstQueryValue(query[listFieldParam(prefix, "pageSize")]),
		defaultPageSize,
	);

	const filters: Record<string, string[]> = {};
	for (const key of filterKeys) {
		const allowed = allowedFilterValues[key] ?? [];
		filters[key] = normalizeDelimitedValues(
			getFirstQueryValue(query[listFilterParam(prefix, key)]),
			allowed,
		);
	}

	// Empty sortOptions means the collection is not sortable; the state then
	// carries an empty sortKey and no sort params are ever written to the URL.
	const resolvedSortKey =
		sortOptions.length === 0
			? ""
			: sortOptions.some((option) => option.value === rawSortKey)
				? rawSortKey
				: (defaultSortKey ?? sortOptions[0]?.value ?? "updatedAt");

	return {
		query: getFirstQueryValue(query[listFieldParam(prefix, "query")]),
		filters,
		sortKey: resolvedSortKey,
		sortDirection: rawSortDirection === "asc" ? "asc" : defaultSortDirection,
		page: normalizePositiveInteger(
			getFirstQueryValue(query[listFieldParam(prefix, "page")]),
			1,
		),
		pageSize: pageSizes.includes(rawPageSize as never)
			? rawPageSize
			: defaultPageSize,
	};
};

/**
 * Serialize a state back onto an existing query, dropping known list keys and
 * omitting values equal to their defaults so the URL stays minimal.
 */
export const applyListQuery = (
	query: ParsedUrlQuery,
	config: ListQueryConfig,
	state: ListQueryState,
): Record<string, string> => {
	const {
		prefix = "",
		filterKeys,
		defaultSortKey,
		defaultSortDirection = "desc",
		defaultPageSize = 20,
	} = config;

	const knownKeys = new Set<string>([
		listFieldParam(prefix, "query"),
		listFieldParam(prefix, "sortKey"),
		listFieldParam(prefix, "sortDirection"),
		listFieldParam(prefix, "page"),
		listFieldParam(prefix, "pageSize"),
		...filterKeys.map((key) => listFilterParam(prefix, key)),
	]);

	const nextQuery: Record<string, string> = {};
	for (const [key, value] of Object.entries(query)) {
		if (knownKeys.has(key)) continue;
		const normalizedValue = getFirstQueryValue(value);
		if (normalizedValue) nextQuery[key] = normalizedValue;
	}

	if (state.query) nextQuery[listFieldParam(prefix, "query")] = state.query;
	for (const key of filterKeys) {
		const values = state.filters[key] ?? [];
		if (values.length > 0) {
			nextQuery[listFilterParam(prefix, key)] = values.join(",");
		}
	}
	const resolvedSortKey = defaultSortKey ?? "";
	if (state.sortKey !== resolvedSortKey && state.sortKey !== "") {
		nextQuery[listFieldParam(prefix, "sortKey")] = state.sortKey;
	}
	if (state.sortDirection !== defaultSortDirection && state.sortKey !== "") {
		nextQuery[listFieldParam(prefix, "sortDirection")] = state.sortDirection;
	}
	if (state.page !== 1)
		nextQuery[listFieldParam(prefix, "page")] = String(state.page);
	if (state.pageSize !== defaultPageSize) {
		nextQuery[listFieldParam(prefix, "pageSize")] = String(state.pageSize);
	}

	return nextQuery;
};

/** Any search/filter/sort change resets pagination to page 1. */
export const resetListPage = (state: ListQueryState): ListQueryState => ({
	...state,
	page: 1,
});

/** Update a filter value and reset to page 1. */
export const withListFilter = (
	state: ListQueryState,
	key: string,
	values: string[],
): ListQueryState => ({
	...resetListPage(state),
	filters: { ...state.filters, [key]: values },
});

/** Update the free-text search and reset to page 1. */
export const withListQuery = (
	state: ListQueryState,
	query: string,
): ListQueryState => resetListPage({ ...state, query });

/** Change sort and reset to page 1; toggling the active key flips direction. */
export const withListSort = (
	state: ListQueryState,
	sortKey: string,
): ListQueryState => ({
	...resetListPage(state),
	sortKey,
	sortDirection:
		state.sortKey === sortKey
			? state.sortDirection === "asc"
				? "desc"
				: "asc"
			: "desc",
});

/** Go to an absolute page number (callers clamp against totals when known). */
export const withListPage = (
	state: ListQueryState,
	page: number,
): ListQueryState => ({ ...state, page });
