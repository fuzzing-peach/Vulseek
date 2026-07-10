import assert from "node:assert/strict";
import test from "node:test";
import {
	parseScanPipelineDefinitionsFromYaml,
	resolveScanPipelineDefinitionsDir,
	SCAN_PIPELINE_DEFINITIONS,
	validatePipelineRegistryCoverage,
} from "./scan-pipeline-definitions";

test("loaded full pipeline fans out identify-target by threat-model vulnerability classes", () => {
	const edge = SCAN_PIPELINE_DEFINITIONS.pipelines.full.edges.find(
		(item) => item.name === "attack-surface-model-to-identify-target",
	);
	assert.ok(edge);
	assert.equal(edge.mode, "fanOut");
	assert.equal(
		edge.foreach,
		"$file($.threatModel).likelyVulnerabilityClasses[*]",
	);
	assert.equal(
		(edge.input as Record<string, unknown>).vulnerabilityClassFocus,
		"$item",
	);

	const scanEdge = SCAN_PIPELINE_DEFINITIONS.pipelines.full.edges.find(
		(item) => item.name === "identify-target-to-scan-target",
	);
	assert.ok(scanEdge);
	assert.equal(
		(scanEdge.input as Record<string, unknown>).vulnerabilityClassFocus,
		"$input.vulnerabilityClassFocus",
	);
});

test("parseScanPipelineDefinitionsFromYaml parses full and delta pipeline topology", () => {
	const definitions = parseScanPipelineDefinitionsFromYaml(`
schemas:
  RepositoryProfileOutput:
    type: object
    required: [modules]
    additionalProperties: false
    properties:
      modules:
        type: array
        items:
          $pathOf: "#/schemas/Module"
  Module:
    type: object
    required: [moduleId]
    additionalProperties: false
    properties:
      moduleId:
        type: string
stages:
  repository-profile:
    key: repositoryScan
    name: Repository Profile
    role: scan
    group: full-scan
    concurrency: 1
    maxConcurrency: 8
    disableable: false
    description: Repository profiling.
    runtimeConfig:
      agentProfile: repository-agent
      persistent: false
      reuseContainer: true
      mode: serial
      nullableOutput: false
      cwd: /workspace/repo
      skills: [repo-profiler]
      prompt: |
        Profile the repository.
    outputSchema:
      $ref: "#/schemas/RepositoryProfileOutput"
  scan-target:
    key: functionScan
    name: Scan Target
    role: scan
    group: full-scan
    concurrency: 4
    maxConcurrency: 64
    disableable: true
    description: Target-level candidate discovery.
    inputSchema:
      type: object
      required: [modulePath]
      properties:
        modulePath:
          $pathOf: "#/schemas/Module"
  analyze-finding:
    key: analysis
    name: Analyze Finding
    role: analysis
    group: review
    concurrency: 2
    maxConcurrency: 16
    disableable: true
    description: Candidate analysis.
pipelines:
  full:
    name: full-scan-programmatic
    root: repository-profile
    stages:
      - repository-profile
      - scan-target
      - analyze-finding
    edges:
      - name: repository-profile-to-scan-target
        from: repository-profile
        to: scan-target
        fork: false
        mode: fanOut
        foreach: "$.modules[*]"
        input:
          modulePath: "$item"
      - name: scan-target-to-analyze-finding
        from: scan-target
        to: analyze-finding
        fork: false
        mode: map
        outputSchema:
          $ref: "#/schemas/RepositoryProfileOutput"
        outputSchemaDescription: Sample routed output schema
    groups:
      - id: full-scan
        name: Full Scan Pipeline
        leader: repository-profile
        members:
          - scan-target
  delta:
    name: delta-scan-programmatic
    root: scan-target
    stages:
      - scan-target
      - analyze-finding
    edges:
      - name: scan-target-to-analyze-finding
        from: scan-target
        to: analyze-finding
        fork: false
        route:
          key: verification
          default: true
    groups: []
`);

	assert.deepEqual(
		definitions.pipelineIds,
		{
			full: "full",
			delta: "delta",
		},
	);
	assert.deepEqual(definitions.stageIds, [
		"repository-profile",
		"scan-target",
		"analyze-finding",
	]);
	assert.equal(definitions.stageMetadata.repositoryScan?.id, "repository-profile");
	assert.equal(definitions.stageMetadata.functionScan?.id, "scan-target");
	assert.equal(definitions.stageMetadata.analysis?.name, "Analyze Finding");
	assert.equal(definitions.pipelines.full.rootStageId, "repository-profile");
	assert.deepEqual(definitions.pipelines.delta.stageIds, [
		"scan-target",
		"analyze-finding",
	]);
	assert.deepEqual(definitions.pipelines.delta.edges[0]?.route, {
		key: "verification",
		default: true,
	});
	assert.equal(definitions.stageSettings.scanTarget?.disableable, true);
	assert.equal(definitions.stageSettings.repositoryProfile?.disableable, false);
	assert.equal(definitions.stages[0]?.concurrency, 1);
	assert.equal(definitions.stageSettings.repositoryProfile?.concurrency, 1);
	assert.deepEqual(definitions.stages[0]?.runtimeConfig, {
		agentProfile: "repository-agent",
		persistent: false,
		reuseContainer: true,
		mode: "serial",
		nullableOutput: false,
		cwd: "/workspace/repo",
		skills: ["repo-profiler"],
		prompt: "Profile the repository.\n",
		promptFile: null,
		inputArtifacts: null,
		outputSchema: null,
	});
	assert.equal(definitions.schemas.Module?.type, "object");
	assert.deepEqual(definitions.stages[0]?.outputSchema, {
		$ref: "#/schemas/RepositoryProfileOutput",
	});
	assert.equal(definitions.stages[1]?.inputSchema?.type, "object");
	assert.equal(definitions.pipelines.full.edges[0]?.mode, "fanOut");
	assert.equal(definitions.pipelines.full.edges[0]?.foreach, "$.modules[*]");
	assert.deepEqual(definitions.pipelines.full.edges[0]?.input, {
		modulePath: "$item",
	});
	assert.deepEqual(definitions.pipelines.full.edges[1]?.outputSchema, {
		$ref: "#/schemas/RepositoryProfileOutput",
	});
	assert.equal(
		definitions.pipelines.full.edges[1]?.outputSchemaDescription,
		"Sample routed output schema",
	);
});

