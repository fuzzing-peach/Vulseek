import { useEffect, useRef, useState } from "react";
import type { RouterOutputs } from "@/utils/api";
import {
	formatAnalysisResultLabel,
	formatTriageResultLabel,
	formatTruthResultLabel,
	type ScanTranslation,
	scanT,
} from "./scan-i18n";

// ─── Result flow visualization (Analysis → Verify → Triage) ─────────────────

const formatSummaryCount = (value?: number | null) =>
	new Intl.NumberFormat().format(value ?? 0);

// ─── Recharts Sankey diagram (desktop) ───────────────────────────────────────

type FlowNode = { id: string; stage: string; label: string; count: number };
type FlowLink = { source: string; target: string; count: number };
type ScanResultSummary = RouterOutputs["scan"]["resultSummary"];
type NodeColors = { fill: string; stroke: string; linkFill: string };

const NODE_W = 140;
const SVG_H = 340;
const MARGIN_X = 16;
const MARGIN_Y = 6;
const NODE_MIN_H = 36;
const COL_GAP = 10;

function layoutColumn(
	colNodes: FlowNode[],
	colX: number,
): Array<{ node: FlowNode; x: number; y: number; h: number }> {
	if (colNodes.length === 0) return [];
	const availH = SVG_H - MARGIN_Y * 2;
	const totalGap = COL_GAP * (colNodes.length - 1);
	const totalMinH = NODE_MIN_H * colNodes.length;
	const extraH = Math.max(0, availH - totalMinH - totalGap);
	const totalCount = colNodes.reduce((s, n) => s + (n.count || 0), 0);
	let y = MARGIN_Y;
	return colNodes.map((node) => {
		const proportion =
			totalCount > 0 ? (node.count || 0) / totalCount : 1 / colNodes.length;
		const h = NODE_MIN_H + extraH * proportion;
		const result = { node, x: colX, y, h };
		y += h + COL_GAP;
		return result;
	});
}

