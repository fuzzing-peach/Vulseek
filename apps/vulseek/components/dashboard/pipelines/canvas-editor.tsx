import {
	Background,
	BaseEdge,
	Controls,
	Handle,
	MarkerType,
	Position,
	ReactFlow,
	type Edge as FlowEdge,
	type EdgeProps,
	type Node as FlowNode,
	type NodeProps,
	applyNodeChanges,
} from "@xyflow/react";
import { Plus } from "lucide-react";
import * as React from "react";
import type {
	PipelineDocumentV3,
	PipelineEdgeV3,
	PipelineStageV3,
} from "@vulseek/server/services/scan/pipeline/document-v3";
import { cn } from "@/lib/utils";

/**
 * Canvas editor for a PipelineDocumentV3.
 *
 * Read-only mode renders the graph exactly like the run monitor; editable
 * mode adds connection handles, selection, drag persistence (ui.nodes) and
 * delete. Every mutation funnels through `onChange(document)` so the editor
 * state machine can re-serialize the buffer (stable serialization kicks in
 * on the first canvas edit).
 */

const NODE_WIDTH = 240;
const NODE_HEIGHT = 96;
const COLUMN_GAP = 80;
const ROW_GAP = 56;

const ROLE_COLORS: Record<PipelineStageV3["role"], string> = {
	scan: "border-sky-500/60 bg-sky-500/10",
	analysis: "border-amber-500/60 bg-amber-500/10",
	verification: "border-emerald-500/60 bg-emerald-500/10",
};

const roleLabel: Record<PipelineStageV3["role"], string> = {
	scan: "Scan",
	analysis: "Analysis",
	verification: "Verification",
};

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const resolvePositions = (
	document: PipelineDocumentV3,
): Record<string, { x: number; y: number }> => {
	if (document.ui?.nodes) {
		const positions: Record<string, { x: number; y: number }> = {};
		for (const [id, position] of Object.entries(document.ui.nodes)) {
			if (document.stages[id]) positions[id] = position;
		}
		return positions;
	}
	// Deterministic auto-layout: BFS levels by longest-path depth, columns by
	// in-degree order.
	const stageIds = Object.keys(document.stages);
	const depth = new Map<string, number>();
	for (const id of stageIds) depth.set(id, 0);
	const outgoing = new Map<string, string[]>();
	for (const edge of document.edges) {
		const list = outgoing.get(edge.from) ?? [];
		list.push(edge.to);
		outgoing.set(edge.from, list);
	}
	// Repeated relaxation until stable (handles loops by bounding depth).
	for (let pass = 0; pass < stageIds.length; pass += 1) {
		let changed = false;
		for (const edge of document.edges) {
			const from = depth.get(edge.from) ?? 0;
			const to = depth.get(edge.to) ?? 0;
			if (from + 1 > to) {
				depth.set(edge.to, from + 1);
				changed = true;
			}
		}
		if (!changed) break;
	}
	const byLevel = new Map<number, string[]>();
	for (const id of stageIds) {
		const level = depth.get(id) ?? 0;
		const list = byLevel.get(level) ?? [];
		list.push(id);
		byLevel.set(level, list);
	}
	const positions: Record<string, { x: number; y: number }> = {};
	for (const [level, ids] of byLevel) {
		ids.forEach((id, index) => {
			positions[id] = {
				x: level * (NODE_WIDTH + COLUMN_GAP),
				y: index * (NODE_HEIGHT + ROW_GAP),
			};
		});
	}
	return positions;
};

const toFlowNode = (
	id: string,
	stage: PipelineStageV3,
	position: { x: number; y: number },
	isRoot: boolean,
	readOnly: boolean,
): FlowNode<{ stage: PipelineStageV3; isRoot: boolean; readOnly: boolean }> => ({
	id,
	type: "pipelineStage",
	position,
	data: { stage, isRoot, readOnly },
});

