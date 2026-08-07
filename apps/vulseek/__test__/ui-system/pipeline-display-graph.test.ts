import { describe, expect, it } from "vitest";
import {
	buildPipelineDisplayGraph,
	classifyEdge,
	computeStageRanks,
	displayLabelForEdge,
} from "@/lib/pipeline-editor/pipeline-display-graph";

const stage = (
	name: string,
	role: "scan" | "analysis" | "verification" = "scan",
) => ({
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

const edge = (
	id: string,
	from: string,
	to: string,
	overrides: { name?: string; route?: { key: string; default?: boolean } } = {},
) => ({
	id,
	name: overrides.name ?? id,
	from,
	to,
	fork: false,
	mode: "map" as const,
	artifacts: [],
	...(overrides.route ? { route: overrides.route } : {}),
});

const documentOf = (
	stages: string[],
	edges: ReturnType<typeof edge>[],
	root = stages[0]!,
) => ({
	stages: Object.fromEntries(stages.map((id) => [id, stage(id)])),
	edges,
	root,
});

describe("computeStageRanks", () => {
	it("puts the configured root first regardless of declaration order", () => {
		const ranks = computeStageRanks(documentOf(["a", "b", "c"], [], "b"));
		expect(ranks.get("b")).toBe(0);
		// declaration order preserved for the rest
		expect(ranks.get("a")).toBeLessThan(ranks.get("c")!);
	});

	it("hoists forward-reachable stages above unreachable ones", () => {
		// root -> x (declared later), while y is declared early but isolated
		const ranks = computeStageRanks(
			documentOf(["a", "b", "c"], [edge("a-b", "a", "b")]),
		);
		expect(ranks.get("a")).toBe(0);
		expect(ranks.get("b")).toBe(1); // reachable from root
		expect(ranks.get("c")).toBe(2); // unreachable, after reachable
	});

	it("is deterministic for identical input", () => {
		const document = documentOf(
			["a", "b", "c", "d"],
			[edge("a-b", "a", "b"), edge("b-d", "b", "d")],
		);
		const first = computeStageRanks(document);
		const second = computeStageRanks(document);
		expect([...first.entries()]).toEqual([...second.entries()]);
	});
});

describe("classifyEdge", () => {
	it("classifies forward edges (target rank greater than source)", () => {
		const document = documentOf(
			["a", "b", "c"],
			[edge("a-b", "a", "b"), edge("b-c", "b", "c")],
		);
		const ranks = computeStageRanks(document);
		expect(classifyEdge(edge("a-b", "a", "b"), ranks)).toBe("forward");
	});

	it("classifies same-rank edges as feedback", () => {
		const document = documentOf(["a", "b"], [edge("b-a", "b", "a")]);
		const ranks = computeStageRanks(document);
		expect(classifyEdge(edge("b-a", "b", "a"), ranks)).toBe("feedback");
	});

	it("classifies self-loops as feedback", () => {
		const document = documentOf(["a"], [edge("a-a", "a", "a")]);
		const ranks = computeStageRanks(document);
		expect(classifyEdge(edge("a-a", "a", "a"), ranks)).toBe("feedback");
	});
});

describe("buildPipelineDisplayGraph", () => {
	it("keeps one display node per stage with root first", () => {
		const graph = buildPipelineDisplayGraph(
			documentOf(["a", "b", "c"], [edge("a-b", "a", "b")]),
		);
		expect(graph.nodes.size).toBe(3);
		expect(graph.stageOrder[0]).toBe("a");
		expect(graph.nodes.get("a")?.isRoot).toBe(true);
	});

	it("groups parallel edges into one display edge with member labels", () => {
		const graph = buildPipelineDisplayGraph(
			documentOf(
				["a", "b"],
				[
					edge("e1", "a", "b", { route: { key: "continue", default: true } }),
					edge("e2", "a", "b", { route: { key: "exhausted" } }),
					edge("e3", "a", "b", { route: { key: "blocked" } }),
				],
			),
		);
		expect(graph.edges).toHaveLength(1);
		const display = graph.edges[0]!;
		expect(display.from).toBe("a");
		expect(display.to).toBe("b");
		expect(display.memberEdgeIds).toEqual(["e1", "e2", "e3"]);
		expect(display.labels.map((label) => label.label)).toEqual([
			"continue",
			"exhausted",
			"blocked",
		]);
		// default member is marked
		expect(
			display.labels.find((label) => label.edgeId === "e1")?.isDefault,
		).toBe(true);
	});

	it("maps every original edge to exactly one display group", () => {
		const document = documentOf(
			["a", "b", "c"],
			[
				edge("e1", "a", "b"),
				edge("e2", "a", "b"),
				edge("e3", "b", "c"),
				edge("e4", "c", "a"), // feedback
			],
		);
		const graph = buildPipelineDisplayGraph(document);
		expect(graph.edges).toHaveLength(3); // e1+e2 merged, e3, e4
		expect(graph.edgeToDisplay.size).toBe(4);
		// each original id maps somewhere
		for (const edge of document.edges) {
			expect(graph.edgeToDisplay.has(edge.id)).toBe(true);
		}
	});

	it("classifies grouped feedback edges as feedback", () => {
		const graph = buildPipelineDisplayGraph(
			documentOf(["a", "b"], [edge("e1", "b", "a"), edge("e2", "b", "a")]),
		);
		expect(graph.edges).toHaveLength(1);
		expect(graph.edges[0]?.kind).toBe("feedback");
	});

	it("marks root-first forward progression and local loops without hardcoding names", () => {
		// A research-shaped fixture: root -> ... with a local review loop
		const graph = buildPipelineDisplayGraph(
			documentOf(
				["root", "discovery", "review", "plan", "report"],
				[
					edge("r-d", "root", "discovery"),
					edge("d-rv", "discovery", "review"),
					edge("rv-r", "review", "root"), // feedback loop
					edge("rv-p", "review", "plan"),
					edge("p-rep", "plan", "report"),
				],
			),
		);
		expect(graph.nodes.get("root")?.rank).toBe(0);
		// review -> root is a feedback edge
		const loop = graph.edges.find(
			(item) => item.from === "review" && item.to === "root",
		);
		expect(loop?.kind).toBe("feedback");
		// main progression stays forward
		const main = graph.edges.find(
			(item) => item.from === "root" && item.to === "discovery",
		);
		expect(main?.kind).toBe("forward");
		// report remains terminal: nothing leaves it
		expect(graph.edges.some((item) => item.from === "report")).toBe(false);
	});

	it("keeps unreachable components after the reachable graph", () => {
		const graph = buildPipelineDisplayGraph(
			documentOf(
				["a", "b", "x", "y"],
				[edge("a-b", "a", "b"), edge("x-y", "x", "y")],
			),
		);
		const order = graph.stageOrder;
		expect(order.indexOf("a")).toBeLessThan(order.indexOf("x")!);
		expect(order.indexOf("b")).toBeLessThan(order.indexOf("x")!);
	});
});

describe("displayLabelForEdge", () => {
	it("prefers route.key, then name, then default", () => {
		expect(
			displayLabelForEdge(edge("e", "a", "b", { route: { key: "continue" } })),
		).toBe("continue");
		expect(displayLabelForEdge(edge("e", "a", "b", { name: "my-edge" }))).toBe(
			"my-edge",
		);
		expect(displayLabelForEdge(edge("e", "a", "b", { name: "" }))).toBe(
			"default",
		);
	});
});
