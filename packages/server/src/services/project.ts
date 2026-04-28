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
					applications: true,
					mariadb: true,
					mongo: true,
					mysql: true,
					postgres: true,
					redis: true,
					compose: true,
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
	const query = await db.query.environments.findMany({
		with: {
			applications: {
				where: eq(applications.appName, appName),
			},
			compose: {
				where: eq(compose.appName, appName),
			},
			mariadb: {
				where: eq(mariadb.appName, appName),
			},
			mongo: {
				where: eq(mongo.appName, appName),
			},
			mysql: {
				where: eq(mysql.appName, appName),
			},
			postgres: {
				where: eq(postgres.appName, appName),
			},
			redis: {
				where: eq(redis.appName, appName),
			},
		},
	});

	// Filter out items with non-empty fields
	const nonEmptyProjects = query.filter(
		(project) =>
			project.applications.length > 0 ||
			project.compose.length > 0 ||
			project.mariadb.length > 0 ||
			project.mongo.length > 0 ||
			project.mysql.length > 0 ||
			project.postgres.length > 0 ||
			project.redis.length > 0,
	);

	return nonEmptyProjects.length === 0;
};
