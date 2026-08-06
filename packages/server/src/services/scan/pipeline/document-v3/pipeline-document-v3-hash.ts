import { createHash } from "node:crypto";
import type { PipelineDocumentV3 } from "./pipeline-document-v3";
import {
	normalizePipelineDocumentV3,
	serializePipelineDocumentV3,
} from "./pipeline-document-v3-io";

/**
 * Content hash over the canonical (normalized, stable-serialized) document.
 *
 * Publishing the same semantic content always yields the same hash, so
 * `publish` can short-circuit when a version with this hash already exists.
 * Comments, custom layout, and omitted Zod defaults in the raw text do not
 * affect the hash.
 *
 * Server-only: uses node:crypto. The browser editor never hashes — the
 * server is authoritative for versioning.
 */
export const computePipelineContentHash = (
	document: PipelineDocumentV3,
): string => {
	const canonical = normalizePipelineDocumentV3(document);
	return createHash("sha256")
		.update(serializePipelineDocumentV3(canonical))
		.digest("hex");
};

/** Hash of the raw YAML text as saved in a draft (byte-identical input). */
export const computeRawYamlHash = (raw: string): string =>
	createHash("sha256").update(raw, "utf8").digest("hex");
