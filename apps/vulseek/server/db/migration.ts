import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { ensureLegacyDrizzleBaseline } from "./legacy-drizzle-baseline";

const connectionString = process.env.DATABASE_URL!;
const migrationsFolder = "drizzle";

const sql = postgres(connectionString, { max: 1 });
const db = drizzle(sql);

export const migration = async () =>
	await ensureLegacyDrizzleBaseline(sql, migrationsFolder)
		.then(async () => await migrate(db, { migrationsFolder }))
		.then(() => {
			console.log("Migration complete");
			sql.end();
		})
		.catch((error) => {
			console.log("Migration failed", error);
		})
		.finally(() => {
			sql.end();
		});
