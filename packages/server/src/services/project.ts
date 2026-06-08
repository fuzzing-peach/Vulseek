import { db } from "@dokploy/server/db";
import {
	type apiCreateProject,
	applications,
	compose,
	mariadb,
	mongo,
	mysql,
	postgres,
	projects,
	redis,
} from "@dokploy/server/db/schema";
import { execAsync } from "@dokploy/server/utils/process/execAsync";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { createProductionEnvironment } from "./environment";

export type Project = typeof projects.$inferSelect;

const projectApplicationColumns = {
	applicationId: true,
	name: true,
	appName: true,
	description: true,
	createdAt: true,
	applicationStatus: true,
	serverId: true,
} as const;

const projectComposeColumns = {
	composeId: true,
	name: true,
	appName: true,
	description: true,
	createdAt: true,
	composeStatus: true,
	serverId: true,
} as const;

export const createProject = async (
	input: typeof apiCreateProject._type,
	organizationId: string,
) => {
	const buildScanContextVolumeName = (projectId: string) =>
		`scan-context-${projectId}`;

	const newProject = await db
		.insert(projects)
		.values({
			...input,
			organizationId: organizationId,
		})
		.returning()
		.then((value) => value[0]);

	if (!newProject) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error creating the project",
		});
	}

	const scanContextVolumeName = buildScanContextVolumeName(newProject.projectId);

	try {
		await execAsync(`docker volume create "${scanContextVolumeName}"`);
		await db
			.update(projects)
			.set({
				scanContextVolumeName,
			})
			.where(eq(projects.projectId, newProject.projectId));
	} catch (error) {
		await db.delete(projects).where(eq(projects.projectId, newProject.projectId));
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Error creating scan context volume: ${
				error instanceof Error ? error.message : error
			}`,
		});
	}

	// Automatically create a production environment
	const newEnvironment = await createProductionEnvironment(
		newProject.projectId,
	);
	return {
		project: {
			...newProject,
			scanContextVolumeName,
		},
		environment: newEnvironment,
	};
};

export const findProjectById = async (projectId: string) => {
	const project = await db.query.projects.findFirst({
		where: eq(projects.projectId, projectId),
		with: {
			environments: {
				with: {
					applications: {
						columns: projectApplicationColumns,
					},
					mariadb: true,
					mongo: true,
					mysql: true,
					postgres: true,
					redis: true,
					compose: {
						columns: projectComposeColumns,
					},
				},
			},
		},
	});
	if (!project) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Project not found",
		});
	}
	return project;
};

export const deleteProject = async (projectId: string) => {
	const project = await db
		.delete(projects)
		.where(eq(projects.projectId, projectId))
		.returning()
		.then((value) => value[0]);

	return project;
};

export const updateProjectById = async (
	projectId: string,
	projectData: Partial<Project>,
) => {
	const result = await db
		.update(projects)
		.set({
			...projectData,
		})
		.where(eq(projects.projectId, projectId))
		.returning()
		.then((res) => res[0]);

	return result;
};

export const validUniqueServerAppName = async (appName: string) => {
	const [
		applicationMatch,
		composeMatch,
		mariadbMatch,
		mongoMatch,
		mysqlMatch,
		postgresMatch,
		redisMatch,
	] = await Promise.all([
		db.query.applications.findFirst({
			columns: { applicationId: true },
			where: eq(applications.appName, appName),
		}),
		db.query.compose.findFirst({
			columns: { composeId: true },
			where: eq(compose.appName, appName),
		}),
		db.query.mariadb.findFirst({
			columns: { mariadbId: true },
			where: eq(mariadb.appName, appName),
		}),
		db.query.mongo.findFirst({
			columns: { mongoId: true },
			where: eq(mongo.appName, appName),
		}),
		db.query.mysql.findFirst({
			columns: { mysqlId: true },
			where: eq(mysql.appName, appName),
		}),
		db.query.postgres.findFirst({
			columns: { postgresId: true },
			where: eq(postgres.appName, appName),
		}),
		db.query.redis.findFirst({
			columns: { redisId: true },
			where: eq(redis.appName, appName),
		}),
	]);

	return !(
		applicationMatch ||
		composeMatch ||
		mariadbMatch ||
		mongoMatch ||
		mysqlMatch ||
		postgresMatch ||
		redisMatch
	);
};
