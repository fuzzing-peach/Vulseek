import assert from "node:assert/strict";
import test from "node:test";
import {
	parseYamlPipelineDefinition,
	validateYamlPipelineDefinition,
} from "./yaml-pipeline-runtime";

test("parses a generic YAML pipeline with declarative artifacts and effects", () => {
	const definition = parseYamlPipelineDefinition({
		version: 2,
		name: "generic-test",
		root: "discover",
		schemas: {
			Finding: {
				type: "object",
				required: ["title"],
			},
		},
		stages: {
			discover: {
				name: "Discover",
				role: "scan",
				mode: "fanout",
				concurrency: 2,
				runtime: {
					promptFile: "discover.prompt.md",
				},
				inputArtifacts: [],
				outputSchema: { $ref: "#/schemas/Finding" },
				effects: [{ type: "sync-candidates" }],
			},
			review: {
				name: "Review",
				role: "analysis",
				mode: "serial",
				concurrency: 1,
				runtime: { prompt: "Review the finding." },
			},
		},
		edges: [
			{
				name: "discover-to-review",
				from: "discover",
				to: "review",
				mode: "fanOut",
				foreach: "$.items[*]",
				input: { finding: "$item" },
				artifacts: [
					{
						from: "$.findingPath",
						to: "inputs/finding.json",
					},
				],
			},
		],
	});

	assert.equal(definition.version, 2);
	assert.equal(definition.root, "discover");
	assert.equal(definition.stages.discover!.mode, "fanout");
	assert.equal(definition.edges[0]?.artifacts[0]?.to, "inputs/finding.json");
	assert.equal(definition.stages.discover!.effects[0]?.type, "sync-candidates");
});

test("rejects a generic pipeline with an unknown stage or effect", () => {
	assert.throws(
		() =>
			validateYamlPipelineDefinition({
				version: 2,
				name: "invalid",
				root: "missing",
				stages: {
					known: {
						name: "Known",
						role: "scan",
						mode: "serial",
						concurrency: 1,
						runtime: { prompt: "test" },
					effects: [{ type: "run-shell" }],
					},
				},
				edges: [],
			}),
		/unknown root stage|Invalid enum value|Invalid discriminator value/i,
	);
});

test("decodes legacy research registry effects without an executor", () => {
	const definition = parseYamlPipelineDefinition({
		version: 2,
		name: "research-test",
		root: "scope",
		stages: {
			scope: {
				name: "Scope",
				role: "scan",
				mode: "serial",
				concurrency: 1,
				runtime: { prompt: "Define scope." },
				effects: [{ type: "research-registry", operation: "persist-scope" }],
			},
		},
		edges: [],
	});

	assert.deepEqual(definition.stages.scope!.effects, [
		{ type: "research-registry", operation: "persist-scope" },
	]);
});
