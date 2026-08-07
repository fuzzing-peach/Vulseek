import {
	Background,
	BaseEdge,
	Controls,
	Handle,
	MarkerType,
	MiniMap,
	Position,
	ReactFlow,
	type Connection,
	type Edge as FlowEdge,
	type EdgeProps,
	type Node as FlowNode,
	type NodeProps,
	useReactFlow,
	ReactFlowProvider,
	applyNodeChanges,
	type NodeChange,
} from "@xyflow/react";
import type { OnNodeDrag } from "@xyflow/react";
import {
	AlignStartHorizontal,
	AlignStartVertical,
	Focus,
	LayoutGrid,
	Lock,
	MousePointer2,
	Plus,
	Unlock,
} from "lucide-react";
import * as React from "react";
import type {
	PipelineDocumentV3,
	PipelineEdgeV3,
	PipelineStageV3,
} from "@vulseek/server/services/scan/pipeline/document-v3";
import {
	NODE_HEIGHT,
	NODE_WIDTH,
	buildEdgePath,
	computePipelineLayout,
	defaultEdgeFactory,
	nextUniqueId,
	resolveStagePositions,
	type PipelineLayoutDirection,
} from "@/lib/pipeline-editor/pipeline-layout";
import { cn } from "@/lib/utils";

/**
 * ELK-driven pipeline canvas.
 *
 * - Layout: ELK Layered, direction from `ui.direction` (default DOWN),
 *   orthogonal routing with bend points. Saved `ui.nodes` win; missing
 *   positions get a *transient* ELK layout that never dirties the draft.
 * - Persistence: node positions are written to `ui` only on drag stop or
 *   Apply Layout; edge bend points on Apply Layout.
 * - Stale async layouts are dropped via a generation token; fitView re-runs
 *   after layout, measurement and Inspector toggles.
 * - Cycles, self-loops, multiple same-source/same-target edges and
 *   disconnected stages are all supported.
 */

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
// Node / edge renderers
// ---------------------------------------------------------------------------

type StageNodeData = {
	stage: PipelineStageV3;
	isRoot: boolean;
	readOnly: boolean;
};

