import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { transformPipelineEdgeInput } from "./scan-pipeline-edge-transform";

test("transformPipelineEdgeInput fans out array items into downstream inputs", async () => {
	const outputs = await transformPipelineEdgeInput(
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

test("transformPipelineEdgeInput maps output and input fields into one downstream input", async () => {
	const outputs = await transformPipelineEdgeInput(
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

test("transformPipelineEdgeInput fans out $file nested array fields", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "scan-edge-file-"));
	const threatModelPath = path.join(dir, "module-threat-model.json");
	await writeFile(
		threatModelPath,
		JSON.stringify({
			likelyVulnerabilityClasses: ["SQL injection", "XSS"],
		}),
		"utf-8",
	);

	const outputs = await transformPipelineEdgeInput(
		{
			mode: "fanOut",
			foreach: "$file($.threatModel).likelyVulnerabilityClasses[*]",
			input: {
				modulePath: "$.module",
				threatModelPath: "$.threatModel",
				vulnerabilityClassFocus: "$item",
			},
		},
		{
			ctx: {},
			stageInput: {},
			stageOutput: {
				module: "/task/module.json",
				threatModel: threatModelPath,
			},
			allowedRoots: [dir],
		},
	);

	assert.deepEqual(outputs, [
		{
			modulePath: "/task/module.json",
			threatModelPath,
			vulnerabilityClassFocus: "SQL injection",
		},
		{
			modulePath: "/task/module.json",
			threatModelPath,
			vulnerabilityClassFocus: "XSS",
		},
	]);
});

test("transformPipelineEdgeInput caches $file reads within one transform", async () => {
	let reads = 0;
	const outputs = await transformPipelineEdgeInput(
		{
			mode: "fanOut",
			foreach: "$file($.threatModel).likelyVulnerabilityClasses[*]",
			input: {
				summary: "$file($.threatModel).summary",
				vulnerabilityClassFocus: "$item",
			},
		},
		{
			ctx: {},
			stageInput: {},
			stageOutput: {
				threatModel: "/task/outputs/module-threat-model.json",
			},
			readJsonFile: async () => {
				reads += 1;
				return {
					summary: "model",
					likelyVulnerabilityClasses: ["A", "B"],
				};
			},
		},
	);

	assert.equal(reads, 1);
	assert.deepEqual(outputs, [
		{ summary: "model", vulnerabilityClassFocus: "A" },
		{ summary: "model", vulnerabilityClassFocus: "B" },
	]);
});

test("transformPipelineEdgeInput rejects $file path escape and bad shapes", async () => {
	await assert.rejects(
		() =>
			transformPipelineEdgeInput(
				{
					mode: "fanOut",
					foreach: "$file($.threatModel).likelyVulnerabilityClasses[*]",
					input: { vulnerabilityClassFocus: "$item" },
				},
				{
					ctx: {},
					stageInput: {},
					stageOutput: { threatModel: "/etc/passwd" },
					allowedRoots: ["/tmp/allowed-root"],
				},
			),
		/escapes allowed roots/,
	);

	await assert.rejects(
		() =>
			transformPipelineEdgeInput(
				{
					mode: "fanOut",
					foreach: "$file($.threatModel).likelyVulnerabilityClasses[*]",
					input: { vulnerabilityClassFocus: "$item" },
				},
				{
					ctx: {},
					stageInput: {},
					stageOutput: { threatModel: 123 },
					readJsonFile: async () => ({}),
				},
			),
		/did not resolve to a string/,
	);

	await assert.rejects(
		() =>
			transformPipelineEdgeInput(
				{
					mode: "fanOut",
					foreach: "$file($.threatModel).likelyVulnerabilityClasses[*]",
					input: { vulnerabilityClassFocus: "$item" },
				},
				{
					ctx: {},
					stageInput: {},
					stageOutput: { threatModel: "/task/tm.json" },
					readJsonFile: async () => ({
						likelyVulnerabilityClasses: "not-an-array",
					}),
				},
			),
		/did not resolve to an array/,
	);

	const empty = await transformPipelineEdgeInput(
		{
			mode: "fanOut",
			foreach: "$file($.threatModel).likelyVulnerabilityClasses[*]",
			input: { vulnerabilityClassFocus: "$item" },
		},
		{
			ctx: {},
			stageInput: {},
			stageOutput: { threatModel: "/task/tm.json" },
			readJsonFile: async () => ({
				likelyVulnerabilityClasses: [],
			}),
		},
	);
	assert.deepEqual(empty, []);
});

test("transformPipelineEdgeInput treats null stageOutput as empty fanOut", async () => {
	const outputs = await transformPipelineEdgeInput(
		{
			mode: "fanOut",
			foreach: "$.candidates[*]",
			input: {
				candidatePath: "$item",
				repositoryPath: "$input.repositoryPath",
			},
		},
		{
			ctx: {},
			stageInput: { repositoryPath: "/task/inputs/repository.json" },
			stageOutput: null,
		},
	);
	assert.deepEqual(outputs, []);
});

test("transformPipelineEdgeInput treats missing foreach collection as empty fanOut", async () => {
	const outputs = await transformPipelineEdgeInput(
		{
			mode: "fanOut",
			foreach: "$.candidates[*]",
			input: {
				candidatePath: "$item",
			},
		},
		{
			ctx: {},
			stageInput: {},
			stageOutput: { repository: "/task/repository.json" },
		},
	);
	assert.deepEqual(outputs, []);
});

test("transformPipelineEdgeInput still rejects non-array foreach collections", async () => {
	await assert.rejects(
		() =>
			transformPipelineEdgeInput(
				{
					mode: "fanOut",
					foreach: "$.candidates[*]",
					input: { candidatePath: "$item" },
				},
				{
					ctx: {},
					stageInput: {},
					stageOutput: { candidates: "not-an-array" },
				},
			),
		/did not resolve to an array/,
	);
});
