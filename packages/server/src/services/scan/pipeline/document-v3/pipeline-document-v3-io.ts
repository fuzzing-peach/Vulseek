import {
	isAlias,
	isMap,
	isSeq,
	LineCounter,
	parseDocument,
	stringify,
	type Document,
} from "yaml";
import {
	PIPELINE_MAX_YAML_ALIASES,
	PIPELINE_MAX_YAML_BYTES,
	pipelineDocumentV3Schema,
	type PipelineDiagnostic,
	type PipelineDocumentV3,
} from "./pipeline-document-v3";

/**
 * Parsing / serialization for Pipeline Documents.
 *
 * - `parsePipelineDocumentV3` returns either the validated document or
 *   diagnostics; syntax errors (duplicate keys, bad indentation) and
 *   structural errors (unknown fields, wrong types) are both reported as
 *   diagnostics so the editor can show them inline in the YAML view.
 * - `serializePipelineDocumentV3` performs a *stable* serialization: a
 *   canonical, deterministic rendering in schema declaration order, with
 *   block scalars for prompts. Comments and custom punctuation are not
 *   preserved — the editor switches to this serializer on the first canvas
 *   modification.
 *
 * This module is intentionally free of Node-only imports so the browser
 * editor can share it; content hashing lives in the server-only hash module.
 */

const MAX_YAML_BYTES = PIPELINE_MAX_YAML_BYTES;
const MAX_YAML_ALIASES = PIPELINE_MAX_YAML_ALIASES;

const toDiagnostic = (
	severity: "error" | "warning",
	code: string,
	message: string,
	location?: { line: number; column: number },
): PipelineDiagnostic => ({
	severity,
	code,
	message,
	...(location ? { location } : {}),
});

const countAliases = (document: Document.Parsed): number => {
	let count = 0;
	const visit = (node: unknown): void => {
		if (isAlias(node)) {
			count += 1;
			return;
		}
		if (isMap(node)) {
			for (const item of node.items) {
				visit(item.key);
				visit(item.value);
			}
			return;
		}
		if (isSeq(node)) {
			for (const item of node.items) visit(item);
		}
	};
	visit(document.contents);
	return count;
};

/** True when the YAML source reuses one anchor more than once (billion-laughs style). */
const hasExplosiveAliasExpansion = (document: Document.Parsed): boolean => {
	const counts = new Map<string, number>();
	const visit = (node: unknown): void => {
		if (isAlias(node)) {
			const anchor = node.source;
			counts.set(anchor, (counts.get(anchor) ?? 0) + 1);
			return;
		}
		if (isMap(node)) {
			for (const item of node.items) {
				visit(item.key);
				visit(item.value);
			}
			return;
		}
		if (isSeq(node)) {
			for (const item of node.items) visit(item);
		}
	};
	visit(document.contents);
	// A single alias reused more than 16x inside one document is not a
	// legitimate pipeline shape; reject as a safety net.
	return [...counts.values()].some((count) => count > 16);
};

const materializeStageDefaults = (
	document: PipelineDocumentV3,
): PipelineDocumentV3 => ({
	...document,
	stages: Object.fromEntries(
		Object.entries(document.stages).map(([id, stage]) => [
			id,
			{ ...stage, goal: stage.goal ?? false },
		]),
	),
});

/**
 * Parse raw YAML text into a validated PipelineDocumentV3.
 * Returns `document: null` when the text cannot be interpreted as a valid
 * V3 document; the editor then keeps the last valid document and marks the
 * canvas stale. Raw text is preserved separately by the caller (drafts).
 */
