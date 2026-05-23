import {
	Background,
	BaseEdge,
	Controls,
	type Edge,
	type EdgeProps,
	type EdgeTypes,
	Handle,
	MarkerType,
	type Node,
	type NodeProps,
	type NodeTypes,
	Position,
	ReactFlow,
} from "@xyflow/react";
import ElkConstructor from "elkjs/lib/elk.bundled.js";
import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";
import { AlertCircle, Loader2 } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useEffect, useState } from "react";
import { api, type RouterOutputs } from "@/utils/api";

type StageGraph = RouterOutputs["scan"]["stageGraph"];
type StageGraphNode = StageGraph["nodes"][number];
type StageFlowNodeData = Record<string, unknown> & {
	label: ReactNode;
};
type StageFlowNode = Node<StageFlowNodeData, "stage">;
type ElkSectionEdgeData = Record<string, unknown> & {
	points: Point[];
};
type ElkSectionEdge = Edge<ElkSectionEdgeData, "elkSection">;
type Side = "top" | "right" | "bottom" | "left";
type Point = { x: number; y: number };

const NODE_WIDTH = 188;
const NODE_HEIGHT = 78;
const GROUP_PADDING_X = 30;
const GROUP_PADDING_BOTTOM = 24;
const GROUP_LABEL_HEIGHT = 34;
const GROUP_NODE_TOP = GROUP_LABEL_HEIGHT + 18;
const elk = new ElkConstructor({
	defaultLayoutOptions: {
		"elk.algorithm": "layered",
		"elk.direction": "RIGHT",
		"elk.edgeRouting": "ORTHOGONAL",
		"elk.hierarchyHandling": "INCLUDE_CHILDREN",
		"elk.layered.spacing.nodeNodeBetweenLayers": "90",
		"elk.spacing.nodeNode": "44",
		"elk.spacing.edgeNode": "32",
		"elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
	},
});
const EMPTY_FLOW_ELEMENTS = {
	nodes: [] as Node[],
	edges: [] as Edge[],
};

const SIDE_POSITION = {
	top: Position.Top,
	right: Position.Right,
	bottom: Position.Bottom,
	left: Position.Left,
} satisfies Record<Side, Position>;

const HANDLE_STYLE = {
	width: 1,
	height: 1,
	minWidth: 1,
	minHeight: 1,
	border: 0,
	background: "transparent",
	opacity: 0,
	pointerEvents: "none",
} satisfies CSSProperties;

const StageNode = ({ data }: NodeProps<StageFlowNode>) => {
	return (
		<>
			{(Object.keys(SIDE_POSITION) as Side[]).flatMap((side) => [
				<Handle
					key={`source-${side}`}
					id={`source-${side}`}
					type="source"
					position={SIDE_POSITION[side]}
					isConnectable={false}
					style={HANDLE_STYLE}
				/>,
				<Handle
					key={`target-${side}`}
					id={`target-${side}`}
					type="target"
					position={SIDE_POSITION[side]}
					isConnectable={false}
					style={HANDLE_STYLE}
				/>,
			])}
			{data.label}
		</>
	);
};

const NODE_TYPES = {
	stage: StageNode,
} satisfies NodeTypes;

const buildSectionPath = (points: Point[]) => {
	if (points.length === 0) {
		return "";
	}
	const [firstPoint, ...nextPoints] = points;
	return [
		`M ${firstPoint?.x ?? 0} ${firstPoint?.y ?? 0}`,
		...nextPoints.map((point) => `L ${point.x} ${point.y}`),
	].join(" ");
};

const ElkSectionEdgeComponent = ({
	data,
	id,
	markerEnd,
	style,
}: EdgeProps<ElkSectionEdge>) => {
	return (
		<BaseEdge
			id={id}
			path={buildSectionPath(data?.points ?? [])}
			markerEnd={markerEnd}
			style={style}
		/>
	);
};

const EDGE_TYPES = {
	elkSection: ElkSectionEdgeComponent,
} satisfies EdgeTypes;

const getStatusClassName = (node: StageGraphNode) => {
	if (node.counts.running > 0) {
		return "border-sky-300 bg-sky-50 text-sky-900";
	}
	if (node.counts.launching > 0) {
		return "border-amber-300 bg-amber-50 text-amber-900";
	}
	return "border-zinc-300 bg-zinc-50 text-zinc-700";
};

const StageLabel = ({ node }: { node: StageGraphNode }) => {
	const runningBlockCount = Math.max(
		1,
		node.concurrencyLimit,
		node.counts.running,
	);
	const runningBlocks = Array.from(
		{ length: runningBlockCount },
		(_, index) => `${node.stageName}-running-${index}`,
	);

	return (
		<div className="flex min-h-full flex-col justify-center gap-2 px-4 py-3">
			<div className="text-left text-[13px] font-semibold leading-snug tracking-normal">
				{node.name || node.title}
			</div>
			<div className="h-px bg-border/80" />
			<div className="flex min-h-3 flex-wrap items-center gap-1">
				{runningBlocks.map((blockId) => (
					<span
						key={blockId}
						className={`h-3 w-1 rounded-[1px] shadow-[0_0_0_1px_hsl(var(--background))] ${
							Number(blockId.slice(blockId.lastIndexOf("-") + 1)) <
							node.counts.running
								? "bg-sky-500"
								: "bg-muted-foreground/20"
						}`}
					/>
				))}
			</div>
		</div>
	);
};

