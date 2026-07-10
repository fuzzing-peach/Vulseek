import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { ensureLegacyDrizzleBaseline } from "./legacy-drizzle-baseline";

const connectionString = process.env.DATABASE_URL!;
const migrationsFolder = "drizzle";

const sql = postgres(connectionString, { max: 1 });
const db = drizzle(sql);

export const migration = async () => {
	try {
		await ensureLegacyDrizzleBaseline(sql, migrationsFolder);
		await migrate(db, { migrationsFolder });
		console.log("Migration complete");
	} finally {
		await sql.end();
	}
};
