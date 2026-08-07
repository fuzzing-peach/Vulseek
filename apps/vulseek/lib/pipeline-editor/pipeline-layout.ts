import type {
	PipelineDocumentV3,
	PipelineEdgeV3,
} from "@vulseek/server/services/scan/pipeline/document-v3";
import ELK from "elkjs/lib/elk.bundled.js";
import {
	buildPipelineDisplayGraph,
	type PipelineDisplayEdge,
} from "./pipeline-display-graph";

/**
 * The canvas uses one geometry pipeline:
 *
 * 1. Build the complete display graph, including feedback and self-loop edges.
 * 2. Assign semantic ports to every display edge.
 * 3. Send all nodes, ports, and edges through one ELK Layered invocation.
 * 4. Render and persist ELK's node positions and orthogonal edge sections.
 *
 * React Flow is only the renderer/editor. It never repairs stable routes or
 * independently decides where an edge should run.
 */

export const NODE_WIDTH = 240;
export const NODE_HEIGHT = 64;

export type PipelineLayoutDirection = "DOWN" | "RIGHT";
export type PipelinePortSide = "top" | "bottom" | "left" | "right";
export type PipelineSourceHandleId = `${PipelinePortSide}-source`;
export type PipelineTargetHandleId = `${PipelinePortSide}-target`;
export type PipelineHandleId = PipelineSourceHandleId | PipelineTargetHandleId;

export type PipelineLayoutEdge = {
	bendPoints: Array<{ x: number; y: number }>;
	sourceHandle: PipelineSourceHandleId;
	targetHandle: PipelineTargetHandleId;
};

export type PipelineLayoutResult = {
	nodes: Record<string, { x: number; y: number }>;
	edges: Record<string, PipelineLayoutEdge>;
};

export type TransientPipelineLayout = PipelineLayoutResult;

type RoutePoint = { x: number; y: number };
type EdgeHandles = Pick<PipelineLayoutEdge, "sourceHandle" | "targetHandle">;

const elk = new ELK();
const PORT_SIDES: PipelinePortSide[] = ["top", "bottom", "left", "right"];
const ELK_PORT_SIDE: Record<PipelinePortSide, string> = {
	top: "NORTH",
	bottom: "SOUTH",
	left: "WEST",
	right: "EAST",
};

const roundCoordinate = (value: number): number =>
	Math.round(value * 1000) / 1000;

const normalizePoint = (point: RoutePoint): RoutePoint => ({
	x: roundCoordinate(point.x),
	y: roundCoordinate(point.y),
});

const portId = (stageId: string, side: PipelinePortSide): string =>
	`${stageId}::${side}`;

const handleId = <T extends "source" | "target">(
	side: PipelinePortSide,
	type: T,
): `${PipelinePortSide}-${T}` => `${side}-${type}`;

const forwardHandles = (direction: PipelineLayoutDirection): EdgeHandles =>
	direction === "DOWN"
		? { sourceHandle: "bottom-source", targetHandle: "top-target" }
		: { sourceHandle: "right-source", targetHandle: "left-target" };

const spansOverlap = (
	a: { start: number; end: number },
	b: { start: number; end: number },
): boolean => a.start <= b.end && b.start <= a.end;

/**
 * Select which side ELK should use for feedback routes. This only assigns
 * ports; ELK remains responsible for every segment and obstacle decision.
 * Overlapping feedback spans are balanced across the two available sides so
 * one side of a large pipeline does not become a single unreadable bus.
 */
export const assignDisplayEdgeHandles = (
	displayGraph: ReturnType<typeof buildPipelineDisplayGraph>,
	direction: PipelineLayoutDirection,
): Record<string, EdgeHandles> => {
	const handles: Record<string, EdgeHandles> = {};
	const firstSide: PipelinePortSide = direction === "DOWN" ? "left" : "top";
	const secondSide: PipelinePortSide =
		direction === "DOWN" ? "right" : "bottom";
	const occupied: Record<
		"first" | "second",
		Array<{ start: number; end: number }>
	> = {
		first: [],
		second: [],
	};

	for (const edge of displayGraph.edges) {
		if (edge.kind === "forward") {
			handles[edge.id] = forwardHandles(direction);
			continue;
		}

		const fromRank = displayGraph.nodes.get(edge.from)?.rank ?? 0;
		const toRank = displayGraph.nodes.get(edge.to)?.rank ?? fromRank;
		const span = {
			start: Math.min(fromRank, toRank),
			end: Math.max(fromRank, toRank),
		};
		const firstConflicts = occupied.first.filter((item) =>
			spansOverlap(item, span),
		).length;
		const secondConflicts = occupied.second.filter((item) =>
			spansOverlap(item, span),
		).length;
		const useFirst = firstConflicts <= secondConflicts;
		const side = useFirst ? firstSide : secondSide;
		occupied[useFirst ? "first" : "second"].push(span);
		handles[edge.id] = {
			sourceHandle: handleId(side, "source"),
			targetHandle: handleId(side, "target"),
		};
	}

	return handles;
};