const buildFlowElements = async (graph: StageGraph) => {
	const groupById = new Map(graph.groups.map((group) => [group.id, group]));
	const stageNodeByName = new Map(
		graph.nodes.map((node) => [node.stageName, node]),
	);
	const stageGroupIdByName = new Map(
		graph.groups.flatMap((group) =>
			group.stageNames.map((stageName) => [stageName, group.id] as const),
		),
	);
	const groupedStageNames = new Set(
		graph.groups.flatMap((group) => group.stageNames),
	);
	const rootChildren: ElkNode[] = [
		...graph.groups.map<ElkNode>((group) => ({
			id: group.id,
			width: NODE_WIDTH + GROUP_PADDING_X * 2,
			height: NODE_HEIGHT + GROUP_NODE_TOP + GROUP_PADDING_BOTTOM,
			layoutOptions: {
				"elk.padding": `[top=${GROUP_NODE_TOP},left=${GROUP_PADDING_X},bottom=${GROUP_PADDING_BOTTOM},right=${GROUP_PADDING_X}]`,
				"elk.direction": "RIGHT",
			},
			children: group.stageNames.flatMap<ElkNode>((stageName) => {
				if (!stageNodeByName.has(stageName)) {
					return [];
				}
				return [
					{
						id: stageName,
						width: NODE_WIDTH,
						height: NODE_HEIGHT,
					},
				];
			}),
			edges: graph.edges
				.filter(
					(edge) =>
						stageGroupIdByName.get(edge.source) === group.id &&
						stageGroupIdByName.get(edge.target) === group.id,
				)
				.map((edge) => ({
					id: edge.id,
					sources: [edge.source],
					targets: [edge.target],
				})),
		})),
		...graph.nodes.flatMap<ElkNode>((node) => {
			if (
				(node.groupId && groupById.has(node.groupId)) ||
				groupedStageNames.has(node.stageName)
			) {
				return [];
			}
			return [
				{
					id: node.stageName,
					width: NODE_WIDTH,
					height: NODE_HEIGHT,
				},
			];
		}),
	];
	const layoutedGraph = await elk.layout({
		id: "stage-graph",
		layoutOptions: {
			"elk.padding": "[top=24,left=24,bottom=24,right=24]",
		},
		children: rootChildren,
		edges: graph.edges
			.filter((edge) => {
				const sourceGroupId = stageGroupIdByName.get(edge.source);
				return (
					!sourceGroupId ||
					sourceGroupId !== stageGroupIdByName.get(edge.target)
				);
			})
			.map((edge) => ({
				id: edge.id,
				sources: [edge.source],
				targets: [edge.target],
			})),
	});
	const rootNodeById = new Map(
		(layoutedGraph.children ?? []).map((node) => [node.id, node]),
	);
	const groupNodeById = new Map(
		graph.groups.flatMap((group) => {
			const groupNode = rootNodeById.get(group.id);
			return groupNode ? [[group.id, groupNode] as const] : [];
		}),
	);
	const edgeSectionPointsById = new Map<string, Point[]>();
	const collectEdgeSections = (
		edges: ElkExtendedEdge[] | undefined,
		offset: Point,
	) => {
		for (const edge of edges ?? []) {
			const section = edge.sections?.[0];
			if (!section) {
				continue;
			}
			edgeSectionPointsById.set(
				edge.id,
				[
					section.startPoint,
					...(section.bendPoints ?? []),
					section.endPoint,
				].map((point) => ({
					x: point.x + offset.x,
					y: point.y + offset.y,
				})),
			);
		}
	};
	collectEdgeSections(layoutedGraph.edges as ElkExtendedEdge[] | undefined, {
		x: 0,
		y: 0,
	});
	for (const groupNode of groupNodeById.values()) {
		collectEdgeSections(groupNode.edges as ElkExtendedEdge[] | undefined, {
			x: groupNode.x ?? 0,
			y: groupNode.y ?? 0,
		});
	}

	const flowNodes: Node[] = [
		...graph.groups.flatMap<Node>((group) => {
			const groupNode = groupNodeById.get(group.id);
			if (!groupNode) {
				return [];
			}
			return [
				{
					id: group.id,
					type: "group",
					position: { x: groupNode.x ?? 0, y: groupNode.y ?? 0 },
					data: {
						label: (
							<div className="px-2 pt-2 text-xs font-medium text-muted-foreground">
								{group.name.replace(/-/g, " ")}
							</div>
						),
					},
					style: {
						width: groupNode.width ?? NODE_WIDTH + GROUP_PADDING_X * 2,
						height:
							groupNode.height ??
							NODE_HEIGHT + GROUP_NODE_TOP + GROUP_PADDING_BOTTOM,
						borderRadius: 8,
						border: "1px solid hsl(var(--border))",
						background: "hsl(var(--muted) / 0.68)",
					},
					draggable: false,
					selectable: false,
					zIndex: 0,
				},
			];
		}),
		...graph.nodes.map<Node>((node) => {
			const groupId =
				node.groupId && groupNodeById.has(node.groupId) ? node.groupId : null;
			const groupNode = groupId ? groupNodeById.get(groupId) : null;
			const childNode = groupNode?.children?.find(
				(child) => child.id === node.stageName,
			);
			const rootNode = rootNodeById.get(node.stageName);
			return {
				id: node.stageName,
				type: "stage",
				parentId: groupId ?? undefined,
				extent: groupId ? "parent" : undefined,
				position:
					groupId && childNode
						? { x: childNode.x ?? 0, y: childNode.y ?? 0 }
						: { x: rootNode?.x ?? 0, y: rootNode?.y ?? 0 },
				data: { label: <StageLabel node={node} /> },
				className: `rounded-md border-2 shadow-md backdrop-blur-sm ${getStatusClassName(node)}`,
				style: {
					width: NODE_WIDTH,
					minHeight: NODE_HEIGHT,
					padding: 0,
				},
				draggable: false,
				selectable: false,
				zIndex: 2,
			};
		}),
	];

	const flowEdges: ElkSectionEdge[] = graph.edges.map((edge) => {
		return {
			id: edge.id,
			source: edge.source,
			target: edge.target,
			type: "elkSection" as const,
			animated: edge.fork,
			zIndex: 1,
			data: {
				points: edgeSectionPointsById.get(edge.id) ?? [],
			},
			markerEnd: {
				type: MarkerType.ArrowClosed,
				width: 16,
				height: 16,
			},
			style: {
				strokeWidth: 1.5,
			},
		};
	});

	return { nodes: flowNodes, edges: flowEdges };
};