const toFlowEdge = (edge: PipelineEdgeV3): FlowEdge => ({
	id: edge.id,
	source: edge.from,
	target: edge.to,
	type: "pipelineEdge",
	...(edge.route ? { label: edge.route.key } : {}),
	...(edge.mode === "fanOut"
		? { markerEnd: { type: MarkerType.ArrowClosed } }
		: {}),
});

// ---------------------------------------------------------------------------
// Node / edge renderers
// ---------------------------------------------------------------------------

const PipelineStageNode = ({
	data,
	selected,
}: NodeProps<FlowNode<{ stage: PipelineStageV3; isRoot: boolean; readOnly: boolean }>>) => {
	const { stage, isRoot, readOnly } = data;
	const color = ROLE_COLORS[stage.role];
	return (
		<div
			className={cn(
				"w-60 rounded-xl border bg-background p-3 shadow-sm transition-colors",
				color,
				selected && "ring-2 ring-ring",
			)}
		>
			{!readOnly && (
				<>
					<Handle
						type="target"
						position={Position.Left}
						className="!size-2.5 !border !bg-background"
					/>
					<Handle
						type="source"
						position={Position.Right}
						className="!size-2.5 !border !bg-background"
					/>
				</>
			)}
			<div className="flex items-center justify-between gap-2">
				<div className="min-w-0">
					<div className="truncate text-sm font-medium leading-5">
						{stage.name}
					</div>
					<div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
						<span className="truncate">{stage.group}</span>
						{stage.runtime.skills?.length ? (
							<span className="truncate">· {stage.runtime.skills.join(", ")}</span>
						) : null}
					</div>
				</div>
				<div className="flex shrink-0 flex-col items-end gap-1">
					<span className="text-[10px] uppercase tracking-wide text-muted-foreground">
						{roleLabel[stage.role]}
					</span>
					{isRoot ? (
						<span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
							root
						</span>
					) : null}
				</div>
			</div>
		</div>
	);
};

const PipelineEdge = ({ id, sourceX, sourceY, targetX, targetY }: EdgeProps) => {
	const midY = (sourceY + targetY) / 2;
	const path = `M ${sourceX} ${sourceY} L ${sourceX} ${midY} L ${targetX} ${midY} L ${targetX} ${targetY}`;
	return <BaseEdge id={id} path={path} />;
};

const nodeTypes = { pipelineStage: PipelineStageNode };
const edgeTypes = { pipelineEdge: PipelineEdge };

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export type CanvasEditorProps = {
	document: PipelineDocumentV3;
	readOnly: boolean;
	onChange?: (document: PipelineDocumentV3) => void;
	onSelect?: (entity: { type: "stage" | "edge"; id: string } | null) => void;
	onAddStage?: () => void;
	className?: string;
};

