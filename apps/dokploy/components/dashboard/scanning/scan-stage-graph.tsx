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
import { AlertCircle, Loader2 } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { api, type RouterOutputs } from "@/utils/api";

type StageGraph = RouterOutputs["scan"]["stageGraph"];
type StageGraphNode = StageGraph["nodes"][number];
type PreviewAgentProfile = NonNullable<StageGraphNode["agentProfile"]>;
type PreviewAgentProfiles = RouterOutputs["ai"]["getAgentProfiles"] | undefined;
type PreviewServiceData = Record<string, unknown> | null | undefined;
type FullScanStageGraphTarget =
	| { applicationId: string; composeId?: never }
	| { composeId: string; applicationId?: never };
type StageFlowNodeData = Record<string, unknown> & {
	label: ReactNode;
	stageNode?: StageGraphNode;
};
type StageFlowNode = Node<StageFlowNodeData, "stage">;
type ElkSectionEdgeData = Record<string, unknown> & {
	points: Point[];
};
type ElkSectionEdge = Edge<ElkSectionEdgeData, "elkSection">;
type Side = "top" | "right" | "bottom" | "left";
type Point = { x: number; y: number };

const NODE_WIDTH = 220;
const NODE_HEIGHT = 92;
const GROUP_PADDING_X = 34;
const GROUP_PADDING_BOTTOM = 64;
const GROUP_LABEL_HEIGHT = 40;
const GROUP_NODE_TOP = GROUP_LABEL_HEIGHT + 20;
const GRAPH_PADDING = 28;
const NODE_GAP_X = 92;
const NODE_GAP_Y = 104;
const STAGES_PER_ROW = 4;
const BACK_EDGE_OFFSET_Y = 28;
const FORWARD_LONG_EDGE_OFFSET_Y = 30;
const EMPTY_FLOW_ELEMENTS = {
	nodes: [] as Node[],
	edges: [] as Edge[],
};

const emptyStageCounts = () => ({
	waiting: 0,
	queued: 0,
	launching: 0,
	launched: 0,
	starting: 0,
	running: 0,
	completed: 0,
	failed: 0,
	exited: 0,
	total: 0,
	pending: 0,
});

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
	if (node.counts.running > 0 || (node.counts.starting ?? 0) > 0) {
		return "border-sky-300 bg-sky-50 text-sky-950 dark:border-sky-500/70 dark:bg-sky-950/55 dark:text-sky-100";
	}
	if (node.counts.launching > 0 || (node.counts.launched ?? 0) > 0) {
		return "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-500/70 dark:bg-amber-950/55 dark:text-amber-100";
	}
	return "border-zinc-300 bg-zinc-50 text-zinc-800 dark:border-zinc-700 dark:bg-zinc-900/85 dark:text-zinc-100";
};

const StageLabel = ({ node }: { node: StageGraphNode }) => {
	const runningBlockCount = Math.max(
		1,
		node.concurrencyLimit,
		node.counts.running + (node.counts.starting ?? 0),
	);
	const runningBlocks = Array.from(
		{ length: runningBlockCount },
		(_, index) => `${node.stageName}-running-${index}`,
	);

	return (
		<div className="flex min-h-full flex-col justify-center gap-2.5 px-5 py-4">
			<div className="text-left text-[15px] font-semibold leading-snug tracking-normal">
				{node.name || node.title}
			</div>
			<div className="h-px bg-border/80" />
			<div className="flex min-h-4 flex-wrap items-center gap-1.5">
				{runningBlocks.map((blockId) => (
					<span
						key={blockId}
						className={`h-4 w-1.5 rounded-[1px] shadow-[0_0_0_1px_hsl(var(--background))] ${
							Number(blockId.slice(blockId.lastIndexOf("-") + 1)) <
							node.counts.running + (node.counts.starting ?? 0)
								? "bg-sky-500"
								: "bg-muted-foreground/20"
						}`}
					/>
				))}
			</div>
		</div>
	);
};

const formatBoolean = (value: boolean | null | undefined) =>
	value === undefined || value === null
		? "Not set"
		: value
			? "Enabled"
			: "Disabled";

const DetailRow = ({ label, value }: { label: string; value: ReactNode }) => (
	<div className="grid grid-cols-[150px_minmax(0,1fr)] gap-3 border-b py-2 last:border-b-0">
		<div className="text-sm text-muted-foreground">{label}</div>
		<div className="min-w-0 break-words text-sm font-medium">{value}</div>
	</div>
);

