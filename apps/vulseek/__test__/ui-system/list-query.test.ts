import { describe, expect, it } from "vitest";
import {
	applyListQuery,
	type ListQueryConfig,
	type ListQueryState,
	parseListQuery,
	withListFilter,
	withListPage,
	withListQuery,
	withListSort,
} from "@/lib/ui-system/list-query";

const config: ListQueryConfig = {
	prefix: "tracks",
	sortOptions: [
		{ value: "updatedAt", label: "Updated" },
		{ value: "title", label: "Title" },
		{ value: "status", label: "Status" },
	],
	filterKeys: ["status", "trustLevel"],
	allowedFilterValues: {
		status: ["running", "failed", "completed"],
		trustLevel: ["trusted", "untrusted"],
	},
	defaultSortKey: "updatedAt",
	defaultSortDirection: "desc",
	defaultPageSize: 20,
	pageSizes: [10, 20, 50, 100],
};

const asQuery = (values: Record<string, string>): Record<string, string[]> =>
	Object.fromEntries(Object.entries(values).map(([k, v]) => [k, [v]]));

describe("parseListQuery", () => {
	it("returns defaults for an empty query", () => {
		const state = parseListQuery({}, config);
		expect(state).toEqual({
			query: "",
			filters: { status: [], trustLevel: [] },
			sortKey: "updatedAt",
			sortDirection: "desc",
			page: 1,
			pageSize: 20,
		});
	});

	it("parses every field with a prefix", () => {
		const state = parseListQuery(
			asQuery({
				tracksQuery: "auth",
				tracksStatus: "running,failed",
				tracksTrustLevel: "trusted",
				tracksSortKey: "title",
				tracksSortDirection: "asc",
				tracksPage: "3",
				tracksPageSize: "50",
			}),
			config,
		);
		expect(state.query).toBe("auth");
		expect(state.filters.status).toEqual(["running", "failed"]);
		expect(state.filters.trustLevel).toEqual(["trusted"]);
		expect(state.sortKey).toBe("title");
		expect(state.sortDirection).toBe("asc");
		expect(state.page).toBe(3);
		expect(state.pageSize).toBe(50);
	});

	it("drops values not in the allowed set and deduplicates", () => {
		const state = parseListQuery(
			asQuery({ tracksStatus: "running,not-allowed,running,unknown" }),
			config,
		);
		expect(state.filters.status).toEqual(["running"]);
	});

	it("clamps invalid page sizes and falls back to the default sort key", () => {
		const state = parseListQuery(
			asQuery({
				tracksPageSize: "9999",
				tracksSortKey: "bogus",
				tracksSortDirection: "sideways",
				tracksPage: "-2",
			}),
			config,
		);
		expect(state.pageSize).toBe(20);
		expect(state.sortKey).toBe("updatedAt");
		expect(state.sortDirection).toBe("desc");
		expect(state.page).toBe(1);
	});

	it("works without a prefix and with open filter values", () => {
		const openConfig: ListQueryConfig = {
			sortOptions: [{ value: "updatedAt", label: "Updated" }],
			filterKeys: ["status"],
			defaultSortKey: "updatedAt",
		};
		const state = parseListQuery(
			asQuery({ Query: "x", Status: "any,thing", Page: "2" }),
			openConfig,
		);
		expect(state.query).toBe("x");
		expect(state.filters.status).toEqual(["any", "thing"]);
		expect(state.page).toBe(2);
	});

	it("supports collections without sorting (empty sortOptions)", () => {
		const noSortConfig: ListQueryConfig = {
			sortOptions: [],
			filterKeys: ["status"],
			defaultSortKey: "",
		};
		const state = parseListQuery(
			asQuery({ Status: "running", SortKey: "x" }),
			noSortConfig,
		);
		expect(state.sortKey).toBe("");
		expect(state.filters.status).toEqual(["running"]);
		// no sort params are ever serialized for unsortable collections
		const next = applyListQuery(
			asQuery({ Status: "running", SortKey: "x" }),
			noSortConfig,
			state,
		);
		expect(next).toEqual({ Status: "running" });
	});
});

describe("applyListQuery", () => {
	it("omits default values so the URL stays minimal", () => {
		const state = parseListQuery({}, config);
		const next = applyListQuery({ existing: "keep" }, config, state);
		expect(next).toEqual({ existing: "keep" });
	});

	it("round-trips through parse", () => {
		const state = parseListQuery(
			asQuery({
				tracksQuery: "auth",
				tracksStatus: "running,failed",
				tracksSortKey: "title",
				tracksSortDirection: "asc",
				tracksPage: "3",
				tracksPageSize: "50",
			}),
			config,
		);
		const next = applyListQuery({}, config, state);
		const reparsed = parseListQuery(asQuery(next), config);
		expect(reparsed).toEqual(state);
	});

	it("strips stale list keys for a tab that no longer applies them", () => {
		const next = applyListQuery(
			asQuery({ tracksQuery: "old", unrelated: "x" }),
			config,
			{ ...parseListQuery({}, config), query: "" },
		);
		expect(next).toEqual({ unrelated: "x" });
	});

	it("serializes explicit defaults as empty (single source of truth)", () => {
		const state: ListQueryState = parseListQuery({}, config);
		expect(applyListQuery({}, config, state)).toEqual({});
	});
});

describe("state transitions reset pagination", () => {
	it("withListQuery resets page to 1", () => {
		const state = { ...parseListQuery({}, config), page: 4 };
		expect(withListQuery(state, "new").page).toBe(1);
		expect(withListQuery(state, "new").query).toBe("new");
	});

	it("withListFilter resets page to 1 and replaces the filter values", () => {
		const state = {
			...parseListQuery(asQuery({ tracksStatus: "running" }), config),
			page: 4,
		};
		const next = withListFilter(state, "status", ["failed", "completed"]);
		expect(next.page).toBe(1);
		expect(next.filters.status).toEqual(["failed", "completed"]);
		expect(next.filters.trustLevel).toEqual([]);
	});

	it("withListSort resets page and toggles direction on the active key", () => {
		const state = { ...parseListQuery({}, config), page: 3 };
		const first = withListSort(state, "title");
		expect(first.page).toBe(1);
		expect(first.sortKey).toBe("title");
		expect(first.sortDirection).toBe("desc");
		const second = withListSort(first, "title");
		expect(second.sortDirection).toBe("asc");
		const third = withListSort(second, "status");
		expect(third.sortKey).toBe("status");
		expect(third.sortDirection).toBe("desc");
	});

	it("withListPage moves without resetting filters", () => {
		const state = parseListQuery(asQuery({ tracksStatus: "running" }), config);
		expect(withListPage(state, 2).page).toBe(2);
		expect(withListPage(state, 2).filters.status).toEqual(["running"]);
	});
});
