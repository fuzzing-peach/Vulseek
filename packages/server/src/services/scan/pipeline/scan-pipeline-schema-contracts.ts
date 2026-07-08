import Ajv, { type ErrorObject } from "ajv";
import addFormats from "ajv-formats";
import type { ZodTypeAny } from "zod";

export type JsonSchemaObject = Record<string, unknown>;

export type JsonSchemaArtifactAnnotation = {
	path: string;
	kind: "path" | "path_list";
	jsonSchema: JsonSchemaObject;
};

export type JsonSchemaContract = {
	kind: "json-schema";
	schema: JsonSchemaObject;
	artifactAnnotations: JsonSchemaArtifactAnnotation[];
	validate: (value: unknown) => void;
};

export type StructuredOutputSchemaSource = ZodTypeAny | JsonSchemaContract;

const PATH_OF_KEY = "$pathOf";

const createAjv = () => {
	const ajv = new Ajv({
		allErrors: true,
		strict: false,
	});
	addFormats(ajv);
	return ajv;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value);

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const resolveInternalSchemaRef = (
	ref: string,
	schemas: Record<string, JsonSchemaObject>,
) => {
	const prefix = "#/schemas/";
	if (!ref.startsWith(prefix)) {
		throw new Error(`Unsupported schema reference ${ref}`);
	}
	const schemaName = ref.slice(prefix.length);
	const schema = schemas[schemaName];
	if (!schema) {
		throw new Error(`Unknown schema reference ${ref}`);
	}
	return schema;
};

const normalizeJsonSchema = (input: {
	schema: unknown;
	schemas: Record<string, JsonSchemaObject>;
	path: string;
}): {
	schema: unknown;
	artifactAnnotations: JsonSchemaArtifactAnnotation[];
} => {
	if (!isObject(input.schema)) {
		return {
			schema: input.schema,
			artifactAnnotations: [],
		};
	}

	const ref = input.schema.$ref;
	if (typeof ref === "string") {
		return normalizeJsonSchema({
			schema: resolveInternalSchemaRef(ref, input.schemas),
			schemas: input.schemas,
			path: input.path,
		});
	}

	return normalizePathOfSchema(input);
};

const formatAjvErrors = (errors: ErrorObject[] | null | undefined) =>
	(errors ?? [])
		.map((error) => {
			const path = error.instancePath || "/";
			return `${path} ${error.message ?? "is invalid"}`;
		})
		.join("; ");

const normalizePathOfSchema = (input: {
	schema: unknown;
	schemas: Record<string, JsonSchemaObject>;
	path: string;
}): {
	schema: unknown;
	artifactAnnotations: JsonSchemaArtifactAnnotation[];
} => {
	if (!isObject(input.schema)) {
		return {
			schema: input.schema,
			artifactAnnotations: [],
		};
	}

	const pathOf = input.schema[PATH_OF_KEY];
	if (typeof pathOf === "string") {
		return {
			schema: { type: "string" },
			artifactAnnotations: [
				{
					path: input.path,
					kind: input.path.endsWith("[]") ? "path_list" : "path",
					jsonSchema: cloneJson(
						resolveInternalSchemaRef(pathOf, input.schemas),
					),
				},
			],
		};
	}

	const nextSchema: Record<string, unknown> = {};
	const annotations: JsonSchemaArtifactAnnotation[] = [];
	for (const [key, value] of Object.entries(input.schema)) {
		if (key === "properties" && isObject(value)) {
			const properties: Record<string, unknown> = {};
			for (const [propertyName, propertySchema] of Object.entries(value)) {
				const normalized = normalizeJsonSchema({
					schema: propertySchema,
					schemas: input.schemas,
					path: `${input.path}.${propertyName}`,
				});
				properties[propertyName] = normalized.schema;
				annotations.push(...normalized.artifactAnnotations);
			}
			nextSchema[key] = properties;
			continue;
		}
		if (key === "items") {
			const normalized = normalizeJsonSchema({
				schema: value,
				schemas: input.schemas,
				path: `${input.path}[]`,
			});
			nextSchema[key] = normalized.schema;
			annotations.push(...normalized.artifactAnnotations);
			continue;
		}
		if (Array.isArray(value)) {
			nextSchema[key] = value.map((item) => {
				const normalized = normalizeJsonSchema({
					schema: item,
					schemas: input.schemas,
					path: input.path,
				});
				annotations.push(...normalized.artifactAnnotations);
				return normalized.schema;
			});
			continue;
		}
		if (isObject(value)) {
			const normalized = normalizeJsonSchema({
				schema: value,
				schemas: input.schemas,
				path: input.path,
			});
			nextSchema[key] = normalized.schema;
			annotations.push(...normalized.artifactAnnotations);
			continue;
		}
		nextSchema[key] = value;
	}

	return {
		schema: nextSchema,
		artifactAnnotations: annotations,
	};
};

export const createJsonSchemaContract = (input: {
	schemas: Record<string, JsonSchemaObject>;
	schema: JsonSchemaObject;
}): JsonSchemaContract => {
	const normalized = normalizeJsonSchema({
		schema: input.schema,
		schemas: input.schemas,
		path: "output",
	});
	if (!isObject(normalized.schema)) {
		throw new Error("JSON Schema contract must normalize to an object schema");
	}
	const ajv = createAjv();
	const validate = ajv.compile(normalized.schema);
	return {
		kind: "json-schema",
		schema: normalized.schema,
		artifactAnnotations: normalized.artifactAnnotations,
		validate: (value) => {
			if (validate(value)) {
				return;
			}
			throw new Error(
				`JSON Schema validation failed: ${formatAjvErrors(validate.errors)}`,
			);
		},
	};
};

export const getJsonSchemaArtifactAnnotations = (
	contract: JsonSchemaContract,
) => contract.artifactAnnotations;

export const validateJsonSchemaContract = (
	contract: JsonSchemaContract,
	value: unknown,
) => contract.validate(value);

export const validateStructuredOutputSchemaSource = <T = unknown>(
	schema: StructuredOutputSchemaSource,
	value: unknown,
): T => {
	if (isJsonSchemaContract(schema)) {
		validateJsonSchemaContract(schema, value);
		return value as T;
	}
	return schema.parse(value) as T;
};

export const isJsonSchemaContract = (
	value: unknown,
): value is JsonSchemaContract =>
	isObject(value) && value.kind === "json-schema" && isObject(value.schema);
