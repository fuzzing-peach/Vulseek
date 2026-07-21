import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJsonSchemaContract } from "./scan-pipeline-schema-contracts";
import { applySchemaTransforms } from "./scan-pipeline-schema-transforms";
import { writeTaskJsonArtifact } from "../artifacts/task-artifact-paths";

const candidateSchema = {
	type: "object",
	required: ["id", "title", "classes"],
	properties: {
		id: {
			type: "string",
			$generate: { function: "uuid", length: 6, prefix: "candidate-" },
		},
		title: { type: "string" },
		classes: {
			type: "array",
			items: { type: "string" },
			$normalize: ["trim", "remove-empty", "unique"],
		},
	},
};

test("schema transforms generate candidate IDs in place and preserve artifact paths", async () => {
	const taskDir = await mkdtemp(path.join(os.tmpdir(), "scan-schema-transform-"));
	const candidatePath = "/task/candidates/agent-name.json";
	await writeTaskJsonArtifact({
		taskDir,
		relativePath: "candidates/agent-name.json",
		value: { id: "agent-id", title: "Finding", classes: [" A ", "A", ""] },
	});
	const contract = createJsonSchemaContract({
		schemas: { Candidate: candidateSchema },
		schema: {
		 type: "object",
		 required: ["candidates"],
		 properties: {
			 candidates: {
				 type: "array",
				 items: { $pathOf: "#/schemas/Candidate" },
			 },
		 },
	},
	});
	const output = { candidates: [candidatePath] };
	await applySchemaTransforms({ contract, taskDir, value: output });
	contract.validate(output);

	assert.equal(output.candidates[0], candidatePath);
	const candidate = JSON.parse(
		await readFile(path.join(taskDir, "candidates/agent-name.json"), "utf8"),
	);
	assert.match(candidate.id, /^candidate-[0-9a-f]{6}$/);
	assert.deepEqual(candidate.classes, ["A"]);
});

test("schema transforms reject invalid UUID annotation lengths", () => {
	assert.throws(() =>
		createJsonSchemaContract({
			schemas: {},
			schema: {
				type: "object",
				properties: {
					id: {
						type: "string",
						$generate: { function: "uuid", length: 33 },
					},
				},
			},
		}),
	/UUID length must be an integer between 1 and 32/,
	);
});
