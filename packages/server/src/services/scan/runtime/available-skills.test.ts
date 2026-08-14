import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { listAvailableAgentSkills } from "./available-skills";

test("listAvailableAgentSkills reads SKILL.md name and description", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "vulseek-skills-"));
	await mkdir(path.join(root, "skills", "goal-hunt"), { recursive: true });
	await mkdir(path.join(root, "skills", "codeql"), { recursive: true });
	await writeFile(
		path.join(root, "skills", "goal-hunt", "SKILL.md"),
		["---", "name: goal-hunt", "description: Pursue one hunt goal.", "---", "", "# Hunt"].join(
			"\n",
		),
	);
	await writeFile(
		path.join(root, "skills", "codeql", "SKILL.md"),
		[
			"---",
			"name: codeql",
			"description: >-",
			"  Scans a codebase for vulnerabilities",
			"  using taint tracking.",
			"---",
			"",
			"# CodeQL",
		].join("\n"),
	);
	await mkdir(path.join(root, "skills", "empty-dir"), { recursive: true });

	const skills = await listAvailableAgentSkills(root);
	assert.deepEqual(
		skills.map((skill) => skill.name),
		["codeql", "goal-hunt"],
	);
	assert.match(skills[0]!.description, /taint tracking/);
	assert.equal(skills[1]!.description, "Pursue one hunt goal.");
});

test("listAvailableAgentSkills returns [] when the agents dir is missing", async () => {
	assert.deepEqual(await listAvailableAgentSkills("/tmp/does-not-exist-skills"), []);
});