export const defaultHandlesForDisplayEdge = (
	edge: PipelineDisplayEdge,
	direction: PipelineLayoutDirection,
): EdgeHandles =>
	edge.kind === "forward"
		? forwardHandles(direction)
		: direction === "DOWN"
			? { sourceHandle: "left-source", targetHandle: "left-target" }
			: { sourceHandle: "top-source", targetHandle: "top-target" };

const layoutOptionsFor = (
	direction: PipelineLayoutDirection,
	interactive: boolean,
): Record<string, string> => ({
	"elk.algorithm": "layered",
	"elk.direction": direction,
	"elk.edgeRouting": "ORTHOGONAL",
	"elk.layered.feedbackEdges": "true",
	"elk.layered.cycleBreaking.strategy": "GREEDY",
	"elk.layered.nodePlacement.strategy": interactive
		? "INTERACTIVE"
		: "NETWORK_SIMPLEX",
	"elk.layered.layering.strategy": interactive
		? "INTERACTIVE"
		: "NETWORK_SIMPLEX",
	"elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
	"elk.layered.crossingMinimization.semiInteractive": interactive
		? "true"
		: "false",
	"elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
	"elk.layered.considerModelOrder.portModelOrder": "true",
	"elk.layered.allowNonFlowPortsToSwitchSides": "false",
	"elk.layered.unnecessaryBendpoints": "true",
	"elk.separateConnectedComponents": "true",
	"elk.randomSeed": "1",
	"elk.padding": "[top=32,left=32,bottom=32,right=32]",
	"elk.spacing.componentComponent": "96",
	"elk.spacing.nodeNode": "72",
	"elk.spacing.edgeNode": "32",
	"elk.spacing.edgeEdge": "16",
	"elk.spacing.nodeSelfLoop": "48",
	"elk.layered.spacing.nodeNodeBetweenLayers": "104",
	"elk.layered.spacing.edgeNodeBetweenLayers": "32",
	"elk.layered.spacing.edgeEdgeBetweenLayers": "16",
});

export type ElkPipelineLayoutInput = {
	graph: Parameters<typeof elk.layout>[0];
	edgeHandles: Record<string, EdgeHandles>;
};

/** Build one ELK graph containing every visible node and edge. */
export const buildElkPipelineLayoutInput = (
	displayGraph: ReturnType<typeof buildPipelineDisplayGraph>,
	direction: PipelineLayoutDirection,
	preferredPositions?: Record<string, { x: number; y: number }>,
): ElkPipelineLayoutInput => {
	const edgeHandles = assignDisplayEdgeHandles(displayGraph, direction);
	const graph: Parameters<typeof elk.layout>[0] = {
		id: "pipeline-root",
		layoutOptions: layoutOptionsFor(direction, Boolean(preferredPositions)),
		children: displayGraph.stageOrder.map((id) => ({
			id,
			width: NODE_WIDTH,
			height: NODE_HEIGHT,
			...(preferredPositions?.[id]
				? {
						x: preferredPositions[id]!.x,
						y: preferredPositions[id]!.y,
					}
				: {}),
			layoutOptions: {
				"elk.portConstraints": "FIXED_SIDE",
			},
			ports: PORT_SIDES.map((side) => ({
				id: portId(id, side),
				width: 0,
				height: 0,
				layoutOptions: {
					"elk.port.side": ELK_PORT_SIDE[side],
				},
			})),
		})),
		edges: displayGraph.edges.map((edge) => {
			const handles =
				edgeHandles[edge.id] ?? defaultHandlesForDisplayEdge(edge, direction);
			const sourceSide = handles.sourceHandle.split("-")[0] as PipelinePortSide;
			const targetSide = handles.targetHandle.split("-")[0] as PipelinePortSide;
			return {
				id: edge.id,
				sources: [portId(edge.from, sourceSide)],
				targets: [portId(edge.to, targetSide)],
				layoutOptions: {
					// Cycle breaking should preserve the semantic forward progression
					// and choose display-classified feedback edges for reversal.
					"elk.layered.priority.direction":
						edge.kind === "forward" ? "100" : "0",
				},
			};
		}),
	};

	return { graph, edgeHandles };
};

