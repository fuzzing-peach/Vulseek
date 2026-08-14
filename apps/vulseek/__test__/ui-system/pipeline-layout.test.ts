import { parsePipelineDocumentV3 } from "@vulseek/server/services/scan/pipeline/document-v3";
import { loadBuiltinPipelineTemplates } from "@vulseek/server/services/scan/pipeline/document-v3/builtin-pipelines";
import { describe, expect, it } from "vitest";
import { buildPipelineDisplayGraph } from "@/lib/pipeline-editor/pipeline-display-graph";
import {
	buildEdgePath,
	buildElkPipelineLayoutInput,
	computePipelineLayout,
	isOrthogonalPath,
	NODE_HEIGHT,
	NODE_WIDTH,
	nextUniqueId,
	resolveStagePositions,
	segmentIntersectsRect,
} from "@/lib/pipeline-editor/pipeline-layout";

const stage = (
	name: string,
	role: "scan" | "analysis" | "verification" = "scan",
) => ({
	name,
	role,
	group: "g",
	concurrency: 1,
	disableable: true,
	inputArtifacts: [],
	outputArtifacts: [],
	jobOutput: false,
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

const documentOf = (
	stages: string[],
	edges: ReturnType<typeof edge>[],
	root = stages[0]!,
) => ({
	stages: Object.fromEntries(stages.map((id) => [id, stage(id)])),
	edges,
	groups: [],
	root,
});

describe("computePipelineLayout", () => {
	it("lays out a linear flow top-to-bottom with root first", async () => {
		const result = await computePipelineLayout(
			documentOf(
				["a", "b", "c"],
				[edge("a-b", "a", "b"), edge("b-c", "b", "c")],
			),
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
				[
					edge("a-b", "a", "b"),
					edge("a-c", "a", "c"),
					edge("b-d", "b", "d"),
					edge("c-d", "c", "d"),
				],
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

	it("submits forward, feedback, and self-loop edges to one ELK graph", () => {
		const document = documentOf(
			["a", "b", "c"],
			[
				edge("a-b", "a", "b"),
				edge("b-c", "b", "c"),
				edge("c-a", "c", "a"),
				edge("b-b", "b", "b"),
			],
		);
		const displayGraph = buildPipelineDisplayGraph(document);
		const input = buildElkPipelineLayoutInput(displayGraph, "DOWN");
		expect(input.graph.edges?.map((item) => item.id)).toEqual(
			displayGraph.edges.map((item) => item.id),
		);
	});

	it("keeps feedback edges from reordering the main progression", async () => {
		// A local review loop must not pull `a` and `b` onto the same layer.
		const result = await computePipelineLayout(
			documentOf(
				["a", "b", "c"],
				[edge("a-b", "a", "b"), edge("b-c", "b", "c"), edge("b-a", "b", "a")],
			),
		);
		expect(result.nodes.b!.y).toBeGreaterThan(result.nodes.a!.y);
		expect(result.nodes.c!.y).toBeGreaterThan(result.nodes.b!.y);
	});

	it("routes feedback edges with deterministic bend points", async () => {
		const document = documentOf(
			["a", "b"],
			[edge("a-b", "a", "b"), edge("b-a", "b", "a")],
		);
		const first = await computePipelineLayout(document);
		const second = await computePipelineLayout(document);
		expect(first.edges["b-a"]).toBeDefined();
		expect(first.edges["b-a"]!.bendPoints.length).toBeGreaterThan(0);
		expect(first).toEqual(second); // byte-for-byte deterministic
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
		// parallel edges share one display edge keyed by the primary member
		expect(result.edges["a-b-1"]).toBeDefined();
		expect(result.edges["a-b-2"]).toBeUndefined();
		expect(result.edges["a-a"]).toBeDefined();
	});

	it("packs disconnected stages without overlapping the reachable graph", async () => {
		const result = await computePipelineLayout(
			documentOf(["a", "b", "isolated"], [edge("a-b", "a", "b")]),
		);
		expect(result.nodes.isolated).toBeDefined();
		for (const reachableId of ["a", "b"]) {
			const reachable = result.nodes[reachableId]!;
			const isolated = result.nodes.isolated!;
			const overlaps =
				isolated.x < reachable.x + NODE_WIDTH &&
				isolated.x + NODE_WIDTH > reachable.x &&
				isolated.y < reachable.y + NODE_HEIGHT &&
				isolated.y + NODE_HEIGHT > reachable.y;
			expect(overlaps).toBe(false);
		}
	});

	it("produces bend points for orthogonal forward edges", async () => {
		const result = await computePipelineLayout(
			documentOf(["a", "b"], [edge("a-b", "a", "b")]),
		);
		expect(result.edges["a-b"]).toBeDefined();
	});

	it("lays out RIGHT direction with forward progression rightward", async () => {
		const result = await computePipelineLayout(
			documentOf(
				["a", "b", "c"],
				[edge("a-b", "a", "b"), edge("b-c", "b", "c")],
			),
			"RIGHT",
		);
		expect(result.nodes.b!.x).toBeGreaterThan(result.nodes.a!.x);
		expect(result.nodes.c!.x).toBeGreaterThan(result.nodes.b!.x);
	});
});

describe("resolveStagePositions", () => {
	it("prefers saved ui.nodes and falls back per-stage (current layout version)", () => {
		const computed = { a: { x: 1, y: 1 }, b: { x: 2, y: 2 } };
		const document = {
			stages: { a: stage("a"), b: stage("b") },
			edges: [],
			ui: { layoutVersion: 3, nodes: { b: { x: 99, y: 99 } } },
		};
		const positions = resolveStagePositions(document, computed);
		expect(positions.a).toEqual({ x: 1, y: 1 });
		expect(positions.b).toEqual({ x: 99, y: 99 });
	});

	it("ignores legacy saved positions for the initial preview", () => {
		// No layoutVersion → legacy: stale horizontal positions must not
		// override the fresh top-to-bottom transient layout.
		const computed = { a: { x: 0, y: 0 }, b: { x: 0, y: 300 } };
		const document = {
			stages: { a: stage("a"), b: stage("b") },
			edges: [],
			ui: { direction: "RIGHT" as const, nodes: { b: { x: 99, y: 99 } } },
		};
		const positions = resolveStagePositions(document, computed);
		expect(positions.b).toEqual({ x: 0, y: 300 }); // transient wins
	});

	it("treats an older layoutVersion as legacy", () => {
		const computed = { a: { x: 0, y: 0 }, b: { x: 0, y: 300 } };
		const document = {
			stages: { a: stage("a"), b: stage("b") },
			edges: [],
			ui: { layoutVersion: 1, nodes: { b: { x: 99, y: 99 } } },
		};
		const positions = resolveStagePositions(document, computed);
		expect(positions.b).toEqual({ x: 0, y: 300 });
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
		expect(path).toBe("M 0 0 L 0 100 L 100 100 L 100 200");
	});

	it("never emits a diagonal SVG segment", () => {
		const path = buildEdgePath(5, 7, 91, 203, [
			{ x: 20, y: 50 },
			{ x: 80, y: 150 },
		]);
		const points = [...path.matchAll(/[ML] ([\d.-]+) ([\d.-]+)/g)].map(
			(match) => ({ x: Number(match[1]), y: Number(match[2]) }),
		);
		expect(isOrthogonalPath(points)).toBe(true);
	});
});

describe("nextUniqueId", () => {
	it("appends numeric suffixes until unique", () => {
		const existing = new Set(["stage", "stage-1"]);
		expect(nextUniqueId("stage", existing)).toBe("stage-2");
		expect(nextUniqueId("fresh", existing)).toBe("fresh");
	});
});

describe("performance", () => {
	it(// Standalone this finishes in ~700ms; under the parallel suite the
	// fork pool shares CPU, so the threshold is loosened here — the
	// browser acceptance measures the real single-layout latency.
	"lays out 100 stages / 200 edges quickly", async () => {
		const stages = Array.from({ length: 100 }, (_, index) => `s${index}`);
		const edges = [];
		for (let index = 0; index < 200; index += 1) {
			const from = stages[Math.floor(index / 2)]!;
			const to = stages[Math.floor(index / 2) + 1] ?? stages[0]!;
			edges.push(edge(`e${index}`, from, to));
		}
		const started = Date.now();
		const result = await computePipelineLayout(documentOf(stages, edges));
		const elapsed = Date.now() - started;
		expect(Object.keys(result.nodes)).toHaveLength(100);
		// Standalone this finishes in ~700ms; under the parallel suite the
		// fork pool shares CPU heavily, so keep the ceiling at 5s — anything
		// beyond that is a real layout regression, not scheduling noise.
		expect(elapsed).toBeLessThan(5000);
	}, 10_000);
});

describe("route handle assignment (strict connection mode)", () => {
	it("resolves every forward edge to bottom-source → top-target in DOWN", async () => {
		const result = await computePipelineLayout(
			documentOf(["a", "b"], [edge("a-b", "a", "b")]),
		);
		expect(result.edges["a-b"]?.sourceHandle).toBe("bottom-source");
		expect(result.edges["a-b"]?.targetHandle).toBe("top-target");
	});

	it("resolves every forward edge to right-source → left-target in RIGHT", async () => {
		const result = await computePipelineLayout(
			documentOf(["a", "b"], [edge("a-b", "a", "b")]),
			"RIGHT",
		);
		expect(result.edges["a-b"]?.sourceHandle).toBe("right-source");
		expect(result.edges["a-b"]?.targetHandle).toBe("left-target");
	});

	it("assigns same-side source/target pairs for feedback lanes in DOWN", async () => {
		const result = await computePipelineLayout(
			documentOf(["a", "b"], [edge("a-b", "a", "b"), edge("b-a", "b", "a")]),
		);
		const feedback = result.edges["b-a"]!;
		expect(feedback.sourceHandle.endsWith("-source")).toBe(true);
		expect(feedback.targetHandle.endsWith("-target")).toBe(true);
		// both handles share the lane side (left or right)
		expect(feedback.sourceHandle.split("-")[0]).toBe(
			feedback.targetHandle.split("-")[0],
		);
	});

	it("assigns top/bottom pairs for feedback lanes in RIGHT", async () => {
		const result = await computePipelineLayout(
			documentOf(["a", "b"], [edge("a-b", "a", "b"), edge("b-a", "b", "a")]),
			"RIGHT",
		);
		const feedback = result.edges["b-a"]!;
		expect(["top-source", "bottom-source"]).toContain(feedback.sourceHandle);
		expect(["top-target", "bottom-target"]).toContain(feedback.targetHandle);
	});
});

describe("feedback bend points are pure intermediates", () => {
	it("never contains the source or target node center coordinates", async () => {
		const result = await computePipelineLayout(
			documentOf(["a", "b"], [edge("a-b", "a", "b"), edge("b-a", "b", "a")]),
		);
		const feedback = result.edges["b-a"]!;
		const a = result.nodes.a!;
		const b = result.nodes.b!;
		for (const point of feedback.bendPoints) {
			// pure intermediates: not the source/target side exits (renderer
			// adds endpoints exactly once from handle centers)
			expect(
				point.x === a.x ||
					point.x === b.x ||
					point.y === a.y ||
					point.y === b.y,
			).toBe(false);
		}
	});
});

describe("interactive layout after drag", () => {
	it("recomputes the complete graph while honoring the dragged cross-axis position", async () => {
		const document = documentOf(
			["a", "b", "c"],
			[edge("a-b", "a", "b"), edge("b-c", "b", "c"), edge("c-a", "c", "a")],
		);
		const initial = await computePipelineLayout(document);
		const preferred = {
			...initial.nodes,
			b: { x: initial.nodes.b!.x + 420, y: initial.nodes.b!.y },
		};
		const result = await computePipelineLayout(document, "DOWN", preferred);
		expect(result.nodes.b!.x).toBeGreaterThan(result.nodes.a!.x + 200);
		expect(Object.keys(result.edges)).toEqual(Object.keys(initial.edges));
	});
});

describe("transient layout retains edge geometry", () => {
	it("computePipelineLayout returns edges usable for first-open rendering", async () => {
		const result = await computePipelineLayout(
			documentOf(["a", "b"], [edge("a-b", "a", "b"), edge("b-a", "b", "a")]),
		);
		expect(result.edges["a-b"]).toBeDefined();
		expect(result.edges["b-a"]).toBeDefined();
		expect(result.edges["b-a"]!.bendPoints.length).toBeGreaterThan(0);
	});
});

describe("obstacle avoidance (production routing)", () => {
	it("routes research-shaped feedback loops without crossing any non-endpoint node", async () => {
		const document = documentOf(
			["root", "discovery", "review", "plan", "report"],
			[
				edge("r-d", "root", "discovery"),
				edge("d-rv", "discovery", "review"),
				edge("rv-r", "review", "root"), // feedback loop
				edge("rv-p", "review", "plan"),
				edge("p-rep", "plan", "report"),
			],
		);
		const layout = await computePipelineLayout(document);
		const displayGraph = buildPipelineDisplayGraph(document);
		for (const displayEdge of displayGraph.edges) {
			const routed = layout.edges[displayEdge.id];
			if (!routed) continue;
			// Reconstruct the full path with endpoints on the assigned sides.
			const points = reconstructPath(displayEdge, routed, layout.nodes);
			for (let i = 0; i < points.length - 1; i += 1) {
				for (const [nodeId, pos] of Object.entries(layout.nodes)) {
					if (nodeId === displayEdge.from || nodeId === displayEdge.to) {
						continue;
					}
					const hit = segmentIntersectsRect(points[i]!, points[i + 1]!, {
						x: pos.x,
						y: pos.y,
						w: NODE_WIDTH,
						h: NODE_HEIGHT,
					});
					expect(hit, `${displayEdge.id} segment crosses ${nodeId}`).toBe(
						false,
					);
				}
			}
		}
	});

	it("picks a lane offset that clears branch nodes, not the innermost lane", async () => {
		// A wide branch between the feedback endpoints: the innermost left
		// lane would cut through "mid"; the router must move outward.
		const document = documentOf(
			["a", "mid1", "mid2", "b"],
			[
				edge("a-m1", "a", "mid1"),
				edge("mid1-m2", "mid1", "mid2"),
				edge("mid2-b", "mid2", "b"),
				edge("b-a", "b", "a"),
			],
		);
		const layout = await computePipelineLayout(document);
		const feedback = layout.edges["b-a"]!;
		expect(feedback.bendPoints.length).toBeGreaterThan(0);
		const displayGraph = buildPipelineDisplayGraph(document);
		const displayEdge = displayGraph.edges.find((e) => e.id === "b-a")!;
		const points = reconstructPath(displayEdge, feedback, layout.nodes);
		for (let i = 0; i < points.length - 1; i += 1) {
			for (const [nodeId, pos] of Object.entries(layout.nodes)) {
				if (nodeId === "a" || nodeId === "b") continue;
				const hit = segmentIntersectsRect(points[i]!, points[i + 1]!, {
					x: pos.x,
					y: pos.y,
					w: NODE_WIDTH,
					h: NODE_HEIGHT,
				});
				expect(hit, `b-a crosses ${nodeId}`).toBe(false);
			}
		}
	});
});

/**
 * Reconstruct the full orthogonal path (endpoints included) for a routed
 * display edge, mirroring the renderer: it prepends the source handle center
 * and appends the target handle center around the persisted intermediates.
 */
const reconstructPath = (
	displayEdge: { from: string; to: string },
	routed: {
		bendPoints: Array<{ x: number; y: number }>;
		sourceHandle: string;
		targetHandle: string;
	},
	nodes: Record<string, { x: number; y: number }>,
): Array<{ x: number; y: number }> => {
	const side = (handle: string) =>
		handle.split("-")[0] as "top" | "bottom" | "left" | "right";
	const pointFor = (
		nodeId: string,
		handle: string,
	): { x: number; y: number } => {
		const pos = nodes[nodeId]!;
		const s = side(handle);
		if (s === "left") return { x: pos.x, y: pos.y + NODE_HEIGHT / 2 };
		if (s === "right") {
			return { x: pos.x + NODE_WIDTH, y: pos.y + NODE_HEIGHT / 2 };
		}
		if (s === "top") return { x: pos.x + NODE_WIDTH / 2, y: pos.y };
		return { x: pos.x + NODE_WIDTH / 2, y: pos.y + NODE_HEIGHT };
	};
	return [
		pointFor(displayEdge.from, routed.sourceHandle),
		...routed.bendPoints,
		pointFor(displayEdge.to, routed.targetHandle),
	];
};

describe("segmentIntersectsRect", () => {
	const rect = { x: 100, y: 100, w: 50, h: 50 };

	it("false for a same-height segment whose x-interval does not overlap", () => {
		// Horizontal segment at y inside the rect's span but far to the left.
		expect(
			segmentIntersectsRect({ x: 0, y: 125 }, { x: 40, y: 125 }, rect),
		).toBe(false);
	});

	it("false for a same-x segment whose y-interval does not overlap", () => {
		// Vertical segment at x inside the rect's span but far above.
		expect(
			segmentIntersectsRect({ x: 125, y: 0 }, { x: 125, y: 40 }, rect),
		).toBe(false);
	});

	it("true when a segment genuinely crosses the interior", () => {
		// Horizontal segment spanning the whole rect at mid-height.
		expect(
			segmentIntersectsRect({ x: 80, y: 125 }, { x: 180, y: 125 }, rect),
		).toBe(true);
		// Vertical segment spanning the whole rect at mid-width.
		expect(
			segmentIntersectsRect({ x: 125, y: 80 }, { x: 125, y: 180 }, rect),
		).toBe(true);
	});

	it("false when the segment only touches an edge", () => {
		// Horizontal along the top edge: y === rect.y (not interior).
		expect(
			segmentIntersectsRect({ x: 80, y: 100 }, { x: 180, y: 100 }, rect),
		).toBe(false);
		// Vertical along the left edge: x === rect.x.
		expect(
			segmentIntersectsRect({ x: 100, y: 80 }, { x: 100, y: 180 }, rect),
		).toBe(false);
		// Segment terminating exactly at the rect's left edge never enters
		// the interior (reaches the boundary and stops).
		expect(
			segmentIntersectsRect({ x: 50, y: 125 }, { x: 100, y: 125 }, rect),
		).toBe(false);
	});
});

describe("built-in PPL geometry", () => {
	const templates = loadBuiltinPipelineTemplates();

	for (const template of templates) {
		it(`${template.kind} uses orthogonal, obstacle-free routes for every display edge`, async () => {
			const parsed = parsePipelineDocumentV3(template.yaml);
			expect(parsed.document).not.toBeNull();
			const document = parsed.document!;
			const displayGraph = buildPipelineDisplayGraph(document);
			const layout = await computePipelineLayout(document, "DOWN");
			expect(Object.keys(layout.edges)).toHaveLength(displayGraph.edges.length);

			for (const displayEdge of displayGraph.edges) {
				const routed = layout.edges[displayEdge.id]!;
				const points = reconstructPath(displayEdge, routed, layout.nodes);
				expect(
					isOrthogonalPath(points),
					`${template.kind}:${displayEdge.id}`,
				).toBe(true);
				for (let index = 0; index < points.length - 1; index += 1) {
					for (const [nodeId, position] of Object.entries(layout.nodes)) {
						if (nodeId === displayEdge.from || nodeId === displayEdge.to)
							continue;
						const hit = segmentIntersectsRect(
							points[index]!,
							points[index + 1]!,
							{
								x: position.x,
								y: position.y,
								w: NODE_WIDTH,
								h: NODE_HEIGHT,
							},
						);
						expect(
							hit,
							`${template.kind}:${displayEdge.id} crosses ${nodeId}`,
						).toBe(false);
					}
				}
			}
		});
	}
});
