import { z } from "zod";
import { PIPELINE_SLUG_PATTERN } from "../../services/scan/pipeline/document-v3";

export const apiPipelineId = z.object({
	pipelineId: z.string().min(1),
});

export const apiPipelineVersionId = z.object({
	pipelineVersionId: z.string().min(1),
});

export const apiPipelineSlug = z
	.string()
	.regex(PIPELINE_SLUG_PATTERN, "Slug must be a stable slug (^[a-z][a-z0-9_-]{0,63}$)");

export const apiCreatePipeline = z.object({
	slug: apiPipelineSlug,
	name: z.string().trim().min(1).max(160),
	description: z.string().max(400).nullable().optional(),
	initialYaml: z.string().max(2 * 1024 * 1024).nullable().optional(),
});

export const apiSavePipelineDraft = apiPipelineId.extend({
	expectedRevision: z.number().int().min(0),
	yaml: z.string().max(2 * 1024 * 1024),
});

export const apiPublishPipeline = apiPipelineId.extend({
	expectedRevision: z.number().int().min(0).nullable().optional(),
	yaml: z.string().max(2 * 1024 * 1024).nullable().optional(),
});

export const apiCopyVersionToDraft = apiPipelineId.merge(apiPipelineVersionId);

export const apiSetCurrentVersion = apiPipelineId.merge(apiPipelineVersionId);

export const apiDuplicatePipeline = apiPipelineId.extend({
	slug: apiPipelineSlug,
	name: z.string().trim().min(1).max(160).nullable().optional(),
});

export const apiArchivePipeline = apiPipelineId;
export const apiUnarchivePipeline = apiPipelineId;
export const apiDeletePipelineDraft = apiPipelineId;

export const apiValidatePipelineYaml = z.object({
	yaml: z.string().max(2 * 1024 * 1024),
});

export const apiPublishedPipelineOptions = z.object({
	targetType: z.enum(["project", "evaluation"]),
});
