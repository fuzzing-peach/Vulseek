/**
 * Tab query helpers — every page-level tab set is URL-backed via `?tab=<value>`.
 * One parser validates against the allowed set and falls back to a default;
 * there is no duplicated local tab state in pages.
 */

import type { ParsedUrlQuery } from "node:querystring";

export const TAB_QUERY_KEY = "tab";

/** Validate a raw `?tab=` value against the allowed set, falling back safely. */
export const parseTabParam = (
	query: ParsedUrlQuery,
	allowed: readonly string[],
	fallback: string,
	key: string = TAB_QUERY_KEY,
): string => {
	const raw = query[key];
	const value = Array.isArray(raw) ? raw[0] : raw;
	if (typeof value === "string" && allowed.includes(value)) return value;
	return fallback;
};

/** Serialize a tab selection into a query fragment (empty when it is the fallback). */
export const tabQueryParam = (
	tab: string,
	fallback: string,
	key: string = TAB_QUERY_KEY,
): Record<string, string> => (tab === fallback ? {} : { [key]: tab });
