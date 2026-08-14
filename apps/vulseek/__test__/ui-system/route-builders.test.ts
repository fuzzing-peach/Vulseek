import { describe, expect, it } from "vitest";
import {
	datasetScanNavigation,
	datasetTrialScanNavigation,
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

	it("builds a resource-only breadcrumb hierarchy without duplicate job links", () => {
		const context = projectScanNavigation(
			{
				kind: "profiles",
				profileType: "application",
				projectId: "p1",
				environmentId: "e2",
				profileId: "a3",
			},
			{
				projectName: "Project One",
				environmentName: "Production",
				profileName: "API",
			},
		);

		expect(context.breadcrumbs).toEqual([
			{ label: "Projects", href: "/dashboard/projects" },
			{ label: "Project One" },
			{
				label: "Production",
				href: "/dashboard/project/p1/environment/e2",
			},
			{
				label: "API",
				href: "/dashboard/project/p1/environment/e2/profiles/application/a3",
			},
		]);
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

describe("datasetTrialScanNavigation", () => {
	it("builds the complete dataset evaluation breadcrumb chain", () => {
		const context = datasetTrialScanNavigation({
			datasetId: "ds-1",
			datasetName: "Cyber Gym",
			profileId: "profile-2",
			profileName: "Default",
			evaluationId: "evaluation-3",
			evaluationName: "Evaluation Run",
		});

		expect(context.returnHref).toBe(
			"/dashboard/datasets/evaluations/evaluation-3?tab=trials",
		);
		expect(context.breadcrumbs).toEqual([
			{ label: "Datasets", href: "/dashboard/datasets" },
			{ label: "Cyber Gym", href: "/dashboard/datasets/ds-1" },
			{
				label: "Default",
				href: "/dashboard/datasets/ds-1/profiles/profile-2",
			},
			{
				label: "Evaluation Run",
				href: "/dashboard/datasets/evaluations/evaluation-3?tab=trials",
			},
		]);
		expectContext(context);
	});

	it("encodes every dynamic breadcrumb segment", () => {
		const context = datasetTrialScanNavigation({
			datasetId: "ds /1",
			datasetName: "Data",
			profileId: "profile /2",
			profileName: "Profile",
			evaluationId: "eval /3",
			evaluationName: "Evaluation",
		});

		expect(context.breadcrumbs[2]?.href).toBe(
			"/dashboard/datasets/ds%20%2F1/profiles/profile%20%2F2",
		);
		expect(context.returnHref).toBe(
			"/dashboard/datasets/evaluations/eval%20%2F3?tab=trials",
		);
	});
});
