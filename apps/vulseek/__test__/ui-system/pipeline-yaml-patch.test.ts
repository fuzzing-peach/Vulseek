import { describe, expect, it } from "vitest";
import { parsePipelineDocumentV3 } from "@vulseek/server/services/scan/pipeline/document-v3";
import {
	patchPipelineYaml,
	patchPreservesValue,
} from "@/lib/pipeline-editor/pipeline-yaml-patch";

// A rich V3 fixture: comments, quoted scalars, a block scalar prompt, flow
// collections, an anchor + alias, and entity order that must survive edits
// to unrelated subtrees.
const FIXTURE = `version: 3
name: "Full Scan" # top-level name comment
description: |-
  Runs a full repository scan.
supportedTargets:
  - project
root: discovery
limits:
  maxTasks: 500
  maxDurationSeconds: 7200
schemas:
  finding-schema:
    type: object
    properties:
      severity: { type: string } # inline flow schema
stages:
  discovery:
    name: &stage-name Discovery
    role: scan
    group: core
    mode: serial
    concurrency: 1
    runtime:
      prompt: |
        Find everything.
        Two lines.
  review:
    name: *stage-name
    role: verification
    group: core
    mode: serial
    concurrency: 1
    runtime:
      prompt: Review findings.
edges:
  - id: discover-to-review # first edge comment
    name: Discover
    from: discovery
    to: review
    mode: map
  - id: review-to-discovery
    name: Rerun
    from: review
    to: discovery
    mode: map
groups:
  - id: core
    name: Core
    leader: discovery
    members:
      - discovery
      - review
ui:
  layoutVersion: 3
  direction: DOWN
  nodes:
    discovery: { x: 10, y: 20 }
    review: { x: 10, y: 200 }
`;

const parseOk = (yaml: string) => {
	const { document, diagnostics } = parsePipelineDocumentV3(yaml);
	expect(document, diagnostics.map((d) => d.message).join("; ")).not.toBeNull();
	return document!;
};

