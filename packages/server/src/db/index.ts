import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

declare global {
	var __vulseekDb: PostgresJsDatabase<typeof schema> | undefined;
	var __vulseekDbConnection: ReturnType<typeof postgres> | undefined;
}

export let db: PostgresJsDatabase<typeof schema>;
export let dbConnection: ReturnType<typeof postgres>;
const databaseUrl = () => process.env.DATABASE_URL as string;

if (process.env.NODE_ENV === "production") {
	dbConnection = postgres(databaseUrl());
	db = drizzle(dbConnection, {
		schema,
	});
} else {
	if (!global.__vulseekDb || !global.__vulseekDbConnection) {
		global.__vulseekDbConnection = postgres(databaseUrl());
		global.__vulseekDb = drizzle(global.__vulseekDbConnection, {
			schema,
		});
	}

	db = global.__vulseekDb;
	dbConnection = global.__vulseekDbConnection;
}

export const closeDbConnection = async () => {
	await dbConnection.end();
	if (process.env.NODE_ENV !== "production") {
		global.__vulseekDb = undefined;
		global.__vulseekDbConnection = undefined;
	}
};
