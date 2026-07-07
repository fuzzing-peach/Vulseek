import { db } from "@vulseek/server/db";
import {
	applications,
	compose,
	environments,
	projects,
	scanJobs,
	tasks,
	vulnerabilityCandidates,
} from "@vulseek/server/db/schema";
import { eq, inArray } from "drizzle-orm";
import {
	buildHomeOverviewFromRows,
	clampHomeOverviewDays,
	type OverviewJobRow,
} from "./home-overview-aggregate";

export * from "./home-overview-aggregate";

export const getScanHomeOverview = async (input: {
	organizationId: string;
	days?: number;
}) => {
	const days = clampHomeOverviewDays(input.days);

	const [projectRows, appRows, composeRows, appJobRows, composeJobRows] =
		await Promise.all([
			db
				.select({ projectId: projects.projectId })
				.from(projects)
				.where(eq(projects.organizationId, input.organizationId)),
			db
				.select({ applicationId: applications.applicationId })
				.from(applications)
				.innerJoin(
					environments,
					eq(applications.environmentId, environments.environmentId),
				)
				.innerJoin(projects, eq(environments.projectId, projects.projectId))
				.where(eq(projects.organizationId, input.organizationId)),
			db
				.select({ composeId: compose.composeId })
				.from(compose)
				.innerJoin(
					environments,
					eq(compose.environmentId, environments.environmentId),
				)
				.innerJoin(projects, eq(environments.projectId, projects.projectId))
				.where(eq(projects.organizationId, input.organizationId)),
			db
				.select({
					scanJobId: scanJobs.scanJobId,
					title: scanJobs.title,
					status: scanJobs.status,
					totalTokens: scanJobs.totalTokens,
					createdAt: scanJobs.createdAt,
					target: applications.name,
					fallbackTarget: applications.appName,
					projectId: projects.projectId,
					environmentId: environments.environmentId,
					serviceId: applications.applicationId,
				})
				.from(scanJobs)
				.innerJoin(
					applications,
					eq(scanJobs.applicationId, applications.applicationId),
				)
				.innerJoin(
					environments,
					eq(applications.environmentId, environments.environmentId),
				)
				.innerJoin(projects, eq(environments.projectId, projects.projectId))
				.where(eq(projects.organizationId, input.organizationId)),
			db
				.select({
					scanJobId: scanJobs.scanJobId,
					title: scanJobs.title,
					status: scanJobs.status,
					totalTokens: scanJobs.totalTokens,
					createdAt: scanJobs.createdAt,
					target: compose.name,
					fallbackTarget: compose.appName,
					projectId: projects.projectId,
					environmentId: environments.environmentId,
					serviceId: compose.composeId,
				})
				.from(scanJobs)
				.innerJoin(compose, eq(scanJobs.composeId, compose.composeId))
				.innerJoin(
					environments,
					eq(compose.environmentId, environments.environmentId),
				)
				.innerJoin(projects, eq(environments.projectId, projects.projectId))
				.where(eq(projects.organizationId, input.organizationId)),
		]);

	const jobs: OverviewJobRow[] = [
		...appJobRows.map((row) => ({
			...row,
			target: row.target || row.fallbackTarget || "Application",
			targetKind: "application" as const,
		})),
		...composeJobRows.map((row) => ({
			...row,
			target: row.target || row.fallbackTarget || "Compose",
			targetKind: "compose" as const,
		})),
	];
	const scanJobIds = jobs.map((job) => job.scanJobId);
	const [taskRows, candidateRows] =
		scanJobIds.length > 0
			? await Promise.all([
					db
						.select({
							scanJobId: tasks.scanJobId,
							taskId: tasks.taskId,
							status: tasks.status,
							containerName: tasks.containerName,
							stageName: tasks.stageName,
							output: tasks.output,
							createdAt: tasks.createdAt,
						})
						.from(tasks)
						.where(inArray(tasks.scanJobId, scanJobIds)),
					db
						.select({
							scanJobId: vulnerabilityCandidates.scanJobId,
							vulnerabilityCandidateId:
								vulnerabilityCandidates.vulnerabilityCandidateId,
						})
						.from(vulnerabilityCandidates)
						.where(inArray(vulnerabilityCandidates.scanJobId, scanJobIds)),
				])
			: [[], []];

	return buildHomeOverviewFromRows({
		projectCount: projectRows.length,
		subjectCount: appRows.length + composeRows.length,
		jobs,
		tasks: taskRows,
		candidates: candidateRows,
		days,
	});
};
