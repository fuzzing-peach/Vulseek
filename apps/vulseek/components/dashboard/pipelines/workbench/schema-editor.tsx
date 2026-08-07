import * as React from "react";
import type {
	PipelineDiagnostic,
	PipelineDocumentV3,
} from "@vulseek/server/services/scan/pipeline/document-v3";
import {
	collectSchemaRefs,
	deleteBlockers,
	schemaReferrers,
} from "@/lib/pipeline-editor/definition-helpers";
import type { PipelineEditorAction } from "@/lib/pipeline-editor/pipeline-editor-state";
import { cn } from "@/lib/utils";
import {
	EntityDiagnostics,
	JsonField,
	SectionHeading,
	SelectField,
	TextField,
	TextAreaField,
} from "./workbench-fields";

/**
 * Schema editor: a bounded Form mode for common JSON Schema properties and
 * an unrestricted JSON Schema mode. "Used by" lists referencing stages and
 * edges; "References" lists schemas this schema points at. Selecting either
 * navigates directly to the entity. Arbitrary recursive JSON Schema stays in
 * JSON mode — a generated form would mislead.
 */

const SCHEMA_TYPES = [
	{ value: "object", label: "object" },
	{ value: "array", label: "array" },
	{ value: "string", label: "string" },
	{ value: "number", label: "number" },
	{ value: "integer", label: "integer" },
	{ value: "boolean", label: "boolean" },
	{ value: "null", label: "null" },
] as const;

type PropertyDraft = {
	name: string;
	type: string;
	description: string;
	enumValues: unknown[];
};

const schemaToFormState = (
	schema: Record<string, unknown>,
): { type: string; title: string; description: string; properties: PropertyDraft[]; required: string[]; itemsType: string } => {
	const properties = (schema.properties as Record<string, unknown>) ?? {};
	return {
		type: typeof schema.type === "string" ? schema.type : "object",
		title: typeof schema.title === "string" ? schema.title : "",
		description: typeof schema.description === "string" ? schema.description : "",
		properties: Object.entries(properties).map(([name, value]) => {
			const property = (value ?? {}) as Record<string, unknown>;
			return {
				name,
				type: typeof property.type === "string" ? property.type : "string",
				description: typeof property.description === "string" ? property.description : "",
				enumValues: Array.isArray(property.enum) ? property.enum : [],
			};
		}),
		required: Array.isArray(schema.required) ? (schema.required as string[]) : [],
		itemsType:
			typeof (schema.items as Record<string, unknown> | undefined)?.type === "string"
				? ((schema.items as Record<string, unknown>).type as string)
				: "string",
	};
};

const formStateToSchema = (
	form: ReturnType<typeof schemaToFormState>,
	base: Record<string, unknown>,
): Record<string, unknown> => {
	const properties: Record<string, unknown> = {};
	for (const property of form.properties) {
		if (!property.name.trim()) continue;
		const entry: Record<string, unknown> = { type: property.type };
		if (property.description) entry.description = property.description;
		if (property.enumValues.length > 0) entry.enum = property.enumValues;
		properties[property.name] = entry;
	}
	const next: Record<string, unknown> = {
		...base,
		type: form.type,
	};
	if (form.title) next.title = form.title;
	else delete next.title;
	if (form.description) next.description = form.description;
	else delete next.description;
	if (form.type === "object") {
		next.properties = properties;
		next.required = form.required.filter((name) => name in properties);
		delete next.items;
	} else if (form.type === "array") {
		next.items = { type: form.itemsType };
		delete next.properties;
		delete next.required;
	} else {
		delete next.properties;
		delete next.required;
		delete next.items;
	}
	return next;
};

export type SchemaEditorProps = {
	schemaId: string;
	schema: Record<string, unknown>;
	document: PipelineDocumentV3;
	diagnostics: PipelineDiagnostic[];
	dispatch: React.Dispatch<PipelineEditorAction>;
	readOnly: boolean;
	onSelect: (entity: { type: "stage" | "edge" | "schema" | "group"; id: string }) => void;
};

