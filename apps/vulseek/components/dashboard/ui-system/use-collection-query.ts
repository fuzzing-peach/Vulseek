import type { NextRouter } from "next/router";
import { useCallback, useDeferredValue, useEffect, useState } from "react";
import {
	applyListQuery,
	type ListQueryConfig,
	type ListQueryState,
	parseListQuery,
} from "@/lib/ui-system/list-query";

/**
 * URL-driven collection state. The URL is the single source of truth:
 * - state is parsed from the router query on every render (no local copy)
 * - updates are pushed back via `router.replace(..., { shallow: true })`
 * - search input echoes immediately; only the *request* layer debounces
 *   (consume `deferredQuery` for the actual query key)
 * - any search/filter/sort change resets the page to 1
 */

/** Functional setter shared by CollectionView and the URL-backed hook. */
export type ListQueryStateSetter = (
	updater: (previous: ListQueryState) => ListQueryState,
) => void;

export const useCollectionQuery = (
	router: NextRouter,
	config: ListQueryConfig,
) => {
	const state = parseListQuery(router.query, config);
	const [pendingQuery, setPendingQuery] = useState(state.query);
	const deferredQuery = useDeferredValue(pendingQuery);

	// Re-sync the echoed input when the URL changes from outside
	// (browser Back/Forward, deep links).
	useEffect(() => {
		setPendingQuery(state.query);
	}, [state.query]);

	const setState = useCallback(
		(updater: (previous: ListQueryState) => ListQueryState) => {
			// Re-derive the current state from the URL inside the callback so
			// the closure never captures a stale query between renders.
			const previous = parseListQuery(router.query, config);
			const next = updater(previous);
			void router.replace(
				{ query: applyListQuery(router.query, config, next) },
				undefined,
				{ shallow: true },
			);
		},
		[router, config],
	);

	const setSearchInput = useCallback(
		(value: string) => {
			setPendingQuery(value);
			setState((previous) => ({ ...previous, query: value, page: 1 }));
		},
		[setState],
	);

	return {
		state,
		setState,
		/** Immediate-echo search input value — bind the search box to this. */
		searchInput: pendingQuery,
		setSearchInput,
		/** Deferred search text — feed the request with this, not `state.query`. */
		deferredQuery,
	};
};