const PipelineStageNode = ({
	data,
	selected,
}: NodeProps<FlowNode<StageNodeData>>) => {
	const { stage, isRoot, readOnly } = data;
	return (
		<div
			className={cn(
				"w-60 rounded-xl border bg-background p-3 shadow-sm transition-colors",
				ROLE_COLORS[stage.role],
				selected && "ring-2 ring-ring",
			)}
		>
			{!readOnly && (
				<>
					<Handle
						id="target"
						type="target"
						position={Position.Top}
						className="!size-2.5 !border !bg-background"
					/>
					<Handle
						id="source"
						type="source"
						position={Position.Bottom}
						className="!size-2.5 !border !bg-background"
					/>
					{/* Extra handles let self-loops and multi-edges pick distinct
					    anchor points. */}
					<Handle
						id="target-left"
						type="target"
						position={Position.Left}
						className="!size-2 !border !bg-background"
					/>
					<Handle
						id="source-right"
						type="source"
						position={Position.Right}
						className="!size-2 !border !bg-background"
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

const PipelineEdge = ({ id, sourceX, sourceY, targetX, targetY, data, markerEnd }: EdgeProps) => {
	const bendPoints = (data as { bendPoints?: Array<{ x: number; y: number }> } | undefined)
		?.bendPoints;
	const path = buildEdgePath(sourceX, sourceY, targetX, targetY, bendPoints);
	return <BaseEdge id={id} path={path} markerEnd={markerEnd} />;
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

type EditorFlowNode = FlowNode<StageNodeData>;
type EditorFlowEdge = FlowEdge & { data?: { bendPoints?: Array<{ x: number; y: number }> } };

const CanvasEditorInner = ({
	document,
	readOnly,
	onChange,
	onSelect,
	onAddStage,
	className,
}: CanvasEditorProps) => {
	const { fitView } = useReactFlow();
	const [interactionLock, setInteractionLock] = React.useState(false);

	const direction: PipelineLayoutDirection = document.ui?.direction ?? "DOWN";
	// Stable references: document.ui?.nodes is a fresh object identity per
	// render when undefined, which would re-trigger the transient layout
	// effect on every render and drop every async result.
	const savedPositions = React.useMemo(
		() => document.ui?.nodes ?? {},
		[document.ui?.nodes],
	);

	// Transient layout: computed when positions are missing; never persisted
	// unless Apply Layout or a drag stop writes it.
	const [transientLayout, setTransientLayout] = React.useState<
		Record<string, { x: number; y: number }>
	>({});
	const layoutToken = React.useRef(0);

	// Async ELK layout with a generation token — stale results are dropped.
	React.useEffect(() => {
		const missing = Object.keys(document.stages).some((id) => !savedPositions[id]);
		if (!missing) {
			setTransientLayout({});
			return;
		}
		const token = ++layoutToken.current;
		void computePipelineLayout(document, direction).then((result) => {
			if (token !== layoutToken.current) return; // stale
			setTransientLayout(result.nodes);
			requestAnimationFrame(() => void fitView({ padding: 0.2, duration: 0 }));
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [document, direction, savedPositions]);

	const positions = React.useMemo(
		() => resolveStagePositions(document, transientLayout),
		[document, transientLayout],
	);

	const nodes: EditorFlowNode[] = React.useMemo(
		() =>
			Object.entries(document.stages).map(([id, stage]) => ({
				id,
				type: "pipelineStage",
				position: positions[id] ?? { x: 0, y: 0 },
				data: {
					stage,
					isRoot: id === document.root,
					readOnly,
				},
			})),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[document, readOnly, positions],
	);

	const edges: EditorFlowEdge[] = React.useMemo(
		() =>
			document.edges.map((edge) => ({
				id: edge.id,
				source: edge.from,
				target: edge.to,
				type: "pipelineEdge",
				data: {
					bendPoints: document.ui?.edges?.[edge.id]?.bendPoints ?? [],
				},
				...(edge.mode === "fanOut"
					? { markerEnd: { type: MarkerType.ArrowClosed } }
					: {}),
				label: edge.route?.key,
			})),
		[document.edges, document.ui?.edges],
	);

	const [localNodes, setLocalNodes] = React.useState<EditorFlowNode[]>(nodes);
	React.useEffect(() => setLocalNodes(nodes), [nodes]);

	const persistUi = React.useCallback(
		(
			nextNodes: Record<string, { x: number; y: number }>,
			nextEdges?: Record<string, { bendPoints: Array<{ x: number; y: number }> }>,
		) => {
			if (readOnly || !onChange) return;
			onChange({
				...document,
				ui: {
					direction,
					nodes: nextNodes,
					...(nextEdges ? { edges: nextEdges } : {}),
				},
			});
		},
		[document, readOnly, onChange, direction],
	);

	const onNodesChange = React.useCallback(
		(changes: NodeChange<EditorFlowNode>[]) => {
			const next = applyNodeChanges(changes, localNodes) as EditorFlowNode[];
			setLocalNodes(next);
		},
		[localNodes],
	);

	// Positions persist only when the drag stops.
	const onNodeDragStop: OnNodeDrag<EditorFlowNode> = React.useCallback(
		(_event, node) => {
			const nextNodes = { ...positions };
			for (const current of localNodes) {
				nextNodes[current.id] = {
					x: Math.round(current.position.x),
					y: Math.round(current.position.y),
				};
			}
			nextNodes[node.id] = { x: Math.round(node.position.x), y: Math.round(node.position.y) };
			persistUi(nextNodes);
		},
		[localNodes, positions, persistUi],
	);

	const onConnect = React.useCallback(
		(connection: Connection) => {
			if (readOnly || !onChange) return;
			const { source, target } = connection;
			if (!source || !target) return;
			const id = nextUniqueId(
				`${source}-to-${target}`,
				new Set(document.edges.map((edge) => edge.id)),
			);
			const nextEdge = defaultEdgeFactory(id, source, target);
			onChange({
				...document,
				edges: [...document.edges, nextEdge],
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
			for (const [id, position] of Object.entries(savedPositions)) {
				if (!deletedIds.has(id)) nextUiNodes[id] = position;
			}
			onChange({
				...document,
				root: nextRoot,
				stages: nextStages,
				edges: document.edges.filter(
					(edge) => !deletedIds.has(edge.from) && !deletedIds.has(edge.to),
				),
				ui: { direction, nodes: nextUiNodes },
			});
		},
		[document, readOnly, onChange, direction, savedPositions],
	);

	const onEdgesDelete = React.useCallback(
		(deleted: Array<{ id: string }>) => {
			if (readOnly || !onChange) return;
			const deletedIds = new Set(deleted.map((edge) => edge.id));
			const nextEdges = document.edges.filter((edge) => !deletedIds.has(edge.id));
			const nextBendPoints: Record<string, { bendPoints: Array<{ x: number; y: number }> }> = {};
			for (const [id, bend] of Object.entries(document.ui?.edges ?? {})) {
				if (!deletedIds.has(id)) nextBendPoints[id] = bend;
			}
			onChange({
				...document,
				edges: nextEdges,
				ui: {
					direction,
					nodes: savedPositions,
					...(Object.keys(nextBendPoints).length ? { edges: nextBendPoints } : {}),
				},
			});
		},
		[document, readOnly, onChange, direction, savedPositions],
	);

	const applyLayout = React.useCallback(async () => {
		if (readOnly || !onChange) return;
		const result = await computePipelineLayout(document, direction);
		persistUi(result.nodes, result.edges);
		requestAnimationFrame(() => void fitView({ padding: 0.2, duration: 300 }));
	}, [document, readOnly, onChange, persistUi, direction, fitView]);

	const switchDirection = React.useCallback(
		(next: PipelineLayoutDirection) => {
			if (readOnly || !onChange) return;
			// Compute with the *new* direction immediately — applyLayout would
			// still see the previous document/direction in its closure.
			void computePipelineLayout(document, next).then((result) => {
				onChange({
					...document,
					ui: {
						direction: next,
						nodes: result.nodes,
						edges: result.edges,
					},
				});
				requestAnimationFrame(() => void fitView({ padding: 0.2, duration: 300 }));
			});
		},
		[document, readOnly, onChange, fitView],
	);

	const { setCenter } = useReactFlow();
	const centerRoot = React.useCallback(() => {
		const rootPosition = positions[document.root];
		if (!rootPosition) return;
		void setCenter(rootPosition.x + NODE_WIDTH / 2, rootPosition.y + NODE_HEIGHT / 2, {
			zoom: 1,
			duration: 300,
		});
	}, [positions, document.root, setCenter]);

	return (
		<div className={cn("relative h-full w-full", className)}>
			{!readOnly && (
				<div className="absolute left-3 top-3 z-10 flex flex-col gap-1.5 rounded-lg border bg-background/95 p-1.5 shadow-sm">
					{onAddStage ? (
						<ToolbarButton label="Add stage" onClick={onAddStage}>
							<Plus className="size-4" />
						</ToolbarButton>
					) : null}
					<ToolbarButton
						label="Apply ELK layout"
						onClick={() => void applyLayout()}
					>
						<LayoutGrid className="size-4" />
					</ToolbarButton>
					<ToolbarButton
						label="Direction: DOWN"
						active={direction === "DOWN"}
						onClick={() => void switchDirection("DOWN")}
					>
						<AlignStartVertical className="size-4" />
					</ToolbarButton>
					<ToolbarButton
						label="Direction: RIGHT"
						active={direction === "RIGHT"}
						onClick={() => void switchDirection("RIGHT")}
					>
						<AlignStartHorizontal className="size-4" />
					</ToolbarButton>
					<ToolbarButton
						label="Center root stage"
						onClick={() => void centerRoot()}
					>
						<Focus className="size-4" />
					</ToolbarButton>
					<ToolbarButton
						label={interactionLock ? "Unlock canvas" : "Lock canvas"}
						active={interactionLock}
						onClick={() => setInteractionLock((locked) => !locked)}
					>
						{interactionLock ? (
							<Lock className="size-4" />
						) : (
							<MousePointer2 className="size-4" />
						)}
					</ToolbarButton>
				</div>
			)}

			<ReactFlow
				nodes={localNodes}
				edges={edges}
				nodeTypes={nodeTypes}
				edgeTypes={edgeTypes}
				onNodesChange={onNodesChange}
				onNodesDelete={onNodesDelete}
				onEdgesDelete={onEdgesDelete}
				onConnect={onConnect}
				onNodeDragStop={onNodeDragStop}
				nodesDraggable={!readOnly && !interactionLock}
				nodesConnectable={!readOnly && !interactionLock}
				elementsSelectable={!interactionLock}
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
				minZoom={0.1}
				proOptions={{ hideAttribution: true }}
			>
				<Background gap={24} />
				<MiniMap
					pannable
					zoomable
					nodeColor="#94a3b8"
					maskColor="rgba(0,0,0,0.1)"
					className="!bottom-3 !right-3"
				/>
				<Controls />
			</ReactFlow>
		</div>
	);
};

export const CanvasEditor = (props: CanvasEditorProps) => (
	<ReactFlowProvider>
		<CanvasEditorInner {...props} />
	</ReactFlowProvider>
);

const ToolbarButton = ({
	label,
	onClick,
	active = false,
	children,
}: {
	label: string;
	onClick: () => void;
	active?: boolean;
	children: React.ReactNode;
}) => (
	<button
		type="button"
		title={label}
		aria-label={label}
		onClick={onClick}
		className={cn(
			"inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground",
			active && "bg-primary/10 text-primary",
		)}
	>
		{children}
	</button>
);


