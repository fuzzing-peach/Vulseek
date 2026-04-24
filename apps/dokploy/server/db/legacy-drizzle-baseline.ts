import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Sql } from "postgres";

const BASELINE_MIGRATION_TAG = "0146_verify_concurrency";
const DRIZZLE_SCHEMA = "drizzle";
const DRIZZLE_TABLE = "__drizzle_migrations";

type JournalEntry = {
	idx: number;
	version: string;
	when: number;
	tag: string;
	breakpoints: boolean;
};

type JournalFile = {
	version: string;
	dialect: string;
	entries: JournalEntry[];
};

const readJournal = (migrationsFolder: string) =>
	JSON.parse(
		readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf-8"),
	) as JournalFile;

const readMigrationHash = (migrationsFolder: string, tag: string) =>
	createHash("sha256")
		.update(readFileSync(join(migrationsFolder, `${tag}.sql`), "utf-8"))
		.digest("hex");

const hasModernDokploySchema = async (sql: Sql) => {
	const [result] = await sql<[{ isModern: boolean }]>`
		select
			exists (
				select 1
				from information_schema.columns
				where table_schema = 'public'
					and table_name = 'application'
					and column_name = 'environmentId'
			)
			and exists (
				select 1
				from information_schema.columns
				where table_schema = 'public'
					and table_name = 'application'
					and column_name = 'verifyConcurrency'
			)
			and exists (
				select 1
				from information_schema.columns
				where table_schema = 'public'
					and table_name = 'project'
					and column_name = 'organizationId'
			)
			and exists (
				select 1
				from information_schema.tables
				where table_schema = 'public'
					and table_name = 'user_temp'
			) as "isModern"
	`;

	return Boolean(result?.isModern);
};

export const ensureLegacyDrizzleBaseline = async (
	sql: Sql,
	migrationsFolder: string,
) => {
	await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${DRIZZLE_SCHEMA}"`);
	await sql.unsafe(`
		CREATE TABLE IF NOT EXISTS "${DRIZZLE_SCHEMA}"."${DRIZZLE_TABLE}" (
			"id" SERIAL PRIMARY KEY,
			"hash" text NOT NULL,
			"created_at" bigint
		)
	`);

	const [{ count }] = await sql<[{ count: string }]>`
		select count(*)::text as count
		from "drizzle"."__drizzle_migrations"
	`;
	if (Number.parseInt(count, 10) > 0) {
		return false;
	}

	if (!(await hasModernDokploySchema(sql))) {
		return false;
	}

	const journal = readJournal(migrationsFolder);
	const baselineEntry = journal.entries.find(
		(entry) => entry.tag === BASELINE_MIGRATION_TAG,
	);
	if (!baselineEntry) {
		throw new Error(
			`Unable to find baseline migration tag: ${BASELINE_MIGRATION_TAG}`,
		);
	}

	const baselineHash = readMigrationHash(migrationsFolder, baselineEntry.tag);
	await sql<[]>`
		insert into "drizzle"."__drizzle_migrations" ("hash", "created_at")
		values (${baselineHash}, ${baselineEntry.when})
	`;

	console.log(
		`Bootstrapped legacy drizzle baseline at ${baselineEntry.tag} (${baselineEntry.when})`,
	);
	return true;
};