test("parseScanPipelineDefinitionsFromYaml rejects invalid topology", () => {
	assert.throws(
		() =>
			parseScanPipelineDefinitionsFromYaml(`
stages:
  repository-profile:
    key: repositoryScan
    name: Repository Profile
    role: scan
    group: full-scan
    concurrency: 1
    disableable: false
pipelines:
  full:
    name: full-scan-programmatic
    root: repository-profile
    stages: [repository-profile]
    edges:
      - name: repository-profile-to-missing
        from: repository-profile
        to: missing-stage
    groups: []
  delta:
    name: delta-scan-programmatic
    root: repository-profile
    stages: [repository-profile]
    edges: []
    groups: []
`),
		/unknown target stage missing-stage/,
	);
});

test("parseScanPipelineDefinitionsFromYaml requires concurrency", () => {
	assert.throws(
		() =>
			parseScanPipelineDefinitionsFromYaml(`
stages:
  repository-profile:
    key: repositoryScan
    name: Repository Profile
    role: scan
    group: full-scan
    defaultConcurrency: 1
    disableable: false
pipelines:
  full:
    name: full-scan-programmatic
    root: repository-profile
    stages: [repository-profile]
    edges: []
    groups: []
  delta:
    name: delta-scan-programmatic
    root: repository-profile
    stages: [repository-profile]
    edges: []
    groups: []
`),
		/concurrency/,
	);
});

test("parseScanPipelineDefinitionsFromYaml rejects unknown schema references", () => {
	assert.throws(
		() =>
			parseScanPipelineDefinitionsFromYaml(`
stages:
  repository-profile:
    key: repositoryScan
    name: Repository Profile
    role: scan
    group: full-scan
    concurrency: 1
    disableable: false
    outputSchema:
      $ref: "#/schemas/Missing"
pipelines:
  full:
    name: full-scan-programmatic
    root: repository-profile
    stages: [repository-profile]
    edges: []
    groups: []
  delta:
    name: delta-scan-programmatic
    root: repository-profile
    stages: [repository-profile]
    edges: []
    groups: []
`),
		/Unknown schema reference #\/schemas\/Missing/,
	);
});