const SankeyFlowDiagram = ({
	nodes,
	links,
	nodeColors,
	defaultNodeColors,
	formatLabel,
	formatCount,
	labelAnalysis,
	labelVerify,
	labelTriage,
}: {
	nodes: FlowNode[];
	links: FlowLink[];
	nodeColors: Record<string, NodeColors>;
	defaultNodeColors: NodeColors;
	formatLabel: (node: FlowNode) => string;
	formatCount: (n?: number | null) => string;
	labelAnalysis: string;
	labelVerify: string;
	labelTriage: string;
}) => {
	const containerRef = useRef<HTMLDivElement>(null);
	const [svgWidth, setSvgWidth] = useState(600);
	const [tooltip, setTooltip] = useState<{
		node: FlowNode;
		x: number;
		y: number;
	} | null>(null);

	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const obs = new ResizeObserver(([entry]) => {
			if (!entry) return;
			setSvgWidth(entry.contentRect.width);
		});
		obs.observe(el);
		setSvgWidth(el.getBoundingClientRect().width);
		return () => obs.disconnect();
	}, []);

	// Fixed column x positions
	const col0x = MARGIN_X;
	const col1x = (svgWidth - NODE_W) / 2;
	const col2x = svgWidth - MARGIN_X - NODE_W;

	// Split nodes by stage (preserve input order)
	const analysisNodes = nodes.filter((n) => n.stage === "analysis");
	const verifyNodes = nodes.filter((n) => n.stage === "verify");
	const triageNodes = nodes.filter((n) => n.stage === "triage");

	const col0Layout = layoutColumn(analysisNodes, col0x);
	const col1Layout = layoutColumn(verifyNodes, col1x);
	const col2Layout = layoutColumn(triageNodes, col2x);

	const layoutById = new Map(
		[...col0Layout, ...col1Layout, ...col2Layout].map((item) => [
			item.node.id,
			item,
		]),
	);

	// Build bezier link ribbons
	const srcOffsets = new Map<string, number>();
	const tgtOffsets = new Map<string, number>();

	const activeLinks = links.filter(
		(l) => l.count > 0 && layoutById.has(l.source) && layoutById.has(l.target),
	);

	const renderedLinks = activeLinks
		.map((link) => {
			const src = layoutById.get(link.source);
			const tgt = layoutById.get(link.target);
			if (!src || !tgt) {
				return null;
			}
			const srcH =
				src.node.count > 0 ? (src.h * link.count) / src.node.count : 0;
			const tgtH =
				tgt.node.count > 0 ? (tgt.h * link.count) / tgt.node.count : 0;
			const srcOff = srcOffsets.get(link.source) ?? 0;
			const tgtOff = tgtOffsets.get(link.target) ?? 0;
			srcOffsets.set(link.source, srcOff + srcH);
			tgtOffsets.set(link.target, tgtOff + tgtH);
			const x0 = src.x + NODE_W;
			const y0t = src.y + srcOff;
			const y0b = y0t + srcH;
			const x1 = tgt.x;
			const y1t = tgt.y + tgtOff;
			const y1b = y1t + tgtH;
			const cx = (x0 + x1) / 2;
			const d = [
				`M ${x0} ${y0t}`,
				`C ${cx} ${y0t}, ${cx} ${y1t}, ${x1} ${y1t}`,
				`L ${x1} ${y1b}`,
				`C ${cx} ${y1b}, ${cx} ${y0b}, ${x0} ${y0b}`,
				"Z",
			].join(" ");
			const colors = nodeColors[link.target] ?? defaultNodeColors;
			return { key: `${link.source}-${link.target}`, d, colors };
		})
		.filter((link): link is NonNullable<typeof link> => Boolean(link));

	const renderNodes = (colLayout: ReturnType<typeof layoutColumn>) =>
		colLayout.map(({ node, x, y, h }) => {
			const colors = nodeColors[node.id] ?? defaultNodeColors;
			const label = formatLabel(node);
			const labelY = h >= 44 ? y + 18 : y + h / 2 + 5;
			const countY = y + Math.min(h - 8, 40);
			return (
				<g
					key={node.id}
					style={{ cursor: "default" }}
					onMouseEnter={(e) => {
						const rect = containerRef.current?.getBoundingClientRect();
						if (rect) {
							setTooltip({
								node,
								x: e.clientX - rect.left,
								y: e.clientY - rect.top,
							});
						}
					}}
					onMouseLeave={() => setTooltip(null)}
				>
					<rect
						x={x}
						y={y}
						width={NODE_W}
						height={h}
						rx={5}
						fill={colors.fill}
						stroke={colors.stroke}
						strokeWidth={1.5}
					/>
					{h >= 22 && (
						<text
							x={x + 10}
							y={labelY}
							fontSize={12}
							fontWeight={500}
							fill="currentColor"
							style={{ fontFamily: "inherit" }}
						>
							{label}
						</text>
					)}
					{h >= 44 && (
						<text
							x={x + 10}
							y={countY}
							fontSize={13}
							fontWeight={600}
							fill="currentColor"
							opacity={0.65}
							style={{ fontFamily: "inherit" }}
						>
							{formatCount(node.count)}
						</text>
					)}
				</g>
			);
		});

	return (
		<div className="hidden w-full md:block" ref={containerRef}>
			{/* Column headers */}
			<div className="relative mb-1 h-6">
				<span
					className="absolute text-sm font-semibold uppercase tracking-wide text-muted-foreground"
					style={{ left: col0x }}
				>
					{labelAnalysis}
				</span>
				<span
					className="absolute text-sm font-semibold uppercase tracking-wide text-muted-foreground"
					style={{
						left: col1x,
						width: NODE_W,
						textAlign: "center",
					}}
				>
					{labelVerify}
				</span>
				<span
					className="absolute text-sm font-semibold uppercase tracking-wide text-muted-foreground"
					style={{
						left: col2x,
						width: NODE_W,
						textAlign: "right",
					}}
				>
					{labelTriage}
				</span>
			</div>
			<div className="relative">
				<svg width={svgWidth} height={SVG_H} style={{ overflow: "visible" }}>
					{/* Links (drawn behind nodes) */}
					{renderedLinks.map(({ key, d, colors }) => (
						<path
							key={key}
							d={d}
							fill={colors.linkFill}
							fillOpacity={0.22}
							stroke="none"
						/>
					))}
					{/* Nodes */}
					{renderNodes(col0Layout)}
					{renderNodes(col1Layout)}
					{renderNodes(col2Layout)}
				</svg>
				{/* Hover tooltip */}
				{tooltip && (
					<div
						className="pointer-events-none absolute z-50 rounded-md border bg-popover px-3 py-2 text-sm shadow-md"
						style={{ left: tooltip.x + 14, top: tooltip.y - 24 }}
					>
						<div className="font-medium">{formatLabel(tooltip.node)}</div>
						<div className="text-muted-foreground">
							{formatCount(tooltip.node.count)}
						</div>
					</div>
				)}
			</div>
		</div>
	);
};

