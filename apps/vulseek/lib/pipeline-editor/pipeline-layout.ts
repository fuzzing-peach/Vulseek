import ELK from "elkjs/lib/elk.bundled.js";
import type {
	PipelineDocumentV3,
	PipelineEdgeV3,
} from "@vulseek/server/services/scan/pipeline/document-v3";

/**
 * ELK Layered layout for the pipeline canvas.
 *
 * - Default direction is top-to-bottom (`DOWN`); the V3 `ui.direction` can
 *   persist `RIGHT`.
 * - Orthogonal edge routing with bend points; cycles are broken by ELK's
 *   cycle-breaking; self-loops and multiple same-source/same-target edges
 *   are supported (distinct edge ids).
 * - Groups are laid out as plain nodes; the canvas renders swimlane frames
 *   over their members' bounding boxes (no compound nesting needed).
 * - Callers own the generation token: stale async results must be dropped.
 *
 * The result is a *transient* layout: callers persist it into `ui` only on
 * Apply Layout or a completed node drag, so previews never dirty the draft.
 */

export const NODE_WIDTH = 240;
export const NODE_HEIGHT = 96;

export type PipelineLayoutDirection = "DOWN" | "RIGHT";

export type PipelineLayoutResult = {
	nodes: Record<string, { x: number; y: number }>;
	edges: Record<string, { bendPoints: Array<{ x: number; y: number }> }>;
};

const elk = new ELK();

const layoutOptionsFor = (direction: PipelineLayoutDirection) => ({
	"elk.algorithm": "layered",
	"elk.direction": direction,
	"elk.edgeRouting": "ORTHOGONAL",
	"elk.spacing.nodeNode": "56",
	"elk.spacing.edgeNode": "28",
	"elk.spacing.edgeEdge": "12",
	"elk.layered.spacing.nodeNodeBetweenLayers": "88",
	"elk.layered.cycleBreaking.strategy": "GREEDY",
	"elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
	"elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
});

/**
 * Compute a full layout for every stage and edge.
 * `extraNodes` lets callers add palette-created stages before persisting.
 */
export const computePipelineLayout = async (
	document: Pick<PipelineDocumentV3, "stages" | "edges" | "groups">,
	direction: PipelineLayoutDirection = "DOWN",
): Promise<PipelineLayoutResult> => {
	const stageIds = Object.keys(document.stages);
	const graph: Parameters<typeof elk.layout>[0] = {
		id: "pipeline-root",
		layoutOptions: layoutOptionsFor(direction),
		children: stageIds.map((id) => ({
			id,
			width: NODE_WIDTH,
			height: NODE_HEIGHT,
		})),
		edges: document.edges.map((edge) => ({
			id: edge.id,
			sources: [edge.from],
			targets: [edge.to],
		})),
	};

	const result = await elk.layout(graph);

	const nodes: PipelineLayoutResult["nodes"] = {};
	for (const child of result.children ?? []) {
		const { id, x, y } = child;
		if (id && typeof x === "number" && typeof y === "number") {
			nodes[id] = { x, y };
		}
	}
	// Stages ELK dropped (e.g. isolated self-loops edge cases) get a
	// deterministic fallback position below the laid-out content.
	const maxY =
		Math.max(0, ...Object.values(nodes).map((position) => position.y)) +
		NODE_HEIGHT +
		88;
	let fallbackIndex = 0;
	for (const id of stageIds) {
		if (!nodes[id]) {
			nodes[id] = { x: 0, y: maxY + fallbackIndex * (NODE_HEIGHT + 56) };
			fallbackIndex += 1;
		}
	}

	const edges: PipelineLayoutResult["edges"] = {};
	for (const edge of result.edges ?? []) {
		const id = edge.id;
		if (!id) continue;
		const bendPoints: Array<{ x: number; y: number }> = [];
		for (const section of edge.sections ?? []) {
			for (const point of section.bendPoints ?? []) {
				bendPoints.push({ x: point.x, y: point.y });
			}
		}
		edges[id] = { bendPoints };
	}
	return { nodes, edges };
};

/**
 * Resolve saved positions for every stage, falling back to a transient ELK
 * layout when `ui.nodes` is missing entries (never mutates the document).
 */
export const resolveStagePositions = (
	document: Pick<PipelineDocumentV3, "stages" | "edges" | "ui">,
	computed: PipelineLayoutResult["nodes"],
): Record<string, { x: number; y: number }> => {
	const saved = document.ui?.nodes ?? {};
	const positions: Record<string, { x: number; y: number }> = {};
	for (const id of Object.keys(document.stages)) {
		positions[id] = saved[id] ?? computed[id] ?? { x: 0, y: 0 };
	}
	return positions;
};

/** Orthogonal path through the saved bend points (fallback: elbow). */
export const buildEdgePath = (
	sourceX: number,
	sourceY: number,
	targetX: number,
	targetY: number,
	bendPoints: Array<{ x: number; y: number }> = [],
): string => {
	if (bendPoints.length === 0) {
		const midY = (sourceY + targetY) / 2;
		return `M ${sourceX} ${sourceY} L ${sourceX} ${midY} L ${targetX} ${midY} L ${targetX} ${targetY}`;
	}
	const segments = [`M ${sourceX} ${sourceY}`];
	for (const point of bendPoints) {
		segments.push(`L ${point.x} ${point.y}`);
	}
	segments.push(`L ${targetX} ${targetY}`);
	return segments.join(" ");
};

/** Sanitize a slug-like id for a newly created stage/edge. */
export const nextUniqueId = (
	base: string,
	existing: ReadonlySet<string>,
): string => {
	let candidate = base;
	let index = 1;
	while (existing.has(candidate)) {
		candidate = `${base}-${index}`;
		index += 1;
	}
	return candidate;
};

export const defaultEdgeFactory = (
	id: string,
	from: string,
	to: string,
): PipelineEdgeV3 => ({
	id,
	name: id,
	from,
	to,
	fork: false,
	mode: "map",
	artifacts: [],
});
