import * as React from "react";
import { LayoutGrid, RotateCcw, Route } from "lucide-react";
import type { PipelineDocumentV3 } from "@vulseek/server/services/scan/pipeline/document-v3";
import {
	CURRENT_PIPELINE_LAYOUT_VERSION,
	computePipelineLayout,
	type PipelineLayoutDirection,
	type PipelineLayoutResult,
} from "@/lib/pipeline-editor/pipeline-layout";
import type { PipelineEditorAction } from "@/lib/pipeline-editor/pipeline-editor-state";
import { SectionHeading, SelectField } from "./workbench-fields";

/**
 * Layout editor: direction, layout coverage, and explicit layout actions.
 * Node coordinates and bend points are normally manipulated in Visual; the
 * actions here recompute or reset them through typed patches.
 */

export type LayoutEditorProps = {
	document: PipelineDocumentV3;
	dispatch: React.Dispatch<PipelineEditorAction>;
	readOnly: boolean;
};

export const LayoutEditor = ({ document, dispatch, readOnly }: LayoutEditorProps) => {
	const [busy, setBusy] = React.useState(false);
	const [message, setMessage] = React.useState<string | null>(null);

	const direction = document.ui?.direction ?? "DOWN";
	const positioned = Object.keys(document.ui?.nodes ?? {}).filter(
		(id) => id in document.stages,
	).length;
	const total = Object.keys(document.stages).length;
	const version = document.ui?.layoutVersion;
	const legacy = typeof version !== "number" || version < CURRENT_PIPELINE_LAYOUT_VERSION;

	const persistLayout = (result: PipelineLayoutResult, nextDirection: PipelineLayoutDirection) => {
		const layout = {
			direction: nextDirection,
			nodes: result.nodes,
			edges: result.edges,
		};
		dispatch({ type: "patch", ops: [{ op: "updateLayout", layout }] });
	};

	const handleApply = async () => {
		if (readOnly || busy) return;
		setBusy(true);
		setMessage("Computing ELK layout…");
		try {
			const result = await computePipelineLayout(document, direction);
			persistLayout(result, direction);
			setMessage("Layout applied.");
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "Layout failed");
		} finally {
			setBusy(false);
		}
	};

	const handleReset = () => {
		if (readOnly) return;
		dispatch({ type: "patch", ops: [{ op: "resetLayout" }] });
		setMessage("Layout cleared — the editor will auto-layout on open.");
	};

	const handleClearRouting = () => {
		if (readOnly) return;
		dispatch({ type: "patch", ops: [{ op: "updateLayout", layout: { edges: {} } }] });
		setMessage("Edge routing cleared.");
	};

	return (
		<div className="flex h-full min-h-0 flex-col">
			<SectionHeading title="Layout" subtitle="Canvas geometry is presentation-only metadata" />
			<div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
				<SelectField
					label="Direction"
					value={direction}
					options={[
						{ value: "DOWN", label: "Top to bottom" },
						{ value: "RIGHT", label: "Left to right" },
					]}
					readOnly={readOnly}
					onChange={(next) => {
						const nextDirection = next as PipelineLayoutDirection;
						if (nextDirection === direction) return;
						dispatch({
							type: "patch",
							ops: [{ op: "updateLayout", layout: { direction: nextDirection } }],
						});
						setMessage("Direction changed — apply layout to re-run ELK.");
					}}
				/>

				<div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
					<p className="font-medium text-foreground">Coverage</p>
					<p className="mt-1">
						{positioned}/{total} stages have saved positions
						{legacy
							? " · saved layout is legacy and will be ignored on open"
							: ` · layoutVersion ${version}`}
					</p>
					<p className="mt-1">
						{document.ui?.direction ? `direction ${document.ui.direction}` : "no saved direction (defaults to DOWN)"}
					</p>
				</div>

				<div className="flex flex-col gap-2">
					<button
						type="button"
						onClick={() => void handleApply()}
						disabled={readOnly || busy}
						className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
					>
						<LayoutGrid className="size-3.5" />
						{busy ? "Applying…" : "Apply ELK layout"}
					</button>
					<button
						type="button"
						onClick={handleReset}
						disabled={readOnly}
						className="inline-flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-xs hover:bg-muted/60 disabled:opacity-50"
					>
						<RotateCcw className="size-3.5" />
						Reset layout
					</button>
					<button
						type="button"
						onClick={handleClearRouting}
						disabled={readOnly}
						className="inline-flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-xs hover:bg-muted/60 disabled:opacity-50"
					>
						<Route className="size-3.5" />
						Clear edge routing
					</button>
				</div>

				{message ? <p className="text-xs text-muted-foreground">{message}</p> : null}
			</div>
		</div>
	);
};
