import { describe, expect, it } from "vitest";
import {
	applyResearchRegistryListState,
	parseResearchRegistryListState,
} from "../../components/dashboard/scanning/research-registry-query-state";

describe("research registry list query state", () => {
	it("keeps each registry tab's filters and sorting in its own URL namespace", () => {
		const state = parseResearchRegistryListState(
			{
				findingsQuery: "route",
				findingsStatus: "validated,confirmed",
				findingsSortKey: "confidence",
				findingsSortDirection: "asc",
				findingsPage: "3",
				findingsPageSize: "50",
				tracksQuery: "other-tab",
			},
			"findings",
		);

		expect(state).toEqual({
			query: "route",
			statuses: ["validated", "confirmed"],
			trustLevels: [],
			sortKey: "confidence",
			sortDirection: "asc",
			page: 3,
			pageSize: 50,
		});
	});

	it("serializes non-default state without removing unrelated route parameters", () => {
		const result = applyResearchRegistryListState(
			{
				tab: "findings",
				serviceId: "service-1",
				findingsQuery: "old",
				findingsPage: "9",
			},
			"findings",
			{
				query: "route",
				statuses: ["validated", "confirmed"],
				trustLevels: [],
				sortKey: "confidence",
				sortDirection: "asc",
				page: 2,
				pageSize: 50,
			},
		);

		expect(result).toEqual({
			tab: "findings",
			serviceId: "service-1",
			findingsQuery: "route",
			findingsStatus: "validated,confirmed",
			findingsSortKey: "confidence",
			findingsSortDirection: "asc",
			findingsPage: "2",
			findingsPageSize: "50",
		});
	});
});
