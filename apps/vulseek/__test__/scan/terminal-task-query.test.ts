import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("terminal task query", () => {
	it("uses a deterministic task id tie-breaker in the query and index", () => {
		const repositorySource = readFileSync(
			join(
				process.cwd(),
				"../../packages/server/src/services/scan/persistence/task.repo.ts",
			),
			"utf8",
		);
		const migration = readFileSync(
			join(process.cwd(), "drizzle/0214_job_query_performance.sql"),
			"utf8",
		);

		expect(repositorySource).toContain("desc(tasks.taskId)");
		expect(migration).toMatch(
			/coalesce\("completedAt", "updatedAt"\)\) DESC, "taskId" DESC/,
		);
	});
});