// fill / stroke colours per node id (CSS colour strings for SVG, not Tailwind classes)
const FLOW_NODE_COLORS: Record<
	string,
	{ fill: string; stroke: string; linkFill: string }
> = {
	analysis_real_vulnerability: {
		fill: "hsl(0 86% 97%)",
		stroke: "hsl(0 72% 70%)",
		linkFill: "hsl(0 72% 55%)",
	},
	analysis_likely_vulnerability: {
		fill: "hsl(30 90% 96%)",
		stroke: "hsl(25 80% 65%)",
		linkFill: "hsl(25 80% 50%)",
	},
	analysis_plausible_but_unproven: {
		fill: "hsl(48 95% 96%)",
		stroke: "hsl(45 80% 60%)",
		linkFill: "hsl(45 80% 45%)",
	},
	analysis_false_positive: {
		fill: "hsl(220 13% 96%)",
		stroke: "hsl(220 9% 70%)",
		linkFill: "hsl(220 9% 55%)",
	},
	verify_true: {
		fill: "hsl(150 60% 96%)",
		stroke: "hsl(150 50% 60%)",
		linkFill: "hsl(150 50% 45%)",
	},
	verify_likely: {
		fill: "hsl(43 96% 96%)",
		stroke: "hsl(43 80% 60%)",
		linkFill: "hsl(43 80% 45%)",
	},
	verify_false: {
		fill: "hsl(220 13% 96%)",
		stroke: "hsl(220 9% 70%)",
		linkFill: "hsl(220 9% 55%)",
	},
	triage_security_issue: {
		fill: "hsl(0 86% 97%)",
		stroke: "hsl(0 72% 70%)",
		linkFill: "hsl(0 72% 55%)",
	},
	triage_non_security: {
		fill: "hsl(220 13% 96%)",
		stroke: "hsl(220 9% 70%)",
		linkFill: "hsl(220 9% 55%)",
	},
	triage_hardening: {
		fill: "hsl(210 90% 96%)",
		stroke: "hsl(210 70% 65%)",
		linkFill: "hsl(210 70% 50%)",
	},
	triage_needs_review: {
		fill: "hsl(48 95% 96%)",
		stroke: "hsl(45 80% 60%)",
		linkFill: "hsl(45 80% 45%)",
	},
};
const DEFAULT_NODE_COLORS = {
	fill: "hsl(220 13% 96%)",
	stroke: "hsl(220 9% 70%)",
	linkFill: "hsl(220 9% 55%)",
};

