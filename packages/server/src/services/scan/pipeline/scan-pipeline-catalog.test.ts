import assert from "node:assert/strict";
import test from "node:test";
import {
	parseScanPipelineCatalogFromYaml,
	scanPipelineYamlUrlToPath,
	validatePipelineRegistryCoverage,
} from "./scan-pipeline-catalog";

test("parseScanPipelineCatalogFromYaml parses full and delta pipeline topology", () => {
	const catalog = parseScanPipelineCatalogFromYaml(`
stages:
  repository-profile:
    key: repositoryScan
    name: Repository Profile
    role: scan
    group: full-scan
    defaultConcurrency: 1
    maxConcurrency: 8
    disableable: false
    description: Repository profiling.
  scan-target:
    key: functionScan
    name: Scan Target
    role: scan
    group: full-scan
    defaultConcurrency: 4
    maxConcurrency: 64
    disableable: true
    description: Target-level candidate discovery.
  analyze-finding:
    key: analysis
    name: Analyze Finding
    role: analysis
    group: review
    defaultConcurrency: 2
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
      - name: scan-target-to-analyze-finding
        from: scan-target
        to: analyze-finding
        fork: false
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
		catalog.pipelineIds,
		{
			full: "full",
			delta: "delta",
		},
	);
	assert.deepEqual(catalog.stageIds, [
		"repository-profile",
		"scan-target",
		"analyze-finding",
	]);
	assert.equal(catalog.stageMetadata.repositoryScan?.id, "repository-profile");
	assert.equal(catalog.stageMetadata.functionScan?.id, "scan-target");
	assert.equal(catalog.stageMetadata.analysis?.name, "Analyze Finding");
	assert.equal(catalog.pipelines.full.rootStageId, "repository-profile");
	assert.deepEqual(catalog.pipelines.delta.stageIds, [
		"scan-target",
		"analyze-finding",
	]);
	assert.deepEqual(catalog.pipelines.delta.edges[0]?.route, {
		key: "verification",
		default: true,
	});
	assert.equal(catalog.stageSettings.scanTarget?.disableable, true);
	assert.equal(catalog.stageSettings.repositoryProfile?.disableable, false);
});

test("parseScanPipelineCatalogFromYaml rejects invalid topology", () => {
	assert.throws(
		() =>
			parseScanPipelineCatalogFromYaml(`
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

test("validatePipelineRegistryCoverage rejects missing stage and edge implementations", () => {
	const catalog = parseScanPipelineCatalogFromYaml(`
stages:
  repository-profile:
    key: repositoryScan
    name: Repository Profile
    role: scan
    group: full-scan
    defaultConcurrency: 1
    disableable: false
  scan-target:
    key: functionScan
    name: Scan Target
    role: scan
    group: full-scan
    defaultConcurrency: 4
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
			validatePipelineRegistryCoverage(catalog, {
				stageIds: new Set(["repository-profile"]),
				edgeNames: new Set<string>(),
			}),
		/missing stage implementation: scan-target/,
	);
	assert.throws(
		() =>
			validatePipelineRegistryCoverage(catalog, {
				stageIds: new Set(["repository-profile", "scan-target"]),
				edgeNames: new Set<string>(),
			}),
		/missing edge implementation: repository-profile-to-scan-target/,
	);
});

test("scanPipelineYamlUrlToPath accepts URL-like objects from other runtimes", () => {
	const urlLikeFromAnotherRuntime = {
		href: new URL("./scan-pipelines.yaml", import.meta.url).href,
	};

	assert.equal(
		scanPipelineYamlUrlToPath(urlLikeFromAnotherRuntime).endsWith(
			"/scan-pipelines.yaml",
		),
		true,
	);
});