const StageDetailDialog = ({
	stage,
	onOpenChange,
}: {
	stage: StageGraphNode | null;
	onOpenChange: (open: boolean) => void;
}) => {
	const agentProfile = stage?.agentProfile;
	return (
		<Dialog open={Boolean(stage)} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>{stage?.name || stage?.title || "Stage"}</DialogTitle>
					<DialogDescription>
						Stage runtime settings and selected agent profile.
					</DialogDescription>
				</DialogHeader>
				{stage ? (
					<div className="space-y-4">
						<div className="rounded-lg border p-3">
							<div className="mb-2 text-sm font-semibold">Runtime</div>
							<DetailRow label="Stage ID" value={stage.stageName} />
							<DetailRow
								label="Concurrency Limit"
								value={stage.concurrencyLimit}
							/>
							<DetailRow
								label="Running"
								value={stage.counts.running + (stage.counts.starting ?? 0)}
							/>
							<DetailRow
								label="Launching"
								value={stage.counts.launching + (stage.counts.launched ?? 0)}
							/>
							<DetailRow label="Queued" value={stage.counts.queued} />
							<DetailRow label="Completed" value={stage.counts.completed} />
						</div>
						<div className="rounded-lg border p-3">
							<div className="mb-2 text-sm font-semibold">Agent Profile</div>
							{agentProfile ? (
								<>
									<DetailRow
										label="Name"
										value={agentProfile.name || "Unnamed"}
									/>
									<DetailRow
										label="Profile ID"
										value={agentProfile.agentProfileId}
									/>
									<DetailRow label="Provider" value={agentProfile.provider} />
									<DetailRow label="Model" value={agentProfile.model} />
									<DetailRow label="Auth Mode" value={agentProfile.authMode} />
									<DetailRow
										label="Home Path"
										value={agentProfile.homePath || "Not set"}
									/>
									<DetailRow
										label="Base URL"
										value={agentProfile.baseUrl || "Not set"}
									/>
									<DetailRow
										label="Thinking"
										value={formatBoolean(agentProfile.thinkingLevelEnabled)}
									/>
									<DetailRow
										label="Thinking Level"
										value={agentProfile.thinkingLevel || "Not set"}
									/>
								</>
							) : (
								<div className="text-sm text-muted-foreground">
									No agent profile is configured for this stage.
								</div>
							)}
						</div>
					</div>
				) : null}
			</DialogContent>
		</Dialog>
	);
};

const compareStageOrder = (left: StageGraphNode, right: StageGraphNode) => {
	const leftOrder = typeof left.order === "number" ? left.order : 0;
	const rightOrder = typeof right.order === "number" ? right.order : 0;
	return leftOrder === rightOrder
		? left.stageName.localeCompare(right.stageName)
		: leftOrder - rightOrder;
};

const getNodeAbsolutePositions = (graph: StageGraph) => {
	const nodeByStageName = new Map(
		graph.nodes.map((node) => [node.stageName, node]),
	);
	const groupByStageName = new Map(
		graph.groups.flatMap((group) =>
			group.stageNames.map((stageName) => [stageName, group] as const),
		),
	);
	const orderedNodes = [...graph.nodes].sort(compareStageOrder);
	const positionedStageNames = new Set<string>();
	const rows: string[][] = [[]];
	const appendUnit = (stageNames: string[]) => {
		const currentRow = rows[rows.length - 1] ?? [];
		if (
			currentRow.length > 0 &&
			currentRow.length + stageNames.length > STAGES_PER_ROW
		) {
			rows.push([...stageNames]);
			return;
		}
		currentRow.push(...stageNames);
		rows[rows.length - 1] = currentRow;
	};

	for (const node of orderedNodes) {
		if (positionedStageNames.has(node.stageName)) {
			continue;
		}
		const group = groupByStageName.get(node.stageName);
		const stageNames = group
			? group.stageNames
					.filter((stageName) => nodeByStageName.has(stageName))
					.sort((leftStageName, rightStageName) =>
						compareStageOrder(
							nodeByStageName.get(leftStageName)!,
							nodeByStageName.get(rightStageName)!,
						),
					)
			: [node.stageName];
		for (const stageName of stageNames) {
			positionedStageNames.add(stageName);
		}
		appendUnit(stageNames);
	}

	const positions = new Map<string, Point>();
	for (const [row, stageNames] of rows.entries()) {
		for (const [column, stageName] of stageNames.entries()) {
			positions.set(stageName, {
				x: GRAPH_PADDING + column * (NODE_WIDTH + NODE_GAP_X),
				y: GRAPH_PADDING + row * (NODE_HEIGHT + NODE_GAP_Y),
			});
		}
	}
	return positions;
};