export const SchemaEditor = ({
	schemaId,
	schema,
	document,
	diagnostics,
	dispatch,
	readOnly,
	onSelect,
}: SchemaEditorProps) => {
	const [mode, setMode] = React.useState<"form" | "json">("form");
	const [form, setForm] = React.useState(() => schemaToFormState(schema));
	React.useEffect(() => setForm(schemaToFormState(schema)), [schema]);

	const setSchema = (next: Record<string, unknown>, key: string) =>
		dispatch({ type: "patch", ops: [{ op: "setSchema", schemaId, schema: next }], key });

	const usedBy = schemaReferrers(document, schemaId);
	const references = React.useMemo(() => {
		const refs = new Set<string>();
		collectSchemaRefs(schema, refs);
		return [...refs].filter((id) => id !== schemaId);
	}, [schema]);
	const blockers = deleteBlockers(document, "schema", schemaId);
	const advanced = Object.keys(schema).some(
		(key) => !["type", "title", "description", "properties", "required", "items", "enum"].includes(key),
	);

	return (
		<div className="flex h-full min-h-0 flex-col">
			<SectionHeading
				title={schemaId}
				subtitle={`JSON Schema · used by ${usedBy.length} · references ${references.length}`}
				actions={
					<div className="flex items-center gap-1 rounded-md border p-0.5 text-xs">
						{(["form", "json"] as const).map((item) => (
							<button
								key={item}
								type="button"
								onClick={() => setMode(item)}
								className={cn(
									"rounded px-2 py-0.5",
									mode === item ? "bg-primary text-primary-foreground" : "text-muted-foreground",
								)}
							>
								{item === "form" ? "Form" : "JSON Schema"}
							</button>
						))}
					</div>
				}
			/>
			<EntityDiagnostics diagnostics={diagnostics} />
			<div className="min-h-0 flex-1 overflow-y-auto p-4">
				{mode === "json" ? (
					<JsonField
						label="JSON Schema"
						value={schema}
						readOnly={readOnly}
						rows={18}
						onChange={(next) => setSchema((next as Record<string, unknown>) ?? {}, `schema:${schemaId}:json`)}
					/>
				) : (
					<div className="space-y-4">
						{advanced ? (
							<p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600">
								This schema has advanced properties edited in JSON mode; the form preserves them.
							</p>
						) : null}
						<SelectField
							label="Type"
							value={form.type}
							options={SCHEMA_TYPES}
							readOnly={readOnly}
							onChange={(type) => {
								const next = { ...form, type };
								setForm(next);
								setSchema(formStateToSchema(next, schema), `schema:${schemaId}:type`);
							}}
						/>
						<TextField
							label="Title"
							value={form.title}
							readOnly={readOnly}
							onChange={(title) => {
								const next = { ...form, title };
								setForm(next);
								setSchema(formStateToSchema(next, schema), `schema:${schemaId}:title`);
							}}
						/>
						<TextAreaField
							label="Description"
							value={form.description}
							rows={2}
							readOnly={readOnly}
							onChange={(description) => {
								const next = { ...form, description };
								setForm(next);
								setSchema(formStateToSchema(next, schema), `schema:${schemaId}:description`);
							}}
						/>
						{form.type === "object" ? (
							<>
								<div className="space-y-2">
									<p className="text-xs font-medium text-foreground">Properties</p>
									{form.properties.map((property, index) => (
										<div key={property.name || index} className="space-y-1 rounded-md border p-2">
											<input
												value={property.name}
												disabled={readOnly}
												placeholder="property name"
												onChange={(event) => {
													const properties = form.properties.map((p, i) =>
														i === index ? { ...p, name: event.target.value } : p,
													);
													const next = { ...form, properties };
													setForm(next);
													setSchema(formStateToSchema(next, schema), `schema:${schemaId}:props`);
												}}
												className="h-8 w-full rounded-md border bg-background px-2 text-xs"
											/>
											<div className="grid grid-cols-2 gap-2">
												<select
													value={property.type}
													disabled={readOnly}
													onChange={(event) => {
														const properties = form.properties.map((p, i) =>
															i === index ? { ...p, type: event.target.value } : p,
														);
														const next = { ...form, properties };
														setForm(next);
														setSchema(formStateToSchema(next, schema), `schema:${schemaId}:props`);
													}}
													className="h-8 rounded-md border bg-background px-2 text-xs"
												>
													{SCHEMA_TYPES.map((option) => (
														<option key={option.value} value={option.value}>
															{option.label}
														</option>
													))}
												</select>
												<button
													type="button"
													disabled={readOnly}
													onClick={() => {
														const properties = form.properties.filter((_, i) => i !== index);
														const required = form.required.filter((name) => name !== property.name);
														const next = { ...form, properties, required };
														setForm(next);
														setSchema(formStateToSchema(next, schema), `schema:${schemaId}:props`);
													}}
													className="h-8 rounded-md border border-red-500/30 text-xs text-red-600 hover:bg-red-500/10 disabled:opacity-40"
												>
													Remove
												</button>
											</div>
										</div>
									))}
									{!readOnly ? (
										<button
											type="button"
											onClick={() => {
												const next = {
													...form,
													properties: [...form.properties, { name: "newProperty", type: "string", description: "", enumValues: [] }],
												};
												setForm(next);
												setSchema(formStateToSchema(next, schema), `schema:${schemaId}:props`);
											}}
											className="rounded-md border border-dashed px-3 py-1.5 text-xs text-muted-foreground hover:border-foreground/40 hover:text-foreground"
										>
											Add property
										</button>
									) : null}
								</div>
								<div className="space-y-1">
									<p className="text-xs font-medium text-foreground">Required</p>
									<div className="flex flex-wrap gap-1.5">
										{form.properties.map((property) => {
											const checked = form.required.includes(property.name);
											return (
												<label
													key={property.name || property.type}
													className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs"
												>
													<input
														type="checkbox"
														checked={checked}
														disabled={readOnly || !property.name}
														onChange={(event) => {
															const required = event.target.checked
																? [...form.required, property.name]
																: form.required.filter((name) => name !== property.name);
															const next = { ...form, required };
															setForm(next);
															setSchema(formStateToSchema(next, schema), `schema:${schemaId}:required`);
														}}
													/>
													{property.name || "(unnamed)"}
												</label>
											);
										})}
									</div>
								</div>
							</>
						) : null}
						{form.type === "array" ? (
							<SelectField
								label="Items type"
								value={form.itemsType}
								options={SCHEMA_TYPES.filter((option) => option.value !== "array")}
								readOnly={readOnly}
								onChange={(itemsType) => {
									const next = { ...form, itemsType };
									setForm(next);
									setSchema(formStateToSchema(next, schema), `schema:${schemaId}:items`);
								}}
							/>
						) : null}
					</div>
				)}

				<div className="mt-6 grid grid-cols-2 gap-4">
					<div className="rounded-md border bg-muted/30 p-3">
						<p className="text-xs font-semibold text-foreground">Used by</p>
						{usedBy.length === 0 ? (
							<p className="mt-1 text-xs text-muted-foreground">No references — the schema is unused.</p>
						) : (
							<ul className="mt-1 space-y-1">
								{usedBy.map((reference) => (
									<li key={`${reference.kind}:${reference.id}`}>
										<button
											type="button"
											onClick={() => onSelect({ type: reference.kind as "stage" | "edge", id: reference.id })}
											className="text-xs text-sky-600 hover:underline"
										>
											{reference.kind}: {reference.id}
										</button>
									</li>
								))}
							</ul>
						)}
					</div>
					<div className="rounded-md border bg-muted/30 p-3">
						<p className="text-xs font-semibold text-foreground">References</p>
						{references.length === 0 ? (
							<p className="mt-1 text-xs text-muted-foreground">No nested $refs.</p>
						) : (
							<ul className="mt-1 space-y-1">
								{references.map((id) => (
									<li key={id}>
										<button
											type="button"
											onClick={() => onSelect({ type: "schema", id })}
											className="text-xs text-sky-600 hover:underline"
										>
											#/schemas/{id}
										</button>
									</li>
								))}
							</ul>
						)}
					</div>
				</div>

				{!readOnly ? (
					<div className="mt-6 space-y-2">
						{blockers.length > 0 ? (
							<div className="space-y-1 rounded-md border border-red-500/30 bg-red-500/5 p-3">
								<p className="text-xs font-semibold text-red-600">Cannot delete — referenced:</p>
								{blockers.map((blocker, index) => (
									<p key={index} className="text-xs text-red-600">
										{blocker.message}
									</p>
								))}
							</div>
						) : (
							<button
								type="button"
								onClick={() => {
									if (window.confirm(`Delete schema "${schemaId}"?`)) {
										dispatch({ type: "patch", ops: [{ op: "deleteSchema", schemaId }] });
									}
								}}
								className="rounded-md border border-red-500/30 px-3 py-1.5 text-xs text-red-600 hover:bg-red-500/10"
							>
								Delete schema
							</button>
						)}
					</div>
				) : null}
			</div>
		</div>
	);
};
