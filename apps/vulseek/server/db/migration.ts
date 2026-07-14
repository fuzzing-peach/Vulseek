import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { backfillCandidateResultProjections } from "@vulseek/server/services/scan/persistence/candidate-result-projection-backfill";
import { ensureLegacyDrizzleBaseline } from "./legacy-drizzle-baseline";

const connectionString = process.env.DATABASE_URL!;
const migrationsFolder = "drizzle";

const sql = postgres(connectionString, { max: 1 });
const db = drizzle(sql);

export const migration = async () => {
	try {
		await ensureLegacyDrizzleBaseline(sql, migrationsFolder);
		await migrate(db, { migrationsFolder });
		const backfill = await backfillCandidateResultProjections();
		console.log(
			`Candidate result projection backfill complete: processed=${backfill.processedCount} skipped=${backfill.skippedCount}`,
		);
		console.log("Migration complete");
	} finally {
		await sql.end();
	}
};