const getGroupBounds = (
	stageNames: string[],
	positions: Map<string, Point>,
) => {
	const memberPositions = stageNames.flatMap((stageName) => {
		const position = positions.get(stageName);
		return position ? [position] : [];
	});
	if (memberPositions.length === 0) {
		return null;
	}
	const minX = Math.min(...memberPositions.map((position) => position.x));
	const minY = Math.min(...memberPositions.map((position) => position.y));
	const maxX = Math.max(...memberPositions.map((position) => position.x));
	const maxY = Math.max(...memberPositions.map((position) => position.y));
	return {
		x: minX - GROUP_PADDING_X,
		y: minY - GROUP_NODE_TOP,
		width: maxX - minX + NODE_WIDTH + GROUP_PADDING_X * 2,
		height: maxY - minY + NODE_HEIGHT + GROUP_NODE_TOP + GROUP_PADDING_BOTTOM,
	};
};

const buildEdgePoints = (source: Point, target: Point) => {
	const sourceRow = Math.round(
		(source.y - GRAPH_PADDING) / (NODE_HEIGHT + NODE_GAP_Y),
	);
	const targetRow = Math.round(
		(target.y - GRAPH_PADDING) / (NODE_HEIGHT + NODE_GAP_Y),
	);
	const sourceColumn = Math.round(
		(source.x - GRAPH_PADDING) / (NODE_WIDTH + NODE_GAP_X),
	);
	const targetColumn = Math.round(
		(target.x - GRAPH_PADDING) / (NODE_WIDTH + NODE_GAP_X),
	);
	if (sourceRow === targetRow) {
		const sourceIsLeft = source.x <= target.x;
		if (!sourceIsLeft) {
			const routeY = Math.min(source.y, target.y) - BACK_EDGE_OFFSET_Y;
			const start = {
				x: source.x + NODE_WIDTH / 2,
				y: source.y,
			};
			const end = {
				x: target.x + NODE_WIDTH / 2,
				y: target.y,
			};
			return [start, { x: start.x, y: routeY }, { x: end.x, y: routeY }, end];
		}
		if (Math.abs(targetColumn - sourceColumn) > 1) {
			const routeY = source.y + NODE_HEIGHT + FORWARD_LONG_EDGE_OFFSET_Y;
			const start = {
				x: source.x + NODE_WIDTH / 2,
				y: source.y + NODE_HEIGHT,
			};
			const end = {
				x: target.x + NODE_WIDTH / 2,
				y: target.y + NODE_HEIGHT,
			};
			return [start, { x: start.x, y: routeY }, { x: end.x, y: routeY }, end];
		}
		const start = {
			x: source.x + NODE_WIDTH,
			y: source.y + NODE_HEIGHT / 2,
		};
		const end = {
			x: target.x,
			y: target.y + NODE_HEIGHT / 2,
		};
		const midX = start.x + (end.x - start.x) / 2;
		return [start, { x: midX, y: start.y }, { x: midX, y: end.y }, end];
	}

	const sourceIsAbove = source.y <= target.y;
	const start = {
		x: source.x + NODE_WIDTH / 2,
		y: source.y + (sourceIsAbove ? NODE_HEIGHT : 0),
	};
	const end = {
		x: target.x + NODE_WIDTH / 2,
		y: target.y + (sourceIsAbove ? 0 : NODE_HEIGHT),
	};
	const midY = start.y + (end.y - start.y) / 2;
	return [start, { x: start.x, y: midY }, { x: end.x, y: midY }, end];
};

