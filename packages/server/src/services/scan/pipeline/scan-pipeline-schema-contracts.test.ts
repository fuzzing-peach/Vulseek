import assert from "node:assert/strict";
import test from "node:test";
import {
	createJsonSchemaContract,
	getJsonSchemaArtifactAnnotations,
	validateJsonSchemaContractArtifacts,
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

test("validateJsonSchemaContractArtifacts validates referenced artifact JSON content", async () => {
	const contract = createJsonSchemaContract({
		schemas: {
			Module: {
				type: "object",
				required: ["moduleId"],
				properties: {
					moduleId: { type: "string" },
				},
				additionalProperties: false,
			},
			RepositoryProfileOutput: {
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
		},
		schema: {
			$ref: "#/schemas/RepositoryProfileOutput",
		},
	});

	await validateJsonSchemaContractArtifacts(
		contract,
		{
			modules: ["/task/modules/auth.json"],
		},
		async (artifactPath) => {
			assert.equal(artifactPath, "/task/modules/auth.json");
			return { moduleId: "auth" };
		},
	);

	await assert.rejects(
		() =>
			validateJsonSchemaContractArtifacts(
				contract,
				{
					modules: ["/task/modules/auth.json"],
				},
				async () => ({ moduleId: 42 }),
			),
		/output\.modules\[\].*JSON Schema validation failed/,
	);
});

test("validateJsonSchemaContractArtifacts validates paths nested inside an artifact", async () => {
	const contract = createJsonSchemaContract({
		schemas: {
			Finding: {
				type: "object",
				required: ["findingId"],
				properties: {
					findingId: { type: "string" },
				},
				additionalProperties: false,
			},
			DiscoveryReport: {
				type: "object",
				required: ["findingPaths"],
				properties: {
					findingPaths: {
						type: "array",
						items: {
							$pathOf: "#/schemas/Finding",
						},
					},
				},
				additionalProperties: false,
			},
			DiscoveryManifest: {
				type: "object",
				required: ["discoveryReportPath"],
				properties: {
					discoveryReportPath: {
						$pathOf: "#/schemas/DiscoveryReport",
					},
				},
				additionalProperties: false,
			},
		},
		schema: {
			$ref: "#/schemas/DiscoveryManifest",
		},
	});
	const artifacts = new Map<string, unknown>([
		[
			"/task/discovery-report.json",
			{
				findingPaths: [
					"/task/findings/one.json",
					"/task/findings/two.json",
				],
			},
		],
		["/task/findings/one.json", { findingId: "track:one" }],
		["/task/findings/two.json", { findingId: "track:two" }],
	]);
	const reads: string[] = [];

	assert.deepEqual(
		getJsonSchemaArtifactAnnotations(contract).map(
			(annotation) => annotation.path,
		),
		[
			"output.discoveryReportPath",
			"artifact.findingPaths[]",
		],
	);

	await validateJsonSchemaContractArtifacts(
		contract,
		{ discoveryReportPath: "/task/discovery-report.json" },
		async (artifactPath) => {
			reads.push(artifactPath);
			const artifact = artifacts.get(artifactPath);
			assert.notEqual(artifact, undefined);
			return artifact;
		},
	);
	assert.deepEqual(reads, [
		"/task/discovery-report.json",
		"/task/findings/one.json",
		"/task/findings/two.json",
	]);

	artifacts.set("/task/findings/two.json", { findingId: 42 });
	await assert.rejects(
		() =>
			validateJsonSchemaContractArtifacts(
				contract,
				{ discoveryReportPath: "/task/discovery-report.json" },
				async (artifactPath) => artifacts.get(artifactPath),
			),
		/artifact\.findingPaths\[\].*JSON Schema validation failed/,
	);
});