const getResultFlowCardClassName = (id: string) => {
	if (id.startsWith("analysis_real_vulnerability"))
		return "border-red-200 bg-red-50 dark:border-red-500/60 dark:bg-red-950/30";
	if (id.startsWith("analysis_likely_vulnerability"))
		return "border-orange-200 bg-orange-50 dark:border-orange-500/60 dark:bg-orange-950/30";
	if (id.startsWith("analysis_plausible"))
		return "border-yellow-200 bg-yellow-50 dark:border-yellow-500/60 dark:bg-yellow-950/30";
	if (id.startsWith("analysis_false_positive"))
		return "border-slate-200 bg-slate-50 dark:border-slate-500/60 dark:bg-slate-950/30";
	if (id.startsWith("verify_true") || id.startsWith("verify_likely"))
		return "border-emerald-200 bg-emerald-50 dark:border-emerald-500/60 dark:bg-emerald-950/30";
	if (id.startsWith("verify_false"))
		return "border-slate-200 bg-slate-50 dark:border-slate-500/60 dark:bg-slate-950/30";
	if (id.startsWith("triage_security_issue"))
		return "border-red-200 bg-red-50 dark:border-red-500/60 dark:bg-red-950/30";
	if (id.startsWith("triage_non_security"))
		return "border-slate-200 bg-slate-50 dark:border-slate-500/60 dark:bg-slate-950/30";
	if (id.startsWith("triage_hardening"))
		return "border-blue-200 bg-blue-50 dark:border-blue-500/60 dark:bg-blue-950/30";
	if (id.startsWith("triage_needs_review"))
		return "border-yellow-200 bg-yellow-50 dark:border-yellow-500/60 dark:bg-yellow-950/30";
	return "border-muted bg-muted/30";
};

const formatFlowNodeLabel = (
	t: ScanTranslation,
	node: { id: string; stage: string; label: string },
) => {
	if (node.stage === "analysis") {
		return formatAnalysisResultLabel(t, node.id.replace("analysis_", ""));
	}
	if (node.stage === "verify") {
		return formatTruthResultLabel(t, node.id.replace("verify_", ""));
	}
	if (node.stage === "triage") {
		return formatTriageResultLabel(t, node.id.replace("triage_", ""));
	}
	return node.label;
};

const getResultFlowNodeLabel = (
	t: ScanTranslation,
	id: string,
	fallback: string,
) => {
	switch (id) {
		case "analysis_real":
			return scanT(t, "scan.results.flow.node.analysisReal", "Analysis Real");
		case "analysis_likely":
			return scanT(
				t,
				"scan.results.flow.node.analysisLikely",
				"Analysis Likely",
			);
		case "verify_true":
			return scanT(t, "scan.results.flow.node.verifyTrue", "Verify True");
		case "verify_likely":
			return scanT(t, "scan.results.flow.node.verifyLikely", "Verify Likely");
		case "verify_false":
			return scanT(t, "scan.results.flow.node.verifyFalse", "Verify False");
		case "verify_missing":
			return scanT(t, "scan.results.flow.node.verifyMissing", "Wait Verifying");
		case "triage_security_issue":
			return scanT(t, "scan.results.flow.node.triageTrue", "Triage True");
		case "triage_not_security":
			return scanT(t, "scan.results.flow.node.triageFalse", "Triage False");
		case "triage_missing":
			return scanT(t, "scan.results.flow.node.triageMissing", "Wait Triage");
		default:
			return fallback;
	}
};