const buildFlowElements = (graph: StageGraph) => {
	const groupById = new Map(graph.groups.map((group) => [group.id, group]));
	const stagePositions = getNodeAbsolutePositions(graph);
	const groupBoundsById = new Map(
		graph.groups.flatMap((group) => {
			const bounds = getGroupBounds(group.stageNames, stagePositions);
			return bounds ? [[group.id, bounds] as const] : [];
		}),
	);

	const flowNodes: Node[] = [
		...graph.groups.flatMap<Node>((group) => {
			const bounds = groupBoundsById.get(group.id);
			if (!bounds) {
				return [];
			}
			return [
				{
					id: group.id,
					type: "group",
					position: { x: bounds.x, y: bounds.y },
					data: {
						label: (
							<div className="px-3 pt-3 text-sm font-semibold capitalize text-muted-foreground">
								{group.name.replace(/-/g, " ")}
							</div>
						),
					},
					style: {
						width: bounds.width,
						height: bounds.height,
						borderRadius: 8,
						border: "1px solid hsl(var(--border))",
						background: "hsl(var(--muted) / 0.52)",
					},
					draggable: false,
					selectable: false,
					zIndex: 0,
				},
			];
		}),
		...graph.nodes.map<Node>((node) => {
			const groupId =
				node.groupId && groupById.has(node.groupId) ? node.groupId : null;
			const groupBounds = groupId ? groupBoundsById.get(groupId) : null;
			const position = stagePositions.get(node.stageName) ?? {
				x: GRAPH_PADDING,
				y: GRAPH_PADDING,
			};
			return {
				id: node.stageName,
				type: "stage",
				parentId: groupId ?? undefined,
				extent: groupId ? "parent" : undefined,
				position:
					groupId && groupBounds
						? { x: position.x - groupBounds.x, y: position.y - groupBounds.y }
						: position,
				data: { label: <StageLabel node={node} />, stageNode: node },
				className: `cursor-pointer rounded-md border-2 shadow-md backdrop-blur-sm ${getStatusClassName(node)}`,
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
		const source = stagePositions.get(edge.source);
		const target = stagePositions.get(edge.target);
		return {
			id: edge.id,
			source: edge.source,
			target: edge.target,
			type: "elkSection" as const,
			animated: true,
			zIndex: 1,
			data: {
				points: source && target ? buildEdgePoints(source, target) : [],
			},
			markerEnd: {
				type: MarkerType.ArrowClosed,
				width: 16,
				height: 16,
				color: "hsl(var(--foreground) / 0.62)",
			},
			style: {
				strokeWidth: 1.5,
				stroke: "hsl(var(--foreground) / 0.62)",
				strokeDasharray: "6 6",
			},
		};
	});

	return { nodes: flowNodes, edges: flowEdges };
};

const ScanStageGraphPanel = ({
	graph,
	isLoading = false,
	error,
	title = "Stage Graph",
	description = "Pipeline topology and live stage progress.",
	heightClassName = "h-[420px] md:h-[520px]",
}: {
	graph?: StageGraph | null;
	isLoading?: boolean;
	error?: unknown;
	title?: string;
	description?: string;
	heightClassName?: string;
}) => {
	const [elements, setElements] = useState(EMPTY_FLOW_ELEMENTS);
	const [layoutError, setLayoutError] = useState<Error | null>(null);
	const [selectedStage, setSelectedStage] = useState<StageGraphNode | null>(
		null,
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
		try {
			const nextElements = buildFlowElements(graph);
			if (!isCancelled) {
				setElements(nextElements);
			}
		} catch (nextError) {
			if (!isCancelled) {
				setElements(EMPTY_FLOW_ELEMENTS);
				setLayoutError(
					nextError instanceof Error
						? nextError
						: new Error("Failed to layout stage graph"),
				);
			}
		}

		return () => {
			isCancelled = true;
		};
	}, [graph]);

	return (
		<div className="rounded-lg border bg-background">
			<div className="border-b px-4 py-3">
				<div className="font-medium">{title}</div>
				<div className="text-sm text-muted-foreground">{description}</div>
			</div>
			<div className={`relative bg-muted/10 ${heightClassName}`}>
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
						className="scan-stage-graph-flow text-foreground"
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
						onNodeClick={(_event, node) => {
							const stageNode = node.data?.stageNode;
							if (stageNode) {
								setSelectedStage(stageNode as StageGraphNode);
							}
						}}
						proOptions={{ hideAttribution: true }}
					>
						<Background color="hsl(var(--muted-foreground) / 0.28)" />
						<Controls showInteractive={false} />
					</ReactFlow>
				)}
			</div>
			<style jsx global>{`
				.scan-stage-graph-flow .react-flow__controls {
					border: 1px solid hsl(var(--border));
					box-shadow: 0 10px 24px hsl(var(--foreground) / 0.08);
				}
				.scan-stage-graph-flow .react-flow__controls-button {
					background: hsl(var(--background) / 0.92);
					border-bottom: 1px solid hsl(var(--border));
					color: hsl(var(--foreground));
				}
				.scan-stage-graph-flow .react-flow__controls-button:hover {
					background: hsl(var(--muted));
				}
				.scan-stage-graph-flow .react-flow__controls-button svg {
					fill: currentColor;
				}
				.dark .scan-stage-graph-flow .react-flow__edge.animated path {
					stroke-dasharray: 6;
				}
			`}</style>
			<StageDetailDialog
				stage={selectedStage}
				onOpenChange={(open) => {
					if (!open) {
						setSelectedStage(null);
					}
				}}
			/>
		</div>
	);
};