const collapseCollinearPoints = (points: RoutePoint[]): RoutePoint[] => {
	const result: RoutePoint[] = [];
	for (const rawPoint of points) {
		const point = normalizePoint(rawPoint);
		const previous = result[result.length - 1];
		if (previous && previous.x === point.x && previous.y === point.y) continue;
		const beforePrevious = result[result.length - 2];
		if (
			beforePrevious &&
			previous &&
			((beforePrevious.x === previous.x && previous.x === point.x) ||
				(beforePrevious.y === previous.y && previous.y === point.y))
		) {
			result[result.length - 1] = point;
			continue;
		}
		result.push(point);
	}
	return result;
};

export const isOrthogonalPath = (points: RoutePoint[]): boolean =>
	points.every((point, index) => {
		if (index === 0) return true;
		const previous = points[index - 1]!;
		return previous.x === point.x || previous.y === point.y;
	});

const edgeSectionPoints = (
	edge: NonNullable<Parameters<typeof elk.layout>[0]["edges"]>[number],
): RoutePoint[] => {
	const sections = edge.sections ?? [];
	if (sections.length === 0) return [];
	const points: RoutePoint[] = [];
	for (const section of sections) {
		points.push(section.startPoint);
		points.push(...(section.bendPoints ?? []));
		points.push(section.endPoint);
	}
	return collapseCollinearPoints(points);
};

const endpointForHandle = (
	node: { x: number; y: number },
	handle: PipelineHandleId,
): RoutePoint => {
	const side = handle.split("-")[0] as PipelinePortSide;
	if (side === "top") return { x: node.x + NODE_WIDTH / 2, y: node.y };
	if (side === "bottom") {
		return { x: node.x + NODE_WIDTH / 2, y: node.y + NODE_HEIGHT };
	}
	if (side === "right") {
		return { x: node.x + NODE_WIDTH, y: node.y + NODE_HEIGHT / 2 };
	}
	return { x: node.x, y: node.y + NODE_HEIGHT / 2 };
};

/**
 * Run ELK once and extract its complete geometry. Missing/non-orthogonal edge
 * sections are treated as layout failures instead of being silently repaired
 * by the renderer.
 */
export const computePipelineLayout = async (
	document: Pick<PipelineDocumentV3, "stages" | "edges" | "groups" | "root">,
	direction: PipelineLayoutDirection = "DOWN",
	preferredPositions?: Record<string, { x: number; y: number }>,
): Promise<PipelineLayoutResult> => {
	const displayGraph = buildPipelineDisplayGraph(document);
	const input = buildElkPipelineLayoutInput(
		displayGraph,
		direction,
		preferredPositions,
	);
	const elkResult = await elk.layout(input.graph);

	const nodes: PipelineLayoutResult["nodes"] = {};
	for (const child of elkResult.children ?? []) {
		if (typeof child.x !== "number" || typeof child.y !== "number") continue;
		nodes[child.id] = normalizePoint({ x: child.x, y: child.y });
	}

	const missingNodes = displayGraph.stageOrder.filter((id) => !nodes[id]);
	if (missingNodes.length > 0) {
		throw new Error(`ELK omitted pipeline stages: ${missingNodes.join(", ")}`);
	}

	const elkEdges = new Map(
		(elkResult.edges ?? []).map((edge) => [edge.id, edge]),
	);
	const edges: PipelineLayoutResult["edges"] = {};
	for (const displayEdge of displayGraph.edges) {
		const handles =
			input.edgeHandles[displayEdge.id] ??
			defaultHandlesForDisplayEdge(displayEdge, direction);
		const elkEdge = elkEdges.get(displayEdge.id);
		const points = elkEdge ? edgeSectionPoints(elkEdge) : [];
		if (points.length < 2) {
			throw new Error(`ELK omitted route for pipeline edge ${displayEdge.id}`);
		}
		if (!isOrthogonalPath(points)) {
			throw new Error(
				`ELK returned a non-orthogonal route for pipeline edge ${displayEdge.id}`,
			);
		}

		const source = nodes[displayEdge.from]!;
		const target = nodes[displayEdge.to]!;
		const expectedStart = normalizePoint(
			endpointForHandle(source, handles.sourceHandle),
		);
		const expectedEnd = normalizePoint(
			endpointForHandle(target, handles.targetHandle),
		);
		const actualStart = points[0]!;
		const actualEnd = points[points.length - 1]!;
		if (
			actualStart.x !== expectedStart.x ||
			actualStart.y !== expectedStart.y ||
			actualEnd.x !== expectedEnd.x ||
			actualEnd.y !== expectedEnd.y
		) {
			throw new Error(
				`ELK route ports do not match pipeline edge ${displayEdge.id}`,
			);
		}

		edges[displayEdge.id] = {
			bendPoints: points.slice(1, -1),
			...handles,
		};
	}

	return { nodes, edges };
};

