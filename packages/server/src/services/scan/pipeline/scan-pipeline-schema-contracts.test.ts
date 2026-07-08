import assert from "node:assert/strict";
import test from "node:test";
import {
	createJsonSchemaContract,
	getJsonSchemaArtifactAnnotations,
	validateJsonSchemaContract,
} from "./scan-pipeline-schema-contracts";

test("createJsonSchemaContract normalizes $pathOf and exposes artifact annotations", () => {
	const contract = createJsonSchemaContract({
		schemas: {
			Module: {
				type: "object",
				required: ["moduleId"],
				properties: {
					moduleId: { type: "string" },
				},
			},
		},
		schema: {
			type: "object",
			required: ["modules"],
			properties: {
				modules: {
					type: "array",
					items: {
						$pathOf: "#/schemas/Module",
					},
				},
			},
		},
	});

	assert.deepEqual(contract.schema, {
		type: "object",
		required: ["modules"],
		properties: {
			modules: {
				type: "array",
				items: {
					type: "string",
				},
			},
		},
	});
	assert.deepEqual(
		getJsonSchemaArtifactAnnotations(contract).map((annotation) => ({
			path: annotation.path,
			kind: annotation.kind,
			jsonSchema: annotation.jsonSchema,
		})),
		[
			{
				path: "output.modules[]",
				kind: "path_list",
				jsonSchema: {
					type: "object",
					required: ["moduleId"],
					properties: {
						moduleId: { type: "string" },
					},
				},
			},
		],
	);
});

test("validateJsonSchemaContract validates normalized output shape", () => {
	const contract = createJsonSchemaContract({
		schemas: {},
		schema: {
			type: "object",
			required: ["candidatePath"],
			properties: {
				candidatePath: {
					type: "string",
				},
			},
			additionalProperties: false,
		},
	});

	validateJsonSchemaContract(contract, {
		candidatePath: "/task/outputs/candidate.json",
	});
	assert.throws(
		() =>
			validateJsonSchemaContract(contract, {
				candidatePath: 42,
			}),
		/JSON Schema validation failed/,
	);
});

test("createJsonSchemaContract resolves nested internal $ref schemas", () => {
	const contract = createJsonSchemaContract({
		schemas: {
			CandidateManifest: {
				type: "object",
				required: ["candidate"],
				properties: {
					candidate: {
						$pathOf: "#/schemas/Candidate",
					},
				},
				additionalProperties: false,
			},
			Candidate: {
				type: "object",
				required: ["id"],
				properties: {
					id: { type: "string" },
				},
			},
		},
		schema: {
			$ref: "#/schemas/CandidateManifest",
		},
	});

	assert.deepEqual(contract.schema, {
		type: "object",
		required: ["candidate"],
		properties: {
			candidate: {
				type: "string",
			},
		},
		additionalProperties: false,
	});
	assert.equal(getJsonSchemaArtifactAnnotations(contract)[0]?.path, "output.candidate");
});