const createPreviewNode = ({
	stageName,
	name,
	order,
	groupId = null,
	concurrencyLimit = 1,
	agentProfile = null,
}: {
	stageName: string;
	name: string;
	order: number;
	groupId?: string | null;
	concurrencyLimit?: number;
	agentProfile?: StageGraphNode["agentProfile"];
}): StageGraphNode => ({
	id: stageName,
	stageId: stageName,
	stageName,
	name,
	title: name,
	queueId: null,
	queueName: null,
	status: "pending",
	counts: emptyStageCounts(),
	concurrencyLimit,
	agentProfile,
	groupId,
	order,
});

const asRecord = (value: unknown): Record<string, unknown> | null =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;

const asPreviewAgentProfile = (
	value: unknown,
): StageGraphNode["agentProfile"] => {
	const record = asRecord(value);
	if (!record) {
		return null;
	}
	const agentProfileId =
		typeof record.agentProfileId === "string" ? record.agentProfileId : "";
	const name = typeof record.name === "string" ? record.name : "";
	const model = typeof record.model === "string" ? record.model : "";
	if (!agentProfileId && !name && !model) {
		return null;
	}
	const provider =
		record.provider === "claude_code" || record.provider === "codex"
			? record.provider
			: "codex";
	const authMode = record.authMode === "host_home" ? "host_home" : "api_key";
	return {
		agentProfileId,
		name,
		provider,
		authMode,
		homePath: typeof record.homePath === "string" ? record.homePath : "",
		baseUrl: typeof record.baseUrl === "string" ? record.baseUrl : "",
		model,
		thinkingLevel:
			typeof record.thinkingLevel === "string" ? record.thinkingLevel : "",
		thinkingLevelEnabled:
			typeof record.thinkingLevelEnabled === "boolean"
				? record.thinkingLevelEnabled
				: false,
	};
};

const buildPreviewAgentProfileReference = (
	agentProfileId: string,
): PreviewAgentProfile => ({
	agentProfileId,
	name: agentProfileId,
	provider: "codex",
	authMode: "api_key",
	homePath: "",
	baseUrl: "",
	model: "",
	thinkingLevel: "",
	thinkingLevelEnabled: false,
});

const getKnownPreviewAgentProfiles = (
	serviceData: PreviewServiceData,
	agentProfiles: PreviewAgentProfiles,
) => {
	const serviceRecord = asRecord(serviceData);
	const explicitProfiles = (agentProfiles ?? []).map((profile) =>
		asPreviewAgentProfile(profile),
	);
	if (!serviceRecord) {
		return explicitProfiles.filter((profile): profile is PreviewAgentProfile =>
			Boolean(profile),
		);
	}
	return explicitProfiles.filter((profile): profile is PreviewAgentProfile =>
		Boolean(profile),
	);
};

const getStageSettingsRecord = (
	serviceData: PreviewServiceData,
	stageName: string,
) => {
	const serviceRecord = asRecord(serviceData);
	const scanStageSettings = asRecord(serviceRecord?.scanStageSettings);
	return asRecord(scanStageSettings?.[stageName]);
};

