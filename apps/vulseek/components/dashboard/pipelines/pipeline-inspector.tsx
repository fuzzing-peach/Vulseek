import { Trash2 } from "lucide-react";
import * as React from "react";
import type {
	PipelineDocumentV3,
	PipelineEdgeV3,
	PipelineStageV3,
} from "@vulseek/server/services/scan/pipeline/document-v3";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/**
 * Right-hand inspector for the selected entity. Stage edits cover the core
 * V3 attributes; advanced fields (artifacts, effects, plugins, promptValues)
 * are edited in YAML mode for now and surfaced read-only here.
 */

export type PipelineInspectorProps = {
	document: PipelineDocumentV3;
	selection: { type: "stage" | "edge" | "schema" | "group"; id: string } | null;
	onChange: (document: PipelineDocumentV3) => void;
};

const roleOptions: Array<PipelineStageV3["role"]> = [
	"scan",
	"analysis",
	"verification",
];
const modeOptions: Array<PipelineStageV3["mode"]> = ["serial", "fanout"];

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
	<div className="space-y-2">
		<h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
			{title}
		</h4>
		{children}
	</div>
);

const Field = ({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) => (
	<div className="space-y-1">
		<Label className="text-xs">{label}</Label>
		{children}
	</div>
);

const StageInspector = ({
	stage,
	stageId,
	document,
	onChange,
}: {
	stage: PipelineStageV3;
	stageId: string;
	document: PipelineDocumentV3;
	onChange: (document: PipelineDocumentV3) => void;
}) => {
	const update = (patch: Partial<PipelineStageV3>) =>
		onChange({
			...document,
			stages: { ...document.stages, [stageId]: { ...stage, ...patch } },
		});

	return (
		<div className="space-y-5">
			<Section title="Stage">
				<Field label="Name">
					<Input
						value={stage.name}
						onChange={(event) => update({ name: event.target.value })}
					/>
				</Field>
				<Field label="Role">
					<select
						value={stage.role}
						onChange={(event) =>
							update({ role: event.target.value as PipelineStageV3["role"] })
						}
						className="h-9 w-full rounded-md border bg-background px-2 text-sm"
					>
						{roleOptions.map((role) => (
							<option key={role} value={role}>
								{role}
							</option>
						))}
					</select>
				</Field>
				<Field label="Group">
					<Input
						value={stage.group}
						onChange={(event) => update({ group: event.target.value })}
					/>
				</Field>
				<Field label="Mode">
					<select
						value={stage.mode}
						onChange={(event) =>
							update({ mode: event.target.value as PipelineStageV3["mode"] })
						}
						className="h-9 w-full rounded-md border bg-background px-2 text-sm"
					>
						{modeOptions.map((mode) => (
							<option key={mode} value={mode}>
								{mode}
							</option>
						))}
					</select>
				</Field>
				<Field label="Concurrency">
					<Input
						type="number"
						min={1}
						value={stage.concurrency}
						onChange={(event) =>
							update({ concurrency: Math.max(1, Number(event.target.value) || 1) })
						}
					/>
				</Field>
				<div className="flex items-center justify-between">
					<Label className="text-xs">Disableable</Label>
					<input
						type="checkbox"
						checked={stage.disableable}
						onChange={(event) => update({ disableable: event.target.checked })}
					/>
				</div>
			</Section>

			<Section title="Runtime">
				<Field label="Prompt">
					<Textarea
						rows={10}
						value={stage.runtime.prompt}
						onChange={(event) =>
							update({
								runtime: { ...stage.runtime, prompt: event.target.value },
							})
						}
						className="font-mono text-xs"
					/>
				</Field>
				<Field label="cwd">
					<Input
						value={stage.runtime.cwd ?? ""}
						placeholder="/workspace/repo"
						onChange={(event) =>
							update({
								runtime: {
									...stage.runtime,
									cwd: event.target.value || undefined,
								},
							})
						}
					/>
				</Field>
				<div className="flex items-center justify-between">
					<Label className="text-xs">Persistent container</Label>
					<input
						type="checkbox"
						checked={stage.runtime.persistent ?? true}
						onChange={(event) =>
							update({
								runtime: {
									...stage.runtime,
									persistent: event.target.checked,
								},
							})
						}
					/>
				</div>
			</Section>

			<Section title="Advanced (YAML mode)">
				<p className="text-xs text-muted-foreground">
					Artifacts, effects, plugins, schemas, promptValues and task naming
					are edited in YAML mode; this inspector keeps them read-only to
					avoid accidental data loss.
				</p>
				{stage.runtime.plugins.length > 0 && (
					<p className="text-xs">
						Plugins: <span className="font-mono">{stage.runtime.plugins.join(", ")}</span>
					</p>
				)}
				{stage.effects.length > 0 && (
					<p className="text-xs">
						Effects:{" "}
						<span className="font-mono">
							{stage.effects.map((effect) => effect.type).join(", ")}
						</span>
					</p>
				)}
			</Section>
		</div>
	);
};

const EdgeInspector = ({
	edge,
	document,
	onChange,
}: {
	edge: PipelineEdgeV3;
	document: PipelineDocumentV3;
	onChange: (document: PipelineDocumentV3) => void;
}) => {
	const update = (patch: Partial<PipelineEdgeV3>) =>
		onChange({
			...document,
			edges: document.edges.map((item) =>
				item.id === edge.id ? { ...item, ...patch } : item,
			),
		});

	return (
		<div className="space-y-5">
			<Section title="Edge">
				<Field label="Name">
					<Input
						value={edge.name}
						onChange={(event) => update({ name: event.target.value })}
					/>
				</Field>
				<Field label="From">
					<Input value={edge.from} readOnly />
				</Field>
				<Field label="To">
					<Input value={edge.to} readOnly />
				</Field>
				<Field label="Mode">
					<select
						value={edge.mode}
						onChange={(event) =>
							update({ mode: event.target.value as "map" | "fanOut" })
						}
						className="h-9 w-full rounded-md border bg-background px-2 text-sm"
					>
						<option value="map">map</option>
						<option value="fanOut">fanOut</option>
					</select>
				</Field>
				{edge.mode === "fanOut" && (
					<Field label="foreach">
						<Input
							value={edge.foreach ?? ""}
							placeholder="$.items[*]"
							onChange={(event) =>
								update({ foreach: event.target.value || undefined })
							}
						/>
					</Field>
				)}
				{edge.route && (
					<Field label="Route key">
						<Input
							value={edge.route.key}
							onChange={(event) =>
								update({ route: { ...edge.route, key: event.target.value } })
							}
						/>
					</Field>
				)}
			</Section>
		</div>
	);
};

export const PipelineInspector = ({
	document,
	selection,
	onChange,
}: PipelineInspectorProps) => {
	if (!selection) {
		return (
			<div className="flex h-full items-center justify-center p-4 text-center text-sm text-muted-foreground">
				Select a stage, edge, schema or group to edit its properties.
			</div>
		);
	}

	if (selection.type === "stage") {
		const stage = document.stages[selection.id];
		if (!stage) {
			return (
				<div className="p-4 text-sm text-muted-foreground">
					Stage "{selection.id}" no longer exists.
				</div>
			);
		}
		return (
			<div className="flex h-full flex-col">
				<div className="flex items-center justify-between border-b px-4 py-3">
					<h3 className="text-sm font-semibold">{stage.name}</h3>
					<Button
						variant="ghost"
						size="icon"
						className="size-7 text-muted-foreground hover:text-red-600"
						onClick={() => {
							const next: PipelineDocumentV3 = {
								...document,
								stages: Object.fromEntries(
									Object.entries(document.stages).filter(
										([id]) => id !== selection.id,
									),
								),
								edges: document.edges.filter(
									(edge) =>
										edge.from !== selection.id && edge.to !== selection.id,
								),
								root:
									document.root === selection.id
										? (Object.keys(document.stages).find(
												(id) => id !== selection.id,
											) ?? document.root)
										: document.root,
							};
							onChange(next);
						}}
						aria-label="Delete stage"
					>
						<Trash2 className="size-4" />
					</Button>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto p-4">
					<StageInspector
						stage={stage}
						stageId={selection.id}
						document={document}
						onChange={onChange}
					/>
				</div>
				<div className="border-t p-3">
					<Button
						variant="outline"
						size="sm"
						className={cn(
							"w-full",
							document.root === selection.id && "opacity-50",
						)}
						disabled={document.root === selection.id}
						onClick={() =>
							onChange({ ...document, root: selection.id })
						}
					>
						{document.root === selection.id
							? "Root stage"
							: "Set as root stage"}
					</Button>
				</div>
			</div>
		);
	}

	if (selection.type === "edge") {
		const edge = document.edges.find((item) => item.id === selection.id);
		if (!edge) {
			return (
				<div className="p-4 text-sm text-muted-foreground">
					Edge "{selection.id}" no longer exists.
				</div>
			);
		}
		return (
			<div className="flex h-full flex-col">
				<div className="flex items-center justify-between border-b px-4 py-3">
					<h3 className="text-sm font-semibold">{edge.name}</h3>
					<Button
						variant="ghost"
						size="icon"
						className="size-7 text-muted-foreground hover:text-red-600"
						onClick={() =>
							onChange({
								...document,
								edges: document.edges.filter(
									(item) => item.id !== selection.id,
								),
							})
						}
						aria-label="Delete edge"
					>
						<Trash2 className="size-4" />
					</Button>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto p-4">
					<EdgeInspector
						edge={edge}
						document={document}
						onChange={onChange}
					/>
				</div>
			</div>
		);
	}

	return (
		<div className="p-4 text-sm text-muted-foreground">
			Schema and group editing is available in YAML mode.
		</div>
	);
};