/** Resolve stable saved positions, falling back per-stage to transient ELK. */
export const resolveStagePositions = (
	document: Pick<PipelineDocumentV3, "stages" | "edges" | "ui">,
	computed: PipelineLayoutResult["nodes"],
): Record<string, { x: number; y: number }> => {
	const saved = isLegacyLayout(document) ? {} : (document.ui?.nodes ?? {});
	const positions: Record<string, { x: number; y: number }> = {};
	for (const id of Object.keys(document.stages)) {
		positions[id] = saved[id] ?? computed[id] ?? { x: 0, y: 0 };
	}
	return positions;
};

/**
 * During an active drag React Flow moves an endpoint before ELK recomputes
 * the stable route. Add one temporary elbow only for that frame so the edge
 * never flashes diagonally. Stable persisted/transient routes are unchanged.
 */
export const orthogonalizeRenderPath = (points: RoutePoint[]): RoutePoint[] => {
	if (points.length < 2) return points;
	const result: RoutePoint[] = [normalizePoint(points[0]!)];
	for (const rawPoint of points.slice(1)) {
		const point = normalizePoint(rawPoint);
		const previous = result[result.length - 1]!;
		if (previous.x !== point.x && previous.y !== point.y) {
			result.push({ x: previous.x, y: point.y });
		}
		result.push(point);
	}
	return collapseCollinearPoints(result);
};

/** Orthogonal SVG path through ELK's saved bend points. */
export const buildEdgePath = (
	sourceX: number,
	sourceY: number,
	targetX: number,
	targetY: number,
	bendPoints: RoutePoint[] = [],
): string => {
	let points: RoutePoint[];
	if (bendPoints.length === 0) {
		if (Math.abs(targetY - sourceY) >= Math.abs(targetX - sourceX)) {
			const midY = (sourceY + targetY) / 2;
			points = [
				{ x: sourceX, y: sourceY },
				{ x: sourceX, y: midY },
				{ x: targetX, y: midY },
				{ x: targetX, y: targetY },
			];
		} else {
			const midX = (sourceX + targetX) / 2;
			points = [
				{ x: sourceX, y: sourceY },
				{ x: midX, y: sourceY },
				{ x: midX, y: targetY },
				{ x: targetX, y: targetY },
			];
		}
	} else {
		points = orthogonalizeRenderPath([
			{ x: sourceX, y: sourceY },
			...bendPoints,
			{ x: targetX, y: targetY },
		]);
	}

	const segments = [`M ${points[0]!.x} ${points[0]!.y}`];
	for (const point of points.slice(1)) segments.push(`L ${point.x} ${point.y}`);
	return segments.join(" ");
};

/** True when an axis-aligned segment intersects the strict rect interior. */
export const segmentIntersectsRect = (
	a: RoutePoint,
	b: RoutePoint,
	rect: { x: number; y: number; w: number; h: number },
): boolean => {
	const left = Math.min(a.x, b.x);
	const right = Math.max(a.x, b.x);
	const top = Math.min(a.y, b.y);
	const bottom = Math.max(a.y, b.y);
	if (a.y === b.y) {
		return (
			right > rect.x &&
			left < rect.x + rect.w &&
			a.y > rect.y &&
			a.y < rect.y + rect.h
		);
	}
	if (a.x === b.x) {
		return (
			bottom > rect.y &&
			top < rect.y + rect.h &&
			a.x > rect.x &&
			a.x < rect.x + rect.w
		);
	}
	return false;
};

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

export const expandPersistedEdgeLayout = (
	displayEdges: Array<
		PipelineDisplayEdge & {
			sourceHandle: PipelineSourceHandleId;
			targetHandle: PipelineTargetHandleId;
		}
	>,
): Record<string, PipelineLayoutEdge> => {
	const expanded: Record<string, PipelineLayoutEdge> = {};
	for (const edge of displayEdges) {
		for (const memberId of edge.memberEdgeIds) {
			expanded[memberId] = {
				bendPoints: edge.bendPoints,
				sourceHandle: edge.sourceHandle,
				targetHandle: edge.targetHandle,
			};
		}
	}
	return expanded;
};

export const CURRENT_PIPELINE_LAYOUT_VERSION = 3;

export const isLegacyLayout = (
	document: Pick<PipelineDocumentV3, "ui">,
): boolean => {
	const version = document.ui?.layoutVersion;
	return (
		typeof version !== "number" || version < CURRENT_PIPELINE_LAYOUT_VERSION
	);
};

export type { PipelineDisplayEdge };
export { buildPipelineDisplayGraph } from "./pipeline-display-graph";