export const ScanStageGraph = ({ scanJobId }: { scanJobId: string }) => {
	const [elements, setElements] = useState(EMPTY_FLOW_ELEMENTS);
	const [layoutError, setLayoutError] = useState<Error | null>(null);
	const {
		data: graph,
		isLoading,
		error,
	} = api.scan.stageGraph.useQuery(
		{ scanJobId },
		{ enabled: !!scanJobId, refetchInterval: 1000 },
	);
	const isLayoutLoading = Boolean(
		graph &&
			graph.nodes.length > 0 &&
			elements.nodes.length === 0 &&
			!layoutError,
	);

	useEffect(() => {
		let isCancelled = false;
		if (!graph || graph.nodes.length === 0) {
			setElements(EMPTY_FLOW_ELEMENTS);
			setLayoutError(null);
			return;
		}

		setLayoutError(null);
		void buildFlowElements(graph)
			.then((nextElements) => {
				if (!isCancelled) {
					setElements(nextElements);
				}
			})
			.catch((nextError) => {
				if (!isCancelled) {
					setElements(EMPTY_FLOW_ELEMENTS);
					setLayoutError(
						nextError instanceof Error
							? nextError
							: new Error("Failed to layout stage graph"),
					);
				}
			});

		return () => {
			isCancelled = true;
		};
	}, [graph]);

	return (
		<div className="rounded-lg border">
			<div className="border-b px-4 py-3">
				<div className="font-medium">Stage Graph</div>
				<div className="text-sm text-muted-foreground">
					Pipeline topology and live stage progress.
				</div>
			</div>
			<div className="relative h-[360px] md:h-[420px]">
				{isLoading || isLayoutLoading ? (
					<div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
						<Loader2 className="size-4 animate-spin" />
						Loading stage graph...
					</div>
				) : error || layoutError ? (
					<div className="flex h-full items-center justify-center gap-2 text-sm text-destructive">
						<AlertCircle className="size-4" />
						Failed to load stage graph.
					</div>
				) : !graph || graph.nodes.length === 0 ? (
					<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
						No stage graph available.
					</div>
				) : (
					<ReactFlow
						nodes={elements.nodes}
						edges={elements.edges}
						nodeTypes={NODE_TYPES}
						edgeTypes={EDGE_TYPES}
						fitView
						nodesDraggable={false}
						nodesConnectable={false}
						elementsSelectable={false}
						panOnScroll={false}
						zoomOnScroll
						zoomOnPinch
						proOptions={{ hideAttribution: true }}
					>
						<div className="absolute right-3 top-3 z-10 flex items-center gap-4 rounded-md border bg-background/90 px-3 py-2 text-xs text-muted-foreground shadow-sm backdrop-blur">
							<div className="flex items-center gap-2">
								<span className="h-px w-8 bg-foreground/60" />
								<span>normal</span>
							</div>
							<div className="flex items-center gap-2">
								<span className="h-px w-8 border-t border-dashed border-foreground/60" />
								<span>fork</span>
							</div>
						</div>
						<Background />
						<Controls showInteractive={false} />
					</ReactFlow>
				)}
			</div>
		</div>
	);
};
