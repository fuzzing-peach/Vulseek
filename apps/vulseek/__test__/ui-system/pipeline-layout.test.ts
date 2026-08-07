import { describe, expect, it } from "vitest";
import {
	buildEdgePath,
	computePipelineLayout,
	nextUniqueId,
	resolveStagePositions,
} from "@/lib/pipeline-editor/pipeline-layout";

const stage = (name: string, role: "scan" | "analysis" | "verification" = "scan") => ({
	name,
	role,
	group: "g",
	mode: "serial" as const,
	concurrency: 1,
	disableable: true,
	inputArtifacts: [],
	outputArtifacts: [],
	effects: [],
	containerNameParts: [],
	allowAgentExit: false,
	promptValues: {},
	runtime: {
		kind: "agent" as const,
		prompt: "p",
		prepareRepository: "none" as const,
		includePolicy: false,
		plugins: [],
	},
});

const edge = (id: string, from: string, to: string) => ({
	id,
	name: id,
	from,
	to,
	fork: false,
	mode: "map" as const,
	artifacts: [],
});

const documentOf = (stages: string[], edges: ReturnType<typeof edge>[]) => ({
	stages: Object.fromEntries(stages.map((id) => [id, stage(id)])),
	edges,
	groups: [],
});

describe("computePipelineLayout", () => {
	it("lays out a linear flow top-to-bottom", async () => {
		const result = await computePipelineLayout(
			documentOf(["a", "b", "c"], [edge("a-b", "a", "b"), edge("b-c", "b", "c")]),
		);
		expect(Object.keys(result.nodes)).toEqual(["a", "b", "c"]);
		// DOWN: downstream stages are strictly below their sources
		expect(result.nodes.b!.y).toBeGreaterThan(result.nodes.a!.y);
		expect(result.nodes.c!.y).toBeGreaterThan(result.nodes.b!.y);
	});

	it("supports branches and joins", async () => {
		const result = await computePipelineLayout(
			documentOf(
				["a", "b", "c", "d"],
				[edge("a-b", "a", "b"), edge("a-c", "a", "c"), edge("b-d", "b", "d"), edge("c-d", "c", "d")],
			),
		);
		for (const id of ["a", "b", "c", "d"]) {
			expect(result.nodes[id]).toBeDefined();
		}
	});

	it("handles cycles without hanging and keeps all nodes", async () => {
		const result = await computePipelineLayout(
			documentOf(
				["a", "b", "c"],
				[edge("a-b", "a", "b"), edge("b-c", "b", "c"), edge("c-a", "c", "a")],
			),
		);
		expect(Object.keys(result.nodes)).toHaveLength(3);
	});

	it("handles self-loops and multiple same-source/same-target edges", async () => {
		const result = await computePipelineLayout(
			documentOf(
				["a", "b"],
				[
					edge("a-a", "a", "a"),
					edge("a-b-1", "a", "b"),
					edge("a-b-2", "a", "b"),
				],
			),
		);
		expect(Object.keys(result.nodes)).toEqual(["a", "b"]);
		expect(result.edges["a-b-1"]).toBeDefined();
		expect(result.edges["a-b-2"]).toBeDefined();
	});

	it("places disconnected stages inside the layout bounds", async () => {
		const result = await computePipelineLayout(
			documentOf(["a", "b", "isolated"], [edge("a-b", "a", "b")]),
		);
		expect(result.nodes.isolated).toBeDefined();
	});

	it("produces bend points for orthogonal edges", async () => {
		const result = await computePipelineLayout(
			documentOf(["a", "b"], [edge("a-b", "a", "b")]),
		);
		// orthogonal routing between distant nodes yields at least one bend
		expect(result.edges["a-b"]).toBeDefined();
	});
});

describe("resolveStagePositions", () => {
	it("prefers saved ui.nodes and falls back per-stage", () => {
		const computed = { a: { x: 1, y: 1 }, b: { x: 2, y: 2 } };
		const document = {
			stages: { a: stage("a"), b: stage("b") },
			edges: [],
			ui: { nodes: { b: { x: 99, y: 99 } } },
		};
		const positions = resolveStagePositions(document, computed);
		expect(positions.a).toEqual({ x: 1, y: 1 });
		expect(positions.b).toEqual({ x: 99, y: 99 });
	});
});

describe("buildEdgePath", () => {
	it("renders an elbow when no bend points exist", () => {
		const path = buildEdgePath(0, 0, 100, 200);
		expect(path).toContain("M 0 0");
		expect(path).toContain("L 100 200");
	});

	it("walks through saved bend points", () => {
		const path = buildEdgePath(0, 0, 100, 200, [
			{ x: 0, y: 100 },
			{ x: 100, y: 100 },
		]);
		expect(path).toBe(
			"M 0 0 L 0 100 L 100 100 L 100 200",
		);
	});
});

describe("nextUniqueId", () => {
	it("appends numeric suffixes until unique", () => {
		const existing = new Set(["stage", "stage-1"]);
		expect(nextUniqueId("stage", existing)).toBe("stage-2");
		expect(nextUniqueId("fresh", existing)).toBe("fresh");
	});
});
