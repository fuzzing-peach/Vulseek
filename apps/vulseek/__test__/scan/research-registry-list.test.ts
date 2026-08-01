import { describe, expect, it } from "vitest";
import {
	buildResearchRegistryPage,
	normalizeResearchRegistryPageInput,
} from "../../../../packages/server/src/services/scan/persistence/research-registry-list";

describe("research registry list repository", () => {
	it("normalizes pagination and filters before querying", () => {
		expect(
			normalizeResearchRegistryPageInput({
				scanJobId: "job-1",
				page: 0,
				pageSize: 250,
				query: "  parser confusion  ",
			status: "  active  ",
			statuses: ["active", "active", ""],
			trustLevels: ["  untrusted  "],
			sortKey: "trackKey",
			sortDirection: "asc",
		}),
		).toEqual({
			scanJobId: "job-1",
			page: 1,
			pageSize: 100,
			query: "parser confusion",
			status: "active",
			statuses: ["active"],
			trustLevels: ["untrusted"],
			sortKey: "trackKey",
			sortDirection: "asc",
		});
	});

	it("uses safe defaults for missing or invalid sort parameters", () => {
		expect(
			normalizeResearchRegistryPageInput({
				scanJobId: "job-1",
				page: 1,
				pageSize: 20,
				sortKey: "drop-table",
				sortDirection: "sideways",
			}),
		).toMatchObject({ sortKey: "updatedAt", sortDirection: "desc" });
	});

	it("clamps a requested page to the available result pages", () => {
		expect(
			buildResearchRegistryPage({
				items: [{ trackId: "track-21" }],
				total: 21,
				requestedPage: 9,
				pageSize: 20,
			}),
		).toEqual({
			items: [{ trackId: "track-21" }],
			total: 21,
			page: 2,
			pageSize: 20,
			totalPages: 2,
		});
	});

	it("returns page one for an empty registry", () => {
		expect(
			buildResearchRegistryPage({
				items: [],
				total: 0,
				requestedPage: 4,
				pageSize: 20,
			}),
		).toMatchObject({ page: 1, totalPages: 1, total: 0 });
	});
});
