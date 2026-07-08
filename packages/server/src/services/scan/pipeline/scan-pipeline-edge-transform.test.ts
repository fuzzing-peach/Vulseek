import assert from "node:assert/strict";
import test from "node:test";
import { transformPipelineEdgeInput } from "./scan-pipeline-edge-transform";

test("transformPipelineEdgeInput fans out array items into downstream inputs", () => {
	const outputs = transformPipelineEdgeInput(
		{
			mode: "fanOut",
			foreach: "$.modules[*]",
			input: {
				scanJob: "$ctx.scanJob",
				repositoryPath: "$.repository",
				modulePath: "$item",
				moduleId: "",
				priority: null,
			},
		},
		{
			ctx: { scanJob: { scanJobId: "scan-1" } },
			stageInput: { ignored: true },
			stageOutput: {
				repository: "/task/repository.json",
				modules: ["/task/modules/auth.json", "/task/modules/api.json"],
			},
		},
	);

	assert.deepEqual(outputs, [
		{
			scanJob: { scanJobId: "scan-1" },
			repositoryPath: "/task/repository.json",
			modulePath: "/task/modules/auth.json",
			moduleId: "",
			priority: null,
		},
		{
			scanJob: { scanJobId: "scan-1" },
			repositoryPath: "/task/repository.json",
			modulePath: "/task/modules/api.json",
			moduleId: "",
			priority: null,
		},
	]);
});

test("transformPipelineEdgeInput maps output and input fields into one downstream input", () => {
	const outputs = transformPipelineEdgeInput(
		{
			mode: "map",
			input: {
				candidatePath: "$input.candidatePath",
				analysisPath: "$.analysisPath",
				itemId: "$item.id",
				fingerprint: "$computed.analysisFingerprint",
			},
		},
		{
			ctx: { computed: { analysisFingerprint: "fingerprint-1" } },
			item: { id: "item-1" },
			stageInput: { candidatePath: "/task/candidate.json" },
			stageOutput: { analysisPath: "/task/analysis.json" },
		},
	);

	assert.deepEqual(outputs, [
		{
			candidatePath: "/task/candidate.json",
			analysisPath: "/task/analysis.json",
			itemId: "item-1",
			fingerprint: "fingerprint-1",
		},
	]);
});
