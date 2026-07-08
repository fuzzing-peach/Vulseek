import assert from "node:assert/strict";
import test from "node:test";
import {
	createStageRuntimeConfigWithDeps,
	type ScanPipelineDefinitions,
} from "./scan-pipeline-definitions";

const makeDefinitions = (concurrency: number): ScanPipelineDefinitions => ({
	pipelineIds: { full: "full", delta: "delta" },
	schemas: {},
	stageIds: ["scan-target"],
	stages: [
		{
			id: "scan-target",
			key: "functionScan",
			name: "Scan Target",
			role: "scan",
			group: "scan",
			concurrency,
			maxConcurrency: null,
			disableable: true,
			description: null,
			inputSchema: null,
			outputSchema: null,
			runtimeConfig: {
				agentProfile: "agent-a",
				persistent: true,
				reuseContainer: false,
				mode: "fanout",
				nullableOutput: true,
				cwd: "/workspace/repo",
				skills: ["scan-skill"],
				prompt: "Scan target now",
				promptFile: null,
				inputArtifacts: null,
				outputSchema: null,
			},
		},
	],
	stageMetadata: {
		functionScan: { id: "scan-target", name: "Scan Target" },
	},
	stageMetadataById: {
		"scan-target": { key: "functionScan", id: "scan-target", name: "Scan Target" },
	},
	stageSettings: {
		scanTarget: {
			stageName: "scan-target",
			label: "Scan Target",
			role: "scan",
			group: "scan",
			concurrency,
			maxConcurrency: 128,
			disableable: true,
			description: "Scan Target",
			inputSchema: null,
			outputSchema: null,
			runtimeConfig: null,
		},
	},
	pipelines: {
		full: {
			id: "full",
			name: "full",
			rootStageId: "scan-target",
			stageIds: ["scan-target"],
			edges: [],
			groups: [],
		},
		delta: {
			id: "delta",
			name: "delta",
			rootStageId: "scan-target",
			stageIds: ["scan-target"],
			edges: [],
			groups: [],
		},
	},
});

test("stage runtime config getters read the latest job snapshot", async () => {
	let definitions = makeDefinitions(2);
	const runtimeConfig = createStageRuntimeConfigWithDeps({
		scanJobId: "scan-job-1",
		stageName: "scan-target",
		loadScanJobPipelineDefinitionSnapshot: async () => definitions,
	});

	assert.equal(await runtimeConfig.getConcurrency(), 2);
	assert.equal(await runtimeConfig.getAgentProfile(), "agent-a");
	assert.equal(await runtimeConfig.getPrompt(), "Scan target now");
	assert.deepEqual(await runtimeConfig.getSkills(), ["scan-skill"]);

	definitions = makeDefinitions(7);
	definitions.stages[0] = {
		...definitions.stages[0]!,
		runtimeConfig: {
			...definitions.stages[0]!.runtimeConfig!,
			agentProfile: "agent-b",
			prompt: "Scan target after update",
			skills: ["updated-skill"],
		},
	};

	assert.equal(await runtimeConfig.getConcurrency(), 7);
	assert.equal(await runtimeConfig.getAgentProfile(), "agent-b");
	assert.equal(await runtimeConfig.getPrompt(), "Scan target after update");
	assert.deepEqual(await runtimeConfig.getSkills(), ["updated-skill"]);
});
