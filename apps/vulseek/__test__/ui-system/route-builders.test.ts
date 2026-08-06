import { describe, expect, it } from "vitest";
import {
	datasetScanNavigation,
	projectScanNavigation,
	type ScanNavigationContext,
} from "@/lib/ui-system/route-builders";

const expectContext = (context: ScanNavigationContext) => {
	expect(context.jobHref("job-1")).toBe(`${context.jobsListHref}/job-1`);
	expect(context.taskHref("job-1", "task-2")).toBe(
		`${context.jobsListHref}/job-1/tasks/task-2`,
	);
	expect(context.candidateHref("job-1", "cand-3")).toBe(
		`${context.jobsListHref}/job-1/candidates/cand-3`,
	);
};

describe("projectScanNavigation", () => {
	it("builds profiles/application routes", () => {
		const context = projectScanNavigation({
			kind: "profiles",
			profileType: "application",
			projectId: "p1",
			environmentId: "e2",
			profileId: "a3",
		});
		expect(context.kind).toBe("project");
		expect(context.sourceLabel).toBe("Project");
		expect(context.jobsListHref).toBe(
			"/dashboard/project/p1/environment/e2/profiles/application/a3/jobs",
		);
		expect(context.returnHref).toBe(
			"/dashboard/project/p1/environment/e2/profiles/application/a3",
		);
		expect(context.breadcrumbs[0]).toEqual({
			label: "Projects",
			href: "/dashboard/projects",
		});
		expectContext(context);
	});

	it("builds services/compose routes", () => {
		const context = projectScanNavigation({
			kind: "services",
			profileType: "compose",
			projectId: "p1",
			environmentId: "e2",
			profileId: "c4",
		});
		expect(context.jobsListHref).toBe(
			"/dashboard/project/p1/environment/e2/services/compose/c4/jobs",
		);
		expectContext(context);
	});

	it("encodes id segments", () => {
		const context = projectScanNavigation({
			kind: "profiles",
			profileType: "application",
			projectId: "p 1",
			environmentId: "e/2",
			profileId: "a3",
		});
		expect(context.jobsListHref).toBe(
			"/dashboard/project/p%201/environment/e%2F2/profiles/application/a3/jobs",
		);
	});
});

describe("datasetScanNavigation", () => {
	it("builds dataset job routes", () => {
		const context = datasetScanNavigation("ds-1");
		expect(context.kind).toBe("dataset");
		expect(context.sourceLabel).toBe("Dataset");
		expect(context.jobsListHref).toBe("/dashboard/datasets/jobs");
		expect(context.returnHref).toBe("/dashboard/datasets/ds-1");
		expect(context.breadcrumbs[0]).toEqual({
			label: "Datasets",
			href: "/dashboard/datasets",
		});
		expectContext(context);
	});

	it("accepts an optional dataset name for breadcrumbs", () => {
		const context = datasetScanNavigation("ds-1", { datasetName: "My Data" });
		expect(context.breadcrumbs[1]).toEqual({
			label: "My Data",
			href: "/dashboard/datasets/ds-1",
		});
	});
});
