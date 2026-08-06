/**
 * Centralized route builders — pages never concatenate route strings.
 *
 * Project and Dataset scan entry points only differ in navigation context;
 * the same builder set covers both so the shared scan detail pages can be
 * rendered identically from either side.
 */

export type ScanNavigationContext = {
	kind: "project" | "dataset";
	/** Label used for the source resource, e.g. "Project" or "Dataset". */
	sourceLabel: string;
	/** The profile/service/dataset page to return to. */
	returnHref: string;
	/** URL of the jobs list for this source. */
	jobsListHref: string;
	jobHref: (scanJobId: string) => string;
	taskHref: (scanJobId: string, taskId: string) => string;
	candidateHref: (scanJobId: string, candidateId: string) => string;
	/** Breadcrumb chain; the last entry is the current (non-clickable) item. */
	breadcrumbs: readonly { label: string; href?: string }[];
};

const encodeSegment = (value: string) => encodeURIComponent(value);

const jobsBase = (parts: readonly string[]): string =>
	`${parts.map((part) => (part.startsWith("/") ? part : `/${encodeSegment(part)}`)).join("")}/jobs`;

export type ProjectScanScope = {
	kind: "profiles" | "services";
	profileType: "application" | "compose";
	projectId: string;
	environmentId: string;
	profileId: string;
};

export const projectScanNavigation = (
	scope: ProjectScanScope,
	names?: {
		projectName?: string;
		environmentName?: string;
		profileName?: string;
	},
): ScanNavigationContext => {
	const base = jobsBase([
		"/dashboard/project",
		scope.projectId,
		"environment",
		scope.environmentId,
		scope.kind,
		scope.profileType,
		scope.profileId,
	]);

	const breadcrumbs: { label: string; href?: string }[] = [
		{ label: "Projects", href: "/dashboard/projects" },
		...(names?.projectName
			? [{ label: names.projectName, href: "/dashboard/projects" }]
			: []),
		{ label: "Scan Jobs", href: base },
	];

	return {
		kind: "project",
		sourceLabel: "Project",
		returnHref: `/dashboard/project/${encodeSegment(scope.projectId)}/environment/${encodeSegment(scope.environmentId)}/${scope.kind}/${scope.profileType}/${encodeSegment(scope.profileId)}`,
		jobsListHref: base,
		jobHref: (scanJobId) => `${base}/${encodeSegment(scanJobId)}`,
		taskHref: (scanJobId, taskId) =>
			`${base}/${encodeSegment(scanJobId)}/tasks/${encodeSegment(taskId)}`,
		candidateHref: (scanJobId, candidateId) =>
			`${base}/${encodeSegment(scanJobId)}/candidates/${encodeSegment(candidateId)}`,
		breadcrumbs,
	};
};

export const datasetScanNavigation = (
	datasetId?: string,
	names?: { datasetName?: string },
): ScanNavigationContext => {
	const base = "/dashboard/datasets/jobs";
	const breadcrumbs: { label: string; href?: string }[] = [
		{ label: "Datasets", href: "/dashboard/datasets" },
		...(datasetId && names?.datasetName
			? [
					{
						label: names.datasetName,
						href: `/dashboard/datasets/${encodeSegment(datasetId)}`,
					},
				]
			: []),
		{ label: "Scan Jobs", href: base },
	];

	return {
		kind: "dataset",
		sourceLabel: "Dataset",
		returnHref: datasetId
			? `/dashboard/datasets/${encodeSegment(datasetId)}`
			: "/dashboard/datasets",
		jobsListHref: base,
		jobHref: (scanJobId) => `${base}/${encodeSegment(scanJobId)}`,
		taskHref: (scanJobId, taskId) =>
			`${base}/${encodeSegment(scanJobId)}/tasks/${encodeSegment(taskId)}`,
		candidateHref: (scanJobId, candidateId) =>
			`${base}/${encodeSegment(scanJobId)}/candidates/${encodeSegment(candidateId)}`,
		breadcrumbs,
	};
};
