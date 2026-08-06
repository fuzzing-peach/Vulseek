import { db } from "@vulseek/server/db";
import {
	type apiCreateEnvironment,
	type apiDuplicateEnvironment,
	applications,
	compose,
	environments,
	mariadb,
	mongo,
	mysql,
	postgres,
	redis,
} from "@vulseek/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, ilike, inArray, or } from "drizzle-orm";

export type Environment = typeof environments.$inferSelect;

const environmentApplicationColumns = {
	applicationId: true,
	name: true,
	appName: true,
	description: true,
	createdAt: true,
	applicationStatus: true,
	serverId: true,
} as const;

const environmentComposeColumns = {
	composeId: true,
	name: true,
	appName: true,
	description: true,
	createdAt: true,
	composeStatus: true,
	serverId: true,
} as const;

export const createEnvironment = async (
	input: typeof apiCreateEnvironment._type,
) => {
	const newEnvironment = await db
		.insert(environments)
		.values({
			...input,
		})
		.returning()
		.then((value) => value[0]);

	if (!newEnvironment) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error creating the environment",
		});
	}

	return newEnvironment;
};

export const findEnvironmentById = async (environmentId: string) => {
	const environment = await db.query.environments.findFirst({
		where: eq(environments.environmentId, environmentId),
		with: {
			applications: {
				columns: environmentApplicationColumns,
			},
			mariadb: true,
			mongo: true,
			mysql: true,
			postgres: true,
			redis: true,
			compose: {
				columns: environmentComposeColumns,
			},
			project: true,
		},
	});
	if (!environment) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Environment not found",
		});
	}
	return environment;
};

export const findEnvironmentsByProjectId = async (projectId: string) => {
	const projectEnvironments = await db.query.environments.findMany({
		where: eq(environments.projectId, projectId),
		orderBy: asc(environments.createdAt),
		with: {
			applications: {
				columns: environmentApplicationColumns,
			},
			mariadb: true,
			mongo: true,
			mysql: true,
			postgres: true,
			redis: true,
			compose: {
				columns: environmentComposeColumns,
			},
			project: true,
		},
	});
	return projectEnvironments;
};

export const deleteEnvironment = async (environmentId: string) => {
	const currentEnvironment = await findEnvironmentById(environmentId);
	if (currentEnvironment.name === "production") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "You cannot delete the production environment",
		});
	}
	const deletedEnvironment = await db
		.delete(environments)
		.where(eq(environments.environmentId, environmentId))
		.returning()
		.then((value) => value[0]);

	return deletedEnvironment;
};

export const updateEnvironmentById = async (
	environmentId: string,
	environmentData: Partial<Environment>,
) => {
	const result = await db
		.update(environments)
		.set({
			...environmentData,
		})
		.where(eq(environments.environmentId, environmentId))
		.returning()
		.then((res) => res[0]);

	return result;
};

export const duplicateEnvironment = async (
	input: typeof apiDuplicateEnvironment._type,
) => {
	// Find the original environment
	const originalEnvironment = await findEnvironmentById(input.environmentId);

	// Create a new environment with the provided name and description
	const newEnvironment = await db
		.insert(environments)
		.values({
			name: input.name,
			description: input.description || originalEnvironment.description,
			projectId: originalEnvironment.projectId,
		})
		.returning()
		.then((value) => value[0]);

	if (!newEnvironment) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error duplicating the environment",
		});
	}

	return newEnvironment;
};

export const createProductionEnvironment = async (projectId: string) => {
	return createEnvironment({
		name: "production",
		description: "Production environment",
		projectId,
	});
};

export type EnvironmentProfileType =
	| "application"
	| "mariadb"
	| "mongo"
	| "mysql"
	| "postgres"
	| "redis"
	| "compose";

export type EnvironmentProfileStatus = "idle" | "running" | "done" | "error";

export type EnvironmentProfile = {
	id: string;
	type: EnvironmentProfileType;
	name: string;
	description: string | null;
	createdAt: string;
	status: EnvironmentProfileStatus;
	serverId: string | null;
};