const getPreviewAgentProfile = (
	serviceData: PreviewServiceData,
	agentProfiles: PreviewAgentProfiles,
	stageName: string,
	_kind: "scan" | "analysis" | "verification",
) => {
	const serviceRecord = asRecord(serviceData);
	if (!serviceRecord) {
		return null;
	}

	const knownProfiles = getKnownPreviewAgentProfiles(
		serviceData,
		agentProfiles,
	);
	const stageAgentProfileId = getStageSettingsRecord(
		serviceData,
		stageName,
	)?.agentProfileId;
	if (typeof stageAgentProfileId === "string" && stageAgentProfileId) {
		return (
			knownProfiles.find(
				(profile) => profile.agentProfileId === stageAgentProfileId,
			) ?? buildPreviewAgentProfileReference(stageAgentProfileId)
		);
	}
	return null;
};

const getPreviewConcurrencyLimit = (
	serviceData: PreviewServiceData,
	stageName: string,
	fallback: number,
) => {
	const stageConcurrency = getStageSettingsRecord(
		serviceData,
		stageName,
	)?.concurrency;
	if (
		typeof stageConcurrency === "number" &&
		Number.isFinite(stageConcurrency)
	) {
		return Math.max(1, stageConcurrency);
	}
	return Math.max(1, fallback);
};

const buildFullScanPreviewGraph = (
	serviceData: PreviewServiceData,
	agentProfiles: PreviewAgentProfiles,
): StageGraph => {
	return {
		pipelineName: "full-scan-programmatic",
		nodes: [
			createPreviewNode({
				stageName: "repository-scan",
				name: "Scan Repository",
				order: 0,
				agentProfile: getPreviewAgentProfile(
					serviceData,
					agentProfiles,
					"repository-scan",
					"scan",
				),
			}),
			createPreviewNode({
				stageName: "module-scan",
				name: "Scan Module",
				order: 1,
				concurrencyLimit: getPreviewConcurrencyLimit(
					serviceData,
					"module-scan",
					4,
				),
				agentProfile: getPreviewAgentProfile(
					serviceData,
					agentProfiles,
					"module-scan",
					"scan",
				),
			}),
			createPreviewNode({
				stageName: "function-scan",
				name: "Scan Function",
				order: 2,
				concurrencyLimit: getPreviewConcurrencyLimit(
					serviceData,
					"function-scan",
					4,
				),
				agentProfile: getPreviewAgentProfile(
					serviceData,
					agentProfiles,
					"function-scan",
					"scan",
				),
			}),
			createPreviewNode({
				stageName: "analyze",
				name: "Analyze",
				order: 3,
				groupId: "analysis-fuzzing-debate",
				concurrencyLimit: getPreviewConcurrencyLimit(serviceData, "analyze", 2),
				agentProfile: getPreviewAgentProfile(
					serviceData,
					agentProfiles,
					"analyze",
					"analysis",
				),
			}),
			createPreviewNode({
				stageName: "build-fuzzer",
				name: "Build Fuzzer",
				order: 4,
				groupId: "analysis-fuzzing-debate",
				concurrencyLimit: getPreviewConcurrencyLimit(
					serviceData,
					"build-fuzzer",
					2,
				),
				agentProfile: getPreviewAgentProfile(
					serviceData,
					agentProfiles,
					"build-fuzzer",
					"analysis",
				),
			}),
			createPreviewNode({
				stageName: "run-fuzzer",
				name: "Run Fuzzer",
				order: 5,
				groupId: "analysis-fuzzing-debate",
				concurrencyLimit: getPreviewConcurrencyLimit(
					serviceData,
					"run-fuzzer",
					2,
				),
				agentProfile: getPreviewAgentProfile(
					serviceData,
					agentProfiles,
					"run-fuzzer",
					"analysis",
				),
			}),
			createPreviewNode({
				stageName: "criticize",
				name: "Criticize",
				order: 6,
				groupId: "analysis-fuzzing-debate",
				concurrencyLimit: getPreviewConcurrencyLimit(
					serviceData,
					"criticize",
					2,
				),
				agentProfile: getPreviewAgentProfile(
					serviceData,
					agentProfiles,
					"criticize",
					"analysis",
				),
			}),
			createPreviewNode({
				stageName: "verify",
				name: "Verify",
				order: 7,
				concurrencyLimit: getPreviewConcurrencyLimit(serviceData, "verify", 1),
				agentProfile: getPreviewAgentProfile(
					serviceData,
					agentProfiles,
					"verify",
					"verification",
				),
			}),
			createPreviewNode({
				stageName: "triage",
				name: "Triage",
				order: 8,
				concurrencyLimit: getPreviewConcurrencyLimit(serviceData, "triage", 1),
				agentProfile: getPreviewAgentProfile(
					serviceData,
					agentProfiles,
					"triage",
					"verification",
				),
			}),
		],
		edges: [
			{
				id: "repository-to-module",
				name: "repository-to-module",
				source: "repository-scan",
				target: "module-scan",
				fork: true,
				routeKey: null,
				isDefaultRoute: false,
			},
			{
				id: "module-to-function",
				name: "module-to-function",
				source: "module-scan",
				target: "function-scan",
				fork: true,
				routeKey: null,
				isDefaultRoute: false,
			},
			{
				id: "function-to-analysis",
				name: "function-to-analysis",
				source: "function-scan",
				target: "analyze",
				fork: false,
				routeKey: null,
				isDefaultRoute: false,
			},
			{
				id: "analysis-to-fuzz-build",
				name: "analysis-to-fuzz-build",
				source: "analyze",
				target: "build-fuzzer",
				fork: true,
				routeKey: "build_fuzzer",
				isDefaultRoute: true,
			},
			{
				id: "analysis-to-critic",
				name: "analysis-to-critic",
				source: "analyze",
				target: "criticize",
				fork: false,
				routeKey: "critic",
				isDefaultRoute: false,
			},
			{
				id: "fuzz-build-to-fuzz-run",
				name: "fuzz-build-to-fuzz-run",
				source: "build-fuzzer",
				target: "run-fuzzer",
				fork: true,
				routeKey: "run_fuzzer",
				isDefaultRoute: false,
			},
			{
				id: "fuzz-build-to-analysis",
				name: "fuzz-build-to-analysis",
				source: "build-fuzzer",
				target: "analyze",
				fork: false,
				routeKey: "analysis",
				isDefaultRoute: true,
			},
			{
				id: "fuzz-run-to-analysis",
				name: "fuzz-run-to-analysis",
				source: "run-fuzzer",
				target: "analyze",
				fork: false,
				routeKey: "analysis",
				isDefaultRoute: true,
			},
			{
				id: "critic-to-analysis",
				name: "critic-to-analysis",
				source: "criticize",
				target: "analyze",
				fork: false,
				routeKey: null,
				isDefaultRoute: false,
			},
			{
				id: "analysis-to-verification",
				name: "analysis-to-verification",
				source: "analyze",
				target: "verify",
				fork: false,
				routeKey: "verification",
				isDefaultRoute: false,
			},
			{
				id: "verification-to-triage",
				name: "verification-to-triage",
				source: "verify",
				target: "triage",
				fork: false,
				routeKey: null,
				isDefaultRoute: false,
			},
		],
		groups: [
			{
				id: "analysis-fuzzing-debate",
				name: "analysis-fuzzing-debate",
				leaderStageName: "analyze",
				memberStageNames: ["build-fuzzer", "run-fuzzer", "criticize"],
				stageNames: ["analyze", "build-fuzzer", "run-fuzzer", "criticize"],
			},
		],
	};
};

