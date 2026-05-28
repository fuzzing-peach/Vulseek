import { z, type ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
	isTaskArtifactPath,
	taskArtifactPathSchemaMessage,
} from "./task-artifact-paths";

type ArtifactAnnotationKind = "path" | "path_list";

export type ArtifactSchemaAnnotation = {
	path: string;
	kind: ArtifactAnnotationKind;
	schema: ZodTypeAny;
	jsonSchema: unknown;
};

const artifactSchemaRegistry = new WeakMap<
	ZodTypeAny,
	{ kind: ArtifactAnnotationKind; schema: ZodTypeAny }
>();

export const taskArtifactPathSchema = z
	.string()
	.refine(isTaskArtifactPath, taskArtifactPathSchemaMessage);

const annotateArtifactSchema = <T extends ZodTypeAny>(
	pathSchema: T,
	annotation: { kind: ArtifactAnnotationKind; schema: ZodTypeAny },
) => {
	artifactSchemaRegistry.set(pathSchema, annotation);
	return pathSchema;
};

export const artifactPathOf = <T extends ZodTypeAny>(schema: T) =>
	annotateArtifactSchema(taskArtifactPathSchema.describe("task artifact path"), {
		kind: "path",
		schema,
	});

export const artifactPathListOf = <T extends ZodTypeAny>(schema: T) =>
	annotateArtifactSchema(
		z.array(taskArtifactPathSchema).describe("task artifact path list"),
		{
			kind: "path_list",
			schema,
		},
	);

const unwrapObjectShape = (schema: ZodTypeAny) => {
	if (schema instanceof z.ZodObject) {
		return schema.shape;
	}
	return null;
};

const toArtifactJsonSchema = (schema: ZodTypeAny) =>
	zodToJsonSchema(schema, {
		target: "jsonSchema7",
		$refStrategy: "none",
	});

export const getArtifactSchemaAnnotations = (
	schema: ZodTypeAny,
	basePath = "output",
): ArtifactSchemaAnnotation[] => {
	const shape = unwrapObjectShape(schema);
	if (!shape) {
		const annotation = artifactSchemaRegistry.get(schema);
		return annotation
			? [
					{
						path: basePath,
						kind: annotation.kind,
						schema: annotation.schema,
						jsonSchema: toArtifactJsonSchema(annotation.schema),
					},
				]
			: [];
	}

	const annotations: ArtifactSchemaAnnotation[] = [];
	for (const [key, fieldSchema] of Object.entries(shape)) {
		const typedFieldSchema = fieldSchema as ZodTypeAny;
		const annotation = artifactSchemaRegistry.get(typedFieldSchema);
		if (annotation) {
			annotations.push({
				path:
					annotation.kind === "path_list"
						? `${basePath}.${key}[]`
						: `${basePath}.${key}`,
				kind: annotation.kind,
				schema: annotation.schema,
				jsonSchema: toArtifactJsonSchema(annotation.schema),
			});
			continue;
		}
		annotations.push(
			...getArtifactSchemaAnnotations(typedFieldSchema, `${basePath}.${key}`),
		);
	}
	return annotations;
};
