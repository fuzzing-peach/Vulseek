import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("scan job access query is task and cost independent", () => {
	const source = readFileSync(
		path.join(path.dirname(fileURLToPath(import.meta.url)), "scan-job-access.repo.ts"),
		"utf8",
	);
	assert.match(source, /from\(scanJobs\)/);
	assert.match(source, /leftJoin\(applications/);
	assert.match(source, /leftJoin\(compose/);
	assert.match(source, /environments\.environmentId/);
	assert.match(source, /leftJoin\(projects/);
	assert.doesNotMatch(source, /tasks|computeTaskCost/);
});
