export {
	ALLOWED_EFFECT_TYPES,
	ALLOWED_RUNTIME_PLUGINS,
	PIPELINE_DEFAULT_LIMITS,
	PIPELINE_HARD_LIMITS,
	PIPELINE_MAX_YAML_ALIASES,
	PIPELINE_MAX_YAML_BYTES,
	PIPELINE_PREPARE_MODES,
	PIPELINE_SLUG_PATTERN,
	PIPELINE_STAGE_MODES,
	PIPELINE_STAGE_ROLES,
	PIPELINE_SUPPORTED_TARGETS,
	pipelineDiagnosticSchema,
	pipelineDocumentV3Schema,
	type AllowedRuntimePlugin,
	type PipelineArtifactMappingV3,
	type PipelineDiagnostic,
	type PipelineDocumentParseStatus,
	type PipelineDocumentV3,
	type PipelineEdgeV3,
	type PipelineEffectV3,
	type PipelineGroupV3,
	type PipelineParseResult,
	type PipelineRuntimeV3,
	type PipelineStageV3,
	type PipelineUiV3,
} from "./pipeline-document-v3";
export {
	assertStableRoundTrip,
	normalizePipelineDocumentV3,
	parsePipelineDocumentV3,
	serializePipelineDocumentV3,
} from "./pipeline-document-v3-io";
export {
	collectPipelineDiagnostics,
	hasBlockingDiagnostics,
	validatePipelineDocumentV3,
} from "./pipeline-document-v3-validate";
export {
	compilePipelineDocumentV3,
	derivePipelineCapabilities,
	type CompiledEdgeV3,
	type CompiledPipelineCapabilities,
	type CompiledPipelineDefinition,
	type CompiledStageV3,
} from "./pipeline-v3-compiler";

// Server-only modules (node:fs / node:crypto) are intentionally NOT exported
// here — the browser editor imports this index and must stay free of Node
// builtins. Server code imports them by direct path:
//   - ./pipeline-document-v3-hash      (content hashes)
//   - ./pipeline-v2-converter          (legacy definitions conversion)
//   - ./builtin-pipelines              (system templates, fs-backed)