describe("patchPipelineYaml — preservation", () => {
	it("preserves comments, ordering, scalars, and anchors in untouched subtrees", () => {
		const result = patchPipelineYaml(FIXTURE, [
			{
				op: "updateStage",
				stageId: "review",
				stage: {
					name: "Review renamed",
					role: "verification",
					group: "core",
					mode: "serial",
					concurrency: 2,
					runtime: { kind: "agent", prompt: "Review findings.", prepareRepository: "none", includePolicy: false, plugins: [] }, disableable: true, inputArtifacts: [], outputArtifacts: [], effects: [], containerNameParts: [], allowAgentExit: false, promptValues: {},
				},
			},
		]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const out = result.yaml;
		// Untouched subtree keeps its comment and quoted style.
		expect(out).toContain("# top-level name comment");
		expect(out).toContain('name: "Full Scan"');
		// Block scalar and anchor in the untouched stage survive verbatim.
		expect(out).toContain("name: &stage-name Discovery");
		expect(out).toContain("prompt: |");
		expect(out).toContain("Find everything.");
		// Flow style in ui.nodes survives.
		expect(out).toContain("discovery: { x: 10, y: 20 }");
		// Edge order and its comment survive.
		expect(out.indexOf("discover-to-review")).toBeLessThan(
			out.indexOf("review-to-discovery"),
		);
		expect(out).toContain("# first edge comment");
		// The touched stage reflects the new value.
		expect(out).toContain("name: Review renamed");
		// And the patched buffer still parses to the same semantic document.
		const document = parseOk(out);
		expect(document.stages.review?.concurrency).toBe(2);
	});

	it("does not disturb the alias target when an unrelated stage is patched", () => {
		const result = patchPipelineYaml(FIXTURE, [
			{ op: "updateStage", stageId: "review", stage: { name: "R", role: "verification", group: "core", mode: "serial", concurrency: 1, runtime: { kind: "agent", prompt: "p", prepareRepository: "none", includePolicy: false, plugins: [] }, disableable: true, inputArtifacts: [], outputArtifacts: [], effects: [], containerNameParts: [], allowAgentExit: false, promptValues: {} } },
		]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// The alias node at review.name is replaced by the patch (expected
		// normalization), but the anchor declaration itself must remain in
		// the untouched discovery stage so the document still parses.
		const document = parseOk(result.yaml);
		expect(document.stages.discovery?.name).toBe("Discovery");
	});

	it("preserves entity declaration order after an edge update", () => {
		const result = patchPipelineYaml(FIXTURE, [
			{
				op: "updateEdge",
				edgeId: "review-to-discovery",
				edge: { id: "review-to-discovery", name: "Rerun renamed", from: "review", to: "discovery", mode: "map", fork: false, artifacts: [] },
			},
		]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const out = result.yaml;
		expect(out.indexOf("discover-to-review")).toBeLessThan(
			out.indexOf("review-to-discovery"),
		);
		const document = parseOk(out);
		expect(document.edges[1]?.name).toBe("Rerun renamed");
	});
});

describe("patchPipelineYaml — typed ops", () => {
	it("resolves edges and groups by stable id, not array index", () => {
		// Delete the first edge, then update the second by id — the patch
		// must still find it after the array shrank.
		const deleted = patchPipelineYaml(FIXTURE, [{ op: "deleteEdge", edgeId: "discover-to-review" }]);
		expect(deleted.ok).toBe(true);
		if (!deleted.ok) return;
		const updated = patchPipelineYaml(deleted.yaml, [
			{ op: "updateEdge", edgeId: "review-to-discovery", edge: { id: "review-to-discovery", name: "Loop", from: "review", to: "discovery", mode: "map", fork: false, artifacts: [] } },
			{ op: "updateGroup", groupId: "core", group: { id: "core", name: "Core renamed", leader: "review", members: ["review"] } },
		]);
		expect(updated.ok).toBe(true);
		if (!updated.ok) return;
		const document = parseOk(updated.yaml);
		expect(document.edges).toHaveLength(1);
		expect(document.edges[0]?.name).toBe("Loop");
		expect(document.groups[0]?.leader).toBe("review");
	});

	it("adds and deletes stages, edges, groups, and schemas", () => {
		const added = patchPipelineYaml(FIXTURE, [
			{ op: "addStage", stageId: "triage", stage: { name: "Triage", role: "analysis", group: "core", mode: "serial", concurrency: 1, runtime: { kind: "agent", prompt: "Triage.", prepareRepository: "none", includePolicy: false, plugins: [] }, disableable: true, inputArtifacts: [], outputArtifacts: [], effects: [], containerNameParts: [], allowAgentExit: false, promptValues: {} } },
			{ op: "addEdge", edge: { id: "review-to-triage", name: "Hand off", from: "review", to: "triage", mode: "map", fork: false, artifacts: [] } },
			{ op: "addGroup", group: { id: "extra", name: "Extra", leader: "discovery", members: ["discovery"] } },
			{ op: "setSchema", schemaId: "triage-schema", schema: { type: "object", properties: { ok: { type: "boolean" } } } },
		]);
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		let document = parseOk(added.yaml);
		expect(document.stages.triage?.name).toBe("Triage");
		expect(document.edges).toHaveLength(3);
		expect(document.groups).toHaveLength(2);
		expect(document.schemas["triage-schema"]).toBeDefined();

		const deleted = patchPipelineYaml(added.yaml, [
			{ op: "deleteStage", stageId: "triage" },
			{ op: "deleteEdge", edgeId: "review-to-triage" },
			{ op: "deleteGroup", groupId: "extra" },
			{ op: "deleteSchema", schemaId: "triage-schema" },
		]);
		expect(deleted.ok).toBe(true);
		if (!deleted.ok) return;
		document = parseOk(deleted.yaml);
		expect(document.stages.triage).toBeUndefined();
		expect(document.edges).toHaveLength(2);
		expect(document.groups).toHaveLength(1);
		expect(document.schemas["triage-schema"]).toBeUndefined();
	});

	it("rejects duplicate ids on add and missing entities on update", () => {
		const duplicateStage = patchPipelineYaml(FIXTURE, [
			{ op: "addStage", stageId: "discovery", stage: { name: "Dup", role: "scan", group: "core", mode: "serial", concurrency: 1, runtime: { kind: "agent", prompt: "p", prepareRepository: "none", includePolicy: false, plugins: [] }, disableable: true, inputArtifacts: [], outputArtifacts: [], effects: [], containerNameParts: [], allowAgentExit: false, promptValues: {} } },
		]);
		expect(duplicateStage.ok).toBe(false);
		if (duplicateStage.ok) return;
		expect(duplicateStage.error).toContain("duplicate stage id");
		const duplicate = patchPipelineYaml(FIXTURE, [
			{ op: "addEdge", edge: { id: "discover-to-review", name: "Dup", from: "discovery", to: "review", mode: "map", fork: false, artifacts: [] } },
		]);
		expect(duplicate.ok).toBe(false);
		const missing = patchPipelineYaml(FIXTURE, [{ op: "updateEdge", edgeId: "nope", edge: { id: "nope", name: "x", from: "a", to: "b", mode: "map", fork: false, artifacts: [] } }]);
		expect(missing.ok).toBe(false);
		const missingStage = patchPipelineYaml(FIXTURE, [{ op: "moveNode", stageId: "ghost", position: { x: 1, y: 1 } }]);
		expect(missingStage.ok).toBe(false);
	});

	it("applies overview, limits, moveNode, and layout ops", () => {
		const result = patchPipelineYaml(FIXTURE, [
			{ op: "updateOverview", overview: { name: "Renamed scan", description: "New description" } },
			{ op: "updateLimits", limits: { maxTasks: 900, maxDurationSeconds: 10_000 } },
			{ op: "moveNode", stageId: "review", position: { x: 300, y: 400 } },
			{ op: "updateLayout", layout: { direction: "RIGHT" } },
		]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const document = parseOk(result.yaml);
		expect(document.name).toBe("Renamed scan");
		expect(document.description).toBe("New description");
		expect(document.limits?.maxTasks).toBe(900);
		expect(document.ui?.nodes?.review).toEqual({ x: 300, y: 400 });
		expect(document.ui?.direction).toBe("RIGHT");
		expect(document.ui?.layoutVersion).toBe(3);

		const reset = patchPipelineYaml(result.yaml, [{ op: "resetLayout" }]);
		expect(reset.ok).toBe(true);
		if (!reset.ok) return;
		expect(parseOk(reset.yaml).ui).toBeUndefined();
	});

	it("patching ui into a document without ui creates it", () => {
		const bare = `version: 3
name: bare
supportedTargets:
  - project
root: a
stages:
  a:
    name: A
    role: scan
    group: g
    mode: serial
    concurrency: 1
    runtime:
      prompt: p
edges: []
groups: []
`;
		const result = patchPipelineYaml(bare, [
			{ op: "moveNode", stageId: "a", position: { x: 5, y: 5 } },
		]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const document = parseOk(result.yaml);
		expect(document.ui?.nodes?.a).toEqual({ x: 5, y: 5 });
	});
});

describe("patchPipelineYaml — invalid intermediate input", () => {
	it("fails cleanly on syntax errors without corrupting the buffer", () => {
		const broken = "version: 3\nstages:\n  a: [broken";
		const result = patchPipelineYaml(broken, [
			{ op: "updateStage", stageId: "a", stage: { name: "A", role: "scan", group: "g", mode: "serial", concurrency: 1, runtime: { kind: "agent", prompt: "p", prepareRepository: "none", includePolicy: false, plugins: [] }, disableable: true, inputArtifacts: [], outputArtifacts: [], effects: [], containerNameParts: [], allowAgentExit: false, promptValues: {} } },
		]);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.length).toBeGreaterThan(0);
	});

	it("fails cleanly on an empty buffer", () => {
		const result = patchPipelineYaml("", [{ op: "resetLayout" }]);
		expect(result.ok).toBe(false);
	});

	it("treats an identical patch as a text no-op", () => {
		const result = patchPipelineYaml(FIXTURE, [
			{ op: "updateOverview", overview: { name: "Full Scan" } },
		]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// Same semantic value: the buffer must not change.
		expect(result.yaml).toBe(FIXTURE);
	});

	it("keeps untouched semantics identical after a patch (patchPreservesValue)", () => {
		const patched = patchPipelineYaml(FIXTURE, [
			{ op: "updateEdge", edgeId: "discover-to-review", edge: { id: "discover-to-review", name: "Discover", from: "discovery", to: "review", mode: "map", fork: false, artifacts: [] } },
		]);
		expect(patched.ok).toBe(true);
		if (!patched.ok) return;
		const before = parseOk(FIXTURE);
		const after = parseOk(patched.yaml);
		// Semantic values of the untouched subtrees are equal.
		expect(after.stages).toEqual(before.stages);
		expect(after.groups).toEqual(before.groups);
		// The untouched edge's semantic value survives byte-for-byte.
		expect(after.edges[1]).toEqual(before.edges[1]);
	});
});