export const ResultFlowChart = ({
	summary,
	t,
}: {
	summary?: ScanResultSummary | null;
	t: ScanTranslation;
}) => {
	const nodes = summary?.flow.nodes ?? [];
	const links = summary?.flow.links ?? [];
	const nodeById = new Map(nodes.map((node) => [node.id, node]));

	if (!summary || nodes.length === 0) {
		return (
			<div className="flex h-44 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
				{scanT(t, "scan.results.flowEmpty", "No candidates to visualize.")}
			</div>
		);
	}

	return (
		<>
			<div className="grid gap-3 md:hidden">
				<div className="text-xs font-medium uppercase text-muted-foreground">
					{scanT(t, "scan.results.flowAnalysis", "Analysis")}
				</div>
				{nodes
					.filter((node) => node.stage === "analysis")
					.map((node) => (
						<div
							key={node.id}
							className={`rounded-lg border p-3 ${getResultFlowCardClassName(
								node.id,
							)}`}
						>
							<div className="text-sm font-medium">
								{formatFlowNodeLabel(t, node)}
							</div>
							<div className="mt-1 text-2xl font-semibold tabular-nums">
								{formatSummaryCount(node.count)}
							</div>
						</div>
					))}
				<div className="grid gap-2">
					<div className="text-xs font-medium uppercase text-muted-foreground">
						{scanT(t, "scan.results.flowVerify", "Verify")}
					</div>
					{links
						.filter((link) => link.source.startsWith("analysis_"))
						.map((link) => {
							const target = nodeById.get(link.target);
							const source = nodeById.get(link.source);
							return (
								<div
									key={`${link.source}-${link.target}`}
									className={`rounded-lg border p-3 ${getResultFlowCardClassName(
										link.target,
									)}`}
								>
									<div className="min-w-0 text-sm font-medium">
										{target ? formatFlowNodeLabel(t, target) : link.target}
									</div>
									<div className="mt-1 text-xs text-muted-foreground">
										{scanT(t, "scan.results.flow.from", "from")}{" "}
										{getResultFlowNodeLabel(
											t,
											link.source,
											source?.label ?? link.source,
										)}
									</div>
								</div>
							);
						})}
				</div>
				<div className="grid gap-2">
					<div className="text-xs font-medium uppercase text-muted-foreground">
						{scanT(t, "scan.results.flowTriage", "Triage")}
					</div>
					{links
						.filter((link) => link.source.startsWith("verify_"))
						.map((link) => {
							const source = nodeById.get(link.source);
							const target = nodeById.get(link.target);
							return (
								<div
									key={`${link.source}-${link.target}`}
									className={`rounded-lg border p-3 ${getResultFlowCardClassName(
										link.target,
									)}`}
								>
									<div className="flex items-center justify-between gap-3">
										<div className="min-w-0 text-sm font-medium">
											{target ? formatFlowNodeLabel(t, target) : link.target}
										</div>
										<div className="shrink-0 text-lg font-semibold tabular-nums">
											{formatSummaryCount(link.count)}
										</div>
									</div>
									<div className="mt-1 text-xs text-muted-foreground">
										from {source ? formatFlowNodeLabel(t, source) : link.source}
									</div>
								</div>
							);
						})}
				</div>
			</div>
			<SankeyFlowDiagram
				nodes={nodes}
				links={links}
				nodeColors={FLOW_NODE_COLORS}
				defaultNodeColors={DEFAULT_NODE_COLORS}
				formatLabel={(node) => formatFlowNodeLabel(t, node)}
				formatCount={formatSummaryCount}
				labelAnalysis={scanT(t, "scan.results.flowAnalysis", "Analysis")}
				labelVerify={scanT(t, "scan.results.flowVerify", "Verify")}
				labelTriage={scanT(t, "scan.results.flowTriage", "Triage")}
			/>
		</>
	);
};

export const RunningCapacityBars = ({
	running,
	limit,
}: {
	running: number;
	limit: number;
}) => {
	const blockCount = Math.max(1, limit, running);
	return (
		<div className="flex items-center justify-end gap-2">
			<div className="flex min-h-3 items-center gap-1">
				{Array.from({ length: blockCount }, (_, index) => (
					<span
						key={index}
						className={`h-3 w-1 rounded-[1px] shadow-[0_0_0_1px_hsl(var(--background))] ${
							index < running ? "bg-sky-500" : "bg-muted-foreground/20"
						}`}
					/>
				))}
			</div>
			<span className="min-w-12 text-right tabular-nums">
				{running} / {Math.max(1, limit)}
			</span>
		</div>
	);
};