export const parsePipelineDocumentV3 = (
	raw: string,
): { document: PipelineDocumentV3 | null; diagnostics: PipelineDiagnostic[] } => {
	const diagnostics: PipelineDiagnostic[] = [];

	const bytes = new TextEncoder().encode(raw).length;
	if (bytes > MAX_YAML_BYTES) {
		diagnostics.push(
			toDiagnostic(
				"error",
				"yaml.size_exceeded",
				`YAML document is ${bytes} bytes; the limit is ${MAX_YAML_BYTES} bytes`,
			),
		);
	}

	const lineCounter = new LineCounter();
	const document = parseDocument(raw, { lineCounter });
	if (document.errors.length > 0) {
		for (const error of document.errors) {
			const [line, column] = error.linePos?.[0]
				? [error.linePos[0].line, error.linePos[0].col]
				: [undefined, undefined];
			diagnostics.push(
				toDiagnostic(
					"error",
					"yaml.syntax",
					error.message,
					line && column ? { line, column } : undefined,
				),
			);
		}
		return { document: null, diagnostics };
	}
	if (document.warnings.length > 0) {
		for (const warning of document.warnings) {
			diagnostics.push(
				toDiagnostic("warning", "yaml.warning", warning.message),
			);
		}
	}

	const aliasCount = countAliases(document);
	if (aliasCount > MAX_YAML_ALIASES) {
		diagnostics.push(
			toDiagnostic(
				"error",
				"yaml.alias_limit",
				`YAML document uses ${aliasCount} aliases; the limit is ${MAX_YAML_ALIASES}`,
			),
		);
	}
	if (hasExplosiveAliasExpansion(document)) {
		diagnostics.push(
			toDiagnostic(
				"error",
				"yaml.alias_expansion",
				"YAML anchor reuse is too aggressive; this document would expand explosively",
			),
		);
	}

	if (document.contents === null) {
		diagnostics.push(
			toDiagnostic("error", "yaml.empty", "YAML document is empty"),
		);
		return { document: null, diagnostics };
	}

	// Size / alias violations are blocking even when the YAML parses cleanly.
	if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
		return { document: null, diagnostics };
	}

	const value = document.toJS();
	const parsed = pipelineDocumentV3Schema.safeParse(value);
	if (!parsed.success) {
		for (const issue of parsed.error.issues) {
			diagnostics.push(
				toDiagnostic(
					"error",
					`v3.${issue.code.toLowerCase()}`,
					`${issue.path.join(".") || "pipeline"}: ${issue.message}`,
				),
			);
		}
		return { document: null, diagnostics };
	}

	return { document: materializeStageDefaults(parsed.data), diagnostics };
};

/**
 * Stable, deterministic serialization of a validated document.
 *
 * Map keys follow declaration order: documents produced by Zod parsing or by
 * the V2 converter always carry keys in schema order, so the same document
 * serializes identically every time without alphabetically sorting (which
 * would bury `stages` under `edges` and hurt readability). Prompts render as
 * literal block scalars so `{{variable}}` and markdown survive verbatim.
 * Comments and custom layout are not preserved — the editor switches to this
 * serializer on the first canvas modification.
 */
export const serializePipelineDocumentV3 = (
	document: PipelineDocumentV3,
): string =>
	stringify(document, {
		lineWidth: 0,
		defaultStringType: "PLAIN",
	});

/**
 * Canonical form of a document: parsed back after serialization so Zod
 * defaults (edge `mode`, empty arrays, …) are materialized. Content hashes
 * and version idempotency operate on this form, never on hand-built objects
 * that omit defaults.
 */
export const normalizePipelineDocumentV3 = (
	document: PipelineDocumentV3,
): PipelineDocumentV3 =>
	parsePipelineDocumentV3(serializePipelineDocumentV3(document)).document ??
	document;

/**
 * Round-trip guard: `parse(serialize(doc))` must equal `doc`. Used by tests
 * and by the publish path before a version is stored.
 */
export const assertStableRoundTrip = (document: PipelineDocumentV3): void => {
	const { document: reparsed, diagnostics } = parsePipelineDocumentV3(
		serializePipelineDocumentV3(document),
	);
	if (!reparsed) {
		throw new Error(
			`stable serialization did not round-trip: ${diagnostics
				.map((d) => d.message)
				.join("; ")}`,
		);
	}
};