export const CanvasEditor = ({
	document,
	readOnly,
	onChange,
	onSelect,
	onAddStage,
	className,
}: CanvasEditorProps) => {
	const positions = resolvePositions(document);
	const initialNodes = React.useMemo(
		() =>
			Object.entries(document.stages).map(([id, stage]) =>
				toFlowNode(
					id,
					stage,
					positions[id] ?? { x: 0, y: 0 },
					id === document.root,
					readOnly,
				),
			),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[document],
	);
	const edges = React.useMemo(
		() => document.edges.map(toFlowEdge),
		[document.edges],
	);

	const [nodes, setNodes] = React.useState(initialNodes);
	React.useEffect(() => setNodes(initialNodes), [initialNodes]);

	const persistPositions = React.useCallback(
		(next: Array<FlowNode<{ stage: PipelineStageV3; isRoot: boolean; readOnly: boolean }>>) => {
			if (readOnly || !onChange) return;
			const uiNodes: Record<string, { x: number; y: number }> = {};
			for (const node of next) {
				uiNodes[node.id] = { x: node.position.x, y: node.position.y };
			}
			onChange({ ...document, ui: { ...(document.ui ?? {}), nodes: uiNodes } });
		},
		[document, readOnly, onChange],
	);

	const onNodesChange = React.useCallback(
		(changes: Parameters<typeof applyNodeChanges>[0]) => {
			const next = applyNodeChanges(changes, nodes) as Array<
				FlowNode<{ stage: PipelineStageV3; isRoot: boolean; readOnly: boolean }>
			>;
			setNodes(next);
			if (changes.some((change) => change.type === "position")) {
				persistPositions(next);
			}
		},
		[nodes, persistPositions],
	);

	const onConnect = React.useCallback(
		(connection: { source: string; target: string }) => {
			if (readOnly || !onChange) return;
			const { source, target } = connection;
			const id = `${source}-to-${target}`;
			if (
				document.edges.some(
					(edge) =>
						edge.from === source && edge.to === target,
				)
			) {
				return;
			}
			onChange({
				...document,
				edges: [
					...document.edges,
					{
						id,
						name: id,
						from: source,
						to: target,
						fork: false,
						mode: "map",
						artifacts: [],
					},
				],
			});
		},
		[document, readOnly, onChange],
	);

	const onNodesDelete = React.useCallback(
		(deleted: Array<{ id: string }>) => {
			if (readOnly || !onChange) return;
			const deletedIds = new Set(deleted.map((node) => node.id));
			const nextStages: PipelineDocumentV3["stages"] = {};
			for (const [id, stage] of Object.entries(document.stages)) {
				if (!deletedIds.has(id)) nextStages[id] = stage;
			}
			const nextRoot =
				document.root in nextStages
					? document.root
					: (Object.keys(nextStages)[0] ?? document.root);
			const nextUiNodes: Record<string, { x: number; y: number }> = {};
			for (const [id, position] of Object.entries(document.ui?.nodes ?? {})) {
				if (!deletedIds.has(id)) nextUiNodes[id] = position;
			}
			onChange({
				...document,
				root: nextRoot,
				stages: nextStages,
				edges: document.edges.filter(
					(edge) => !deletedIds.has(edge.from) && !deletedIds.has(edge.to),
				),
				ui: { nodes: nextUiNodes },
			});
		},
		[document, readOnly, onChange],
	);

	const onEdgesDelete = React.useCallback(
		(deleted: Array<{ id: string }>) => {
			if (readOnly || !onChange) return;
			const deletedIds = new Set(deleted.map((edge) => edge.id));
			onChange({
				...document,
				edges: document.edges.filter((edge) => !deletedIds.has(edge.id)),
			});
		},
		[document, readOnly, onChange],
	);

	return (
		<div className={cn("relative h-full w-full", className)}>
			{!readOnly && onAddStage ? (
				<button
					type="button"
					onClick={onAddStage}
					className="absolute right-3 top-3 z-10 inline-flex items-center gap-1.5 rounded-md border bg-background px-2.5 py-1.5 text-xs font-medium shadow-sm hover:bg-muted"
				>
					<Plus className="size-3.5" />
					Add stage
				</button>
			) : null}
			<ReactFlow
				nodes={nodes}
				edges={edges}
				nodeTypes={nodeTypes}
				edgeTypes={edgeTypes}
				onNodesChange={onNodesChange}
				onNodesDelete={onNodesDelete}
				onEdgesDelete={onEdgesDelete}
				onConnect={onConnect}
				onSelectionChange={({ nodes: selectedNodes, edges: selectedEdges }) => {
					const stageNode = selectedNodes[0];
					const edge = selectedEdges[0];
					onSelect?.(
						stageNode
							? { type: "stage", id: stageNode.id }
							: edge
								? { type: "edge", id: edge.id }
								: null,
					);
				}}
				fitView
				minZoom={0.2}
				proOptions={{ hideAttribution: true }}
			>
				<Background gap={24} />
				{!readOnly && <Controls />}
			</ReactFlow>
		</div>
	);
};
