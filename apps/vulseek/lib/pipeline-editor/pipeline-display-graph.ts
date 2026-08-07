import type {
	PipelineDocumentV3,
	PipelineEdgeV3,
} from "@vulseek/server/services/scan/pipeline/document-v3";

/**
 * Display graph for the PPL Visual canvas.
 *
 * The persisted V3 document keeps its original stages and edges for runtime
 * compilation, editing, YAML serialization, and publishing. This module
 * derives a *separate* display graph that React Flow renders:
 *
 * - one display node per V3 stage, with a deterministic stage rank
 *   (configured root → declaration order → forward reachability → stable id);
 * - edges classified as forward (target rank > source rank) or feedback
 *   (same or earlier rank), so local loops are explicit without reordering
 *   the main progression;
 * - parallel edges grouped by `(from, to)` into one display edge with
 *   member ids and derived labels — presentation only;
 * - selection mapping so clicking a grouped path or a route label selects
 *   the original V3 edge.
 *
 * Nothing in this module writes to `ui`; layout/persistence live in
 * `pipeline-layout.ts`.
 */

export type PipelineDisplayNode = {
	stageId: string;
	rank: number;
	isRoot: boolean;
	reachableFromRoot: boolean;
};

export type PipelineDisplayEdgeLabel = {
	edgeId: string;
	label: string;
	isDefault: boolean;
};

export type PipelineDisplayEdge = {
	id: string;
	from: string;
	to: string;
	memberEdgeIds: string[];
	labels: PipelineDisplayEdgeLabel[];
	kind: "forward" | "feedback";
	bendPoints: Array<{ x: number; y: number }>;
	/**
	 * Route-assigned handle ids matching the geometry chosen by the layout
	 * stage. The node renders only these; default forward = bottom→top
	 * (DOWN) / right→left (RIGHT), feedback = side pair, self-loop = a
	 * dedicated deterministic side pair.
	 */
	sourceHandle: string;
	targetHandle: string;
};

export type PipelineDisplayEdgeHandle = "top" | "bottom" | "left" | "right";

export type PipelineDisplayGraph = {
	nodes: Map<string, PipelineDisplayNode>;
	/** Ranked stage ids in deterministic layout order. */
	stageOrder: string[];
	edges: PipelineDisplayEdge[];
	/** Original edge id → display edge id. */
	edgeToDisplay: Map<string, string>;
};

const DEFAULT_LABEL = "default";

/** Prefer `edge.route.key`, then the edge name, then `default`. */
export const displayLabelForEdge = (edge: PipelineEdgeV3): string => {
	if (edge.route?.key) return edge.route.key;
	if (edge.name) return edge.name;
	return DEFAULT_LABEL;
};

export const isDefaultLabel = (edge: PipelineEdgeV3): boolean =>
	!edge.route?.key || Boolean(edge.route.default);

/**
 * Deterministic stage rank:
 * 1. the configured root gets rank 0;
 * 2. remaining stages are ordered by declaration order in the YAML document;
 * 3. forward reachability from the root re-ranks reachable stages before
 *    unreachable ones, preserving declaration order inside each class;
 * 4. the stable stage id is the final tie-breaker.
 */
export const computeStageRanks = (
	document: Pick<PipelineDocumentV3, "stages" | "edges" | "root">,
): Map<string, number> => {
	const stageIds = Object.keys(document.stages);
	const ranks = new Map<string, number>();

	// 1. Root is first.
	ranks.set(document.root, 0);

	// 3. Forward reachability from the root (BFS over persisted edges).
	const adjacency = new Map<string, string[]>();
	for (const id of stageIds) adjacency.set(id, []);
	for (const edge of document.edges ?? []) {
		adjacency.get(edge.from)?.push(edge.to);
	}
	const reachable = new Set<string>([document.root]);
	const queue = [document.root];
	while (queue.length > 0) {
		const current = queue.shift()!;
		for (const next of adjacency.get(current) ?? []) {
			if (!reachable.has(next)) {
				reachable.add(next);
				queue.push(next);
			}
		}
	}

	// 2. Declaration order defines the base sequence; reachable stages are
	//    hoisted above unreachable ones (declaration order preserved inside
	//    each class; the stage id is already unique so no further tie-break
	//    is needed).
	const declarationOrder = stageIds.filter((id) => id !== document.root);
	const ordered = [
		document.root,
		...declarationOrder.filter((id) => reachable.has(id)),
		...declarationOrder.filter((id) => !reachable.has(id)),
	];

	ordered.forEach((id, index) => ranks.set(id, index));
	return ranks;
};