export type EnvironmentProfileSortKey = "name" | "type" | "createdAt";

/**
 * Merges the heterogeneous per-table profile rows and applies the list
 * contract: type filter, sort, and page slice. Kept pure so paging/sort
 * semantics are unit-testable without a database.
 */
export const mergeAndPageEnvironmentProfiles = (
	profiles: EnvironmentProfile[],
	input: {
		types?: EnvironmentProfileType[];
		sortKey: EnvironmentProfileSortKey;
		sortDirection: "asc" | "desc";
		page: number;
		pageSize: number;
	},
): {
	items: EnvironmentProfile[];
	total: number;
	page: number;
	pageSize: number;
} => {
	const filtered =
		input.types && input.types.length > 0
			? profiles.filter((profile) => input.types?.includes(profile.type))
			: profiles;
	const direction = input.sortDirection === "asc" ? 1 : -1;
	const sorted = [...filtered].sort((a, b) => {
		let comparison = 0;
		switch (input.sortKey) {
			case "name":
				comparison = a.name.localeCompare(b.name);
				break;
			case "type":
				comparison = a.type.localeCompare(b.type);
				break;
			default:
				comparison =
					new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
				break;
		}
		return comparison * direction;
	});
	const start = (input.page - 1) * input.pageSize;
	return {
		items: sorted.slice(start, start + input.pageSize),
		total: sorted.length,
		page: input.page,
		pageSize: input.pageSize,
	};
};

/**
 * One select per service table (all shapes are projections of the shared
 * profile contract), merged and paged by {@link mergeAndPageEnvironmentProfiles}.
 * `accessedServiceIds` scopes the rows for member users.
 */
export const listEnvironmentProfilesRepo = async (
	input: {
		environmentId: string;
		search?: string;
		types?: EnvironmentProfileType[];
		sortKey: EnvironmentProfileSortKey;
		sortDirection: "asc" | "desc";
		page: number;
		pageSize: number;
	},
	accessedServiceIds?: string[],
) => {
	const searchPattern = input.search ? `%${input.search}%` : undefined;

	const fetchProfileRows = async (
		table: any, // shared over 7 table shapes
		idColumn: any, // shared over 7 id columns
		statusColumn: any, // shared over 7 status columns
		type: EnvironmentProfileType,
	): Promise<EnvironmentProfile[]> => {
		const conditions = [eq(table.environmentId, input.environmentId)];
		if (searchPattern) {
			const searchCondition = or(
				ilike(table.name, searchPattern),
				ilike(table.description, searchPattern),
			);
			if (searchCondition) {
				conditions.push(searchCondition);
			}
		}
		if (accessedServiceIds && accessedServiceIds.length > 0) {
			conditions.push(inArray(idColumn, accessedServiceIds));
		}
		const rows = await db
			.select({
				id: idColumn,
				name: table.name,
				description: table.description,
				createdAt: table.createdAt,
				status: statusColumn,
				serverId: table.serverId,
			})
			.from(table)
			.where(and(...conditions));
		return rows.map((row) => ({
			id: row.id,
			type,
			name: row.name,
			description: row.description ?? null,
			createdAt: row.createdAt,
			status: row.status,
			serverId: row.serverId ?? null,
		}));
	};

	const profiles: EnvironmentProfile[] = [];
	for (const [table, idColumn, statusColumn, type] of [
		[applications, applications.applicationId, applications.applicationStatus, "application"],
		[compose, compose.composeId, compose.composeStatus, "compose"],
		[mariadb, mariadb.mariadbId, mariadb.applicationStatus, "mariadb"],
		[mongo, mongo.mongoId, mongo.applicationStatus, "mongo"],
		[mysql, mysql.mysqlId, mysql.applicationStatus, "mysql"],
		[postgres, postgres.postgresId, postgres.applicationStatus, "postgres"],
		[redis, redis.redisId, redis.applicationStatus, "redis"],
	] as const) {
		profiles.push(
			...(await fetchProfileRows(table, idColumn, statusColumn, type)),
		);
	}

	return mergeAndPageEnvironmentProfiles(profiles, input);
};
