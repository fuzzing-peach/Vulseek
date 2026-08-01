import { describe, expect, it } from "vitest";
import { apiFindResearchRegistryPageByScanJob } from "../../server/api/schemas/research-registry";

describe("research registry API input", () => {
	it("applies stable pagination and filter defaults", () => {
		expect(
			apiFindResearchRegistryPageByScanJob.parse({ scanJobId: "job-1" }),
		).toEqual({
			scanJobId: "job-1",
			page: 1,
			pageSize: 20,
			query: "",
			status: "",
			statuses: [],
			trustLevels: [],
			sortKey: "updatedAt",
			sortDirection: "desc",
		});
	});

	it("accepts enum filters and a direction for server-side sorting", () => {
		expect(
			apiFindResearchRegistryPageByScanJob.parse({
				scanJobId: "job-1",
				statuses: ["active", "blocked"],
				trustLevels: ["trusted"],
				sortKey: "trackKey",
				sortDirection: "asc",
			}),
		).toMatchObject({
			statuses: ["active", "blocked"],
			trustLevels: ["trusted"],
			sortKey: "trackKey",
			sortDirection: "asc",
		});
	});

	it("rejects missing job IDs and oversized pages", () => {
		expect(() =>
			apiFindResearchRegistryPageByScanJob.parse({ pageSize: 20 }),
		).toThrow();
		expect(() =>
			apiFindResearchRegistryPageByScanJob.parse({
				scanJobId: "job-1",
				pageSize: 101,
			}),
		).toThrow();
	});
});