export const FullScanStageGraphPreview = ({
	serviceData,
}: {
	serviceData?: PreviewServiceData;
}) => {
	const target = useMemo<FullScanStageGraphTarget | null>(() => {
		const serviceRecord = asRecord(serviceData);
		const applicationId = serviceRecord?.applicationId;
		if (typeof applicationId === "string" && applicationId) {
			return { applicationId };
		}
		const composeId = serviceRecord?.composeId;
		if (typeof composeId === "string" && composeId) {
			return { composeId };
		}
		return null;
	}, [serviceData]);
	const {
		data: graph,
		isLoading,
		error,
	} = api.scan.fullScanStageGraph.useQuery(target ?? { applicationId: "" }, {
		enabled: Boolean(target),
	});
	return (
		<ScanStageGraphPanel
			graph={graph}
			isLoading={isLoading}
			error={error}
			description="Full scan pipeline preview."
			heightClassName="h-[360px]"
		/>
	);
};

export const ScanStageGraph = ({ scanJobId }: { scanJobId: string }) => {
	const {
		data: graph,
		isLoading,
		error,
	} = api.scan.stageGraph.useQuery(
		{ scanJobId },
		{ enabled: !!scanJobId, refetchInterval: 1000 },
	);
	return (
		<ScanStageGraphPanel graph={graph} isLoading={isLoading} error={error} />
	);
};
