import { db } from "@vulseek/server/db";
import {
	applications,
	compose,
	datasetEvaluationTrials,
	datasetEvaluations,
	datasets,
	environments,
	projects,
	scanJobs,
} from "@vulseek/server/db/schema";
import { eq, sql } from "drizzle-orm";

export const findScanJobOrganizationIdRepo = async (scanJobId: string) =>
	await db
		.select({ organizationId: sql<string | null>`coalesce(${projects.organizationId}, ${datasets.organizationId})` })
		.from(scanJobs)
		.leftJoin(applications, eq(scanJobs.applicationId, applications.applicationId))
		.leftJoin(compose, eq(scanJobs.composeId, compose.composeId))
		.leftJoin(datasetEvaluationTrials, eq(scanJobs.datasetEvaluationTrialId, datasetEvaluationTrials.trialId))
		.leftJoin(datasetEvaluations, eq(datasetEvaluationTrials.evaluationId, datasetEvaluations.evaluationId))
		.leftJoin(datasets, eq(datasetEvaluations.datasetId, datasets.datasetId))
		.leftJoin(
			environments,
			eq(
				environments.environmentId,
				sql`coalesce(${applications.environmentId}, ${compose.environmentId})`,
			),
		)
		.leftJoin(projects, eq(environments.projectId, projects.projectId))
		.where(eq(scanJobs.scanJobId, scanJobId))
		.limit(1)
		.then((rows) => rows[0]?.organizationId ?? null);