test("parseScanPipelineDefinitionsFromYaml rejects invalid edge transform expressions", () => {
	assert.throws(
		() =>
			parseScanPipelineDefinitionsFromYaml(`
schemas:
  SourceOutput:
    type: object
    required: [modules]
    properties:
      modules:
        type: array
        items:
          type: string
  TargetInput:
    type: object
    required: [modulePath]
    properties:
      modulePath:
        type: string
stages:
  source:
    key: source
    name: Source
    role: scan
    group: scan
    concurrency: 1
    outputSchema:
      $ref: "#/schemas/SourceOutput"
  target:
    key: target
    name: Target
    role: scan
    group: scan
    concurrency: 1
    inputSchema:
      $ref: "#/schemas/TargetInput"
pipelines:
  full:
    name: full
    root: source
    stages: [source, target]
    edges:
      - name: source-to-target
        from: source
        to: target
        mode: fanOut
        foreach: "$.missing[*]"
        input:
          modulePath: "$item"
    groups: []
  delta:
    name: delta
    root: source
    stages: [source]
    edges: []
    groups: []
`),
		/unknown output field missing/,
	);

	assert.throws(
		() =>
			parseScanPipelineDefinitionsFromYaml(`
stages:
  source:
    key: source
    name: Source
    role: scan
    group: scan
    concurrency: 1
  target:
    key: target
    name: Target
    role: scan
    group: scan
    concurrency: 1
pipelines:
  full:
    name: full
    root: source
    stages: [source, target]
    edges:
      - name: source-to-target
        from: source
        to: target
        mode: map
        input:
          bad: "$bad.value"
    groups: []
  delta:
    name: delta
    root: source
    stages: [source]
    edges: []
    groups: []
`),
		/Unsupported transform expression/,
	);
});

test("validatePipelineRegistryCoverage rejects missing stage and edge implementations", () => {
	const definitions = parseScanPipelineDefinitionsFromYaml(`
stages:
  repository-profile:
    key: repositoryScan
    name: Repository Profile
    role: scan
    group: full-scan
    concurrency: 1
    disableable: false
  scan-target:
    key: functionScan
    name: Scan Target
    role: scan
    group: full-scan
    concurrency: 4
    disableable: true
pipelines:
  full:
    name: full-scan-programmatic
    root: repository-profile
    stages: [repository-profile, scan-target]
    edges:
      - name: repository-profile-to-scan-target
        from: repository-profile
        to: scan-target
    groups: []
  delta:
    name: delta-scan-programmatic
    root: scan-target
    stages: [scan-target]
    edges: []
    groups: []
`);

	assert.throws(
		() =>
			validatePipelineRegistryCoverage(definitions, {
				stageIds: new Set(["repository-profile"]),
				edgeNames: new Set<string>(),
			}),
		/missing stage implementation: scan-target/,
	);
	assert.throws(
		() =>
			validatePipelineRegistryCoverage(definitions, {
				stageIds: new Set(["repository-profile", "scan-target"]),
				edgeNames: new Set<string>(),
			}),
		/missing edge implementation: repository-profile-to-scan-target/,
	);
});

test("resolveScanPipelineDefinitionsDir resolves the definitions directory", () => {
	const moduleUrl = new URL("./scan-pipeline-definitions.ts", import.meta.url).href;
	const definitionsDir = resolveScanPipelineDefinitionsDir(moduleUrl);

	assert.equal(definitionsDir.endsWith("/definitions"), true);
	assert.equal(definitionsDir.includes("/_next/static/media/"), false);
});

test("resolveScanPipelineDefinitionsDir falls back to bundled runtime assets", () => {
	const definitionsDir = resolveScanPipelineDefinitionsDir(
		"file:///packages/server/dist/services/scan/pipeline/scan-pipeline-definitions.js",
		"/app",
	);

	assert.equal(definitionsDir, "/app/dist/definitions");
});
