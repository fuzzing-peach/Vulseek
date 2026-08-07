import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { computePipelineContentHash } from "./pipeline-document-v3-hash";
import {
	normalizePipelineDocumentV3,
	parsePipelineDocumentV3,
	serializePipelineDocumentV3,
} from "./pipeline-document-v3-io";
import type { PipelineDocumentV3 } from "./pipeline-document-v3";
import { convertV2DefinitionsToV3, type PipelineKind } from "./pipeline-v2-converter";

/**
 * Built-in system pipelines.
 *
 * The four V2 pipelines (full / delta / research / tob-goal) are converted
 * once into V3 documents (prompts inlined). At runtime the system prefers the
 * generated `definitions/pipelines-v3/*.yaml` files when present; otherwise
 * it converts the legacy definitions on the fly. The generated files are
 * checked in and are the product templates seeded per organization.
 */

export type BuiltinPipelineTemplate = {
	kind: PipelineKind;
	systemKey: string;
	name: string;
	yaml: string;
	contentHash: string;
};

export const BUILTIN_SYSTEM_KEYS: Record<PipelineKind, string> = {
	full: "full",
	delta: "delta",
	research: "research",
	"tob-goal": "tob-goal",
};

export const BUILTIN_DOCUMENT_NAME: Record<PipelineKind, string> = {
	full: "full-scan-programmatic",
	delta: "delta-scan-programmatic",
	research: "security-research-programmatic",
	"tob-goal": "tob-goal-programmatic",
};

const resolvePipelinesV3Dir = (): string | null => {
	// The generated templates sit next to the legacy definitions:
	//   src:  …/scan/pipeline/definitions/pipelines-v3
	//   dist: …/scan/pipeline/definitions/pipelines-v3
	// (dev/prod share the layout because `server:script` keeps @vulseek/server
	// resolved to src; import.meta.url works in both ESM and tsx.)
	const moduleDir = dirname(fileURLToPath(import.meta.url));
	for (const depth of [1, 2, 3]) {
		const candidate = join(
			moduleDir,
			...Array.from({ length: depth }, () => ".."),
			"definitions",
			"pipelines-v3",
		);
		if (existsSync(candidate)) return candidate;
	}
	return null;
};

const loadGeneratedTemplate = (kind: PipelineKind): BuiltinPipelineTemplate | null => {
	const dir = resolvePipelinesV3Dir();
	if (!dir) return null;
	const fileName = `${kind}.yaml`;
	const filePath = join(dir, fileName);
	if (!existsSync(filePath)) return null;
	const yaml = readFileSync(filePath, "utf-8");
	const { document } = parsePipelineDocumentV3(yaml);
	if (!document) {
		throw new Error(
			`Generated V3 pipeline file ${filePath} is not a valid V3 document`,
		);
	}
	return {
		kind,
		systemKey: BUILTIN_SYSTEM_KEYS[kind],
		name: BUILTIN_DOCUMENT_NAME[kind],
		yaml: serializePipelineDocumentV3(document),
		contentHash: computePipelineContentHash(document),
	};
};

const buildTemplateFromV2 = (
	kind: PipelineKind,
	document: PipelineDocumentV3,
): BuiltinPipelineTemplate => {
	const canonical = normalizePipelineDocumentV3(document);
	return {
		kind,
		systemKey: BUILTIN_SYSTEM_KEYS[kind],
		name: BUILTIN_DOCUMENT_NAME[kind],
		yaml: serializePipelineDocumentV3(canonical),
		contentHash: computePipelineContentHash(canonical),
	};
};

/**
 * Load the four built-in templates. Prefers the checked-in generated V3 YAML
 * files; falls back to live conversion of the V2 definitions.
 */
export const loadBuiltinPipelineTemplates = (): BuiltinPipelineTemplate[] => {
	const results: BuiltinPipelineTemplate[] = [];
	const fallbacks: Array<[PipelineKind, PipelineDocumentV3]> = [];
	const converted = convertV2DefinitionsToV3();

	for (const kind of ["full", "delta", "research", "tob-goal"] as const) {
		const generated = loadGeneratedTemplate(kind);
		if (generated) {
			results.push(generated);
			continue;
		}
		const document = converted.documents[kind];
		if (document) {
			fallbacks.push([kind, document]);
		}
	}

	if (fallbacks.length > 0 && results.length > 0) {
		throw new Error(
			"Mixed V3 template sources: generated files exist for some pipelines but not all",
		);
	}

	if (fallbacks.length > 0) {
		return fallbacks.map(([kind, document]) => buildTemplateFromV2(kind, document));
	}
	return results;
};

export const loadBuiltinPipelineTemplate = (
	kind: PipelineKind,
): BuiltinPipelineTemplate => {
	const template = loadBuiltinPipelineTemplates().find((item) => item.kind === kind);
	if (!template) {
		throw new Error(`No built-in pipeline template for kind "${kind}"`);
	}
	return template;
};