/** Classify an edge as forward or feedback from the display ranks. */
export const classifyEdge = (
	edge: PipelineEdgeV3,
	ranks: Map<string, number>,
): "forward" | "feedback" => {
	const fromRank = ranks.get(edge.from);
	const toRank = ranks.get(edge.to);
	if (fromRank === undefined || toRank === undefined) return "forward";
	return toRank > fromRank ? "forward" : "feedback";
};

/**
 * Build the display graph for a V3 document. Grouped edges preserve member
 * ids and labels; `kind` is forward/feedback; bendPoints start empty and are
 * filled by layout.
 */
export const buildPipelineDisplayGraph = (
	document: Pick<PipelineDocumentV3, "stages" | "edges" | "root">,
): PipelineDisplayGraph => {
	const ranks = computeStageRanks(document);
	const stageIds = Object.keys(document.stages);

	const nodes = new Map<string, PipelineDisplayNode>();
	for (const id of stageIds) {
		nodes.set(id, {
			stageId: id,
			rank: ranks.get(id) ?? stageIds.length,
			isRoot: id === document.root,
			reachableFromRoot:
				id === document.root || isReachableFromRoot(document, id),
		});
	}

	const grouped = new Map<string, PipelineDisplayEdge>();
	for (const edge of document.edges ?? []) {
		const key = `${edge.from}\u0000${edge.to}`;
		const existing = grouped.get(key);
		if (existing) {
			existing.memberEdgeIds.push(edge.id);
			existing.labels.push({
				edgeId: edge.id,
				label: displayLabelForEdge(edge),
				isDefault: isDefaultLabel(edge),
			});
			continue;
		}
		const kind = classifyEdge(edge, ranks);
		// Display id is stable: primary member id for grouped edges.
		grouped.set(key, {
			id: edge.id,
			from: edge.from,
			to: edge.to,
			memberEdgeIds: [edge.id],
			labels: [
				{
					edgeId: edge.id,
					label: displayLabelForEdge(edge),
					isDefault: isDefaultLabel(edge),
				},
			],
			kind,
			bendPoints: [],
			// Defaults: forward bottom→top, feedback/self-loop left pair. The
			// layout stage re-assigns these from actual route geometry.
			sourceHandle: kind === "forward" ? "bottom-source" : "left-source",
			targetHandle: kind === "forward" ? "top-target" : "left-target",
		});
	}

	const edges = [...grouped.values()];
	const edgeToDisplay = new Map<string, string>();
	for (const displayEdge of edges) {
		for (const memberId of displayEdge.memberEdgeIds) {
			edgeToDisplay.set(memberId, displayEdge.id);
		}
	}

	return { nodes, stageOrder: [...ranks.keys()], edges, edgeToDisplay };
};

const isReachableFromRoot = (
	document: Pick<PipelineDocumentV3, "edges" | "root">,
	stageId: string,
): boolean => {
	if (stageId === document.root) return true;
	const adjacency = new Map<string, string[]>();
	for (const edge of document.edges ?? []) {
		const list = adjacency.get(edge.from) ?? [];
		list.push(edge.to);
		adjacency.set(edge.from, list);
	}
	const visited = new Set<string>([document.root]);
	const queue = [document.root];
	while (queue.length > 0) {
		const current = queue.shift()!;
		for (const next of adjacency.get(current) ?? []) {
			if (next === stageId) return true;
			if (!visited.has(next)) {
				visited.add(next);
				queue.push(next);
			}
		}
	}
	return false;
};
