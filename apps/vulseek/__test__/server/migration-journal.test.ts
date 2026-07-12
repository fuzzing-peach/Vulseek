import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface JournalEntry {
	idx: number;
	when: number;
	tag: string;
}

describe("migration journal", () => {
	it("registers every migration except the known legacy duplicate", () => {
		const drizzleDirectory = join(
			dirname(fileURLToPath(import.meta.url)),
			"../../drizzle",
		);
		const journal = JSON.parse(
			readFileSync(join(drizzleDirectory, "meta/_journal.json"), "utf8"),
		) as { entries: JournalEntry[] };
		const sqlTags = readdirSync(drizzleDirectory)
			.filter((fileName) => fileName.endsWith(".sql"))
			.map((fileName) => fileName.slice(0, -4));
		const journalTags = new Set(journal.entries.map((entry) => entry.tag));
		const unregisteredTags = sqlTags
			.filter((tag) => !journalTags.has(tag))
			.sort();

		expect(journal.entries).toHaveLength(209);
		expect(journal.entries.at(-1)?.tag).toBe("0208_user_username");
		expect(unregisteredTags).toEqual(["0057_damp_prism"]);
		expect(journal.entries.map((entry) => entry.idx)).toEqual(
			journal.entries.map((_, index) => index),
		);
		expect(journal.entries.map((entry) => entry.when)).toEqual(
			journal.entries.map((entry) => entry.when).sort((a, b) => a - b),
		);
	});
});
