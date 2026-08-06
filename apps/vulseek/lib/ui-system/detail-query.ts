/**
 * Detail query helpers for route-backed detail sheets.
 *
 * Entity detail panels are driven by a `?detail=<id>` query parameter so the
 * panel is refreshable, linkable and closed by browser Back — the list query
 * parameters stay untouched on the same URL.
 */

import type { ParsedUrlQuery } from "node:querystring";

export const DETAIL_QUERY_KEY = "detail";

export const parseDetailId = (
	query: ParsedUrlQuery,
	key: string = DETAIL_QUERY_KEY,
): string | null => {
	const raw = query[key];
	const value = Array.isArray(raw) ? raw[0] : raw;
	return typeof value === "string" && value.length > 0 ? value : null;
};

export const detailQueryParam = (
	id: string,
	key: string = DETAIL_QUERY_KEY,
): Record<string, string> => ({ [key]: id });

/** Strip the detail param so the list state survives on the same URL. */
export const withoutDetailParam = (
	query: ParsedUrlQuery,
	key: string = DETAIL_QUERY_KEY,
): Record<string, string> => {
	const next: Record<string, string> = {};
	for (const [param, value] of Object.entries(query)) {
		if (param === key) continue;
		const normalized = Array.isArray(value) ? value[0] : value;
		if (normalized) next[param] = normalized;
	}
	return next;
};
