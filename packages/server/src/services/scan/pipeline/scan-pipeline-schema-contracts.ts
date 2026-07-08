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

const jsonTypeOf = (value: unknown) => {
	if (value === null) {
		return "null";
	}
	if (Array.isArray(value)) {
		return "array";
	}
	if (Number.isInteger(value)) {
		return "integer";
	}
	return typeof value === "object" ? "object" : typeof value;
};

const isJsonType = (value: unknown, type: unknown) => {
	const types = Array.isArray(type) ? type : [type];
	const valueType = jsonTypeOf(value);
	return types.some(
		(item) =>
			item === valueType ||
			(item === "number" &&
				(valueType === "number" || valueType === "integer")),
	);
};

const validateJsonSchemaValue = (
	schema: unknown,
	value: unknown,
	path = "/",
): string[] => {
	if (!isObject(schema)) {
		return [];
	}
	if (Array.isArray(schema.allOf)) {
		return schema.allOf.flatMap((item) =>
			validateJsonSchemaValue(item, value, path),
		);
	}
	if (Array.isArray(schema.anyOf)) {
		const failures = schema.anyOf.map((item) =>
			validateJsonSchemaValue(item, value, path),
		);
		return failures.some((errors) => errors.length === 0)
			? []
			: [`${path} must match at least one schema`];
	}
	if ("const" in schema && value !== schema.const) {
		return [`${path} must be ${JSON.stringify(schema.const)}`];
	}
	if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
		return [`${path} must be one of ${schema.enum.map(String).join(", ")}`];
	}
	if (schema.type !== undefined && !isJsonType(value, schema.type)) {
		return [`${path} must be ${Array.isArray(schema.type) ? schema.type.join(" or ") : String(schema.type)}`];
	}

	const errors: string[] = [];
	if (typeof value === "number") {
		if (typeof schema.minimum === "number" && value < schema.minimum) {
			errors.push(`${path} must be >= ${schema.minimum}`);
		}
		if (typeof schema.maximum === "number" && value > schema.maximum) {
			errors.push(`${path} must be <= ${schema.maximum}`);
		}
	}
	if (typeof value === "string") {
		if (typeof schema.minLength === "number" && value.length < schema.minLength) {
			errors.push(`${path} length must be >= ${schema.minLength}`);
		}
	}
	if (Array.isArray(value)) {
		if (typeof schema.minItems === "number" && value.length < schema.minItems) {
			errors.push(`${path} must contain at least ${schema.minItems} items`);
		}
		if (schema.items !== undefined) {
			value.forEach((item, index) => {
				errors.push(
					...validateJsonSchemaValue(schema.items, item, `${path}/${index}`),
				);
			});
		}
	}
	if (isObject(value)) {
		const required = Array.isArray(schema.required) ? schema.required : [];
		for (const key of required) {
			if (typeof key === "string" && !(key in value)) {
				errors.push(`${path}/${key} is required`);
			}
		}
		const properties = isObject(schema.properties) ? schema.properties : {};
		for (const [key, propertySchema] of Object.entries(properties)) {
			if (key in value) {
				errors.push(
					...validateJsonSchemaValue(
						propertySchema,
						value[key],
						`${path}/${key}`,
					),
				);
			}
		}
		if (schema.additionalProperties === false) {
			for (const key of Object.keys(value)) {
				if (!(key in properties)) {
					errors.push(`${path}/${key} is not allowed`);
				}
			}
		}
	}

	return errors;
};

const validateAgainstJsonSchema = (schema: JsonSchemaObject, value: unknown) => {
	const errors = validateJsonSchemaValue(schema, value);
	if (errors.length > 0) {
		throw new Error(`JSON Schema validation failed: ${errors.join("; ")}`);
	}
};

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
		const artifactSchema = normalizeJsonSchema({
			schema: resolveInternalSchemaRef(pathOf, input.schemas),
			schemas: input.schemas,
			path: input.path,
		});
		return {
			schema: { type: "string" },
			artifactAnnotations: [
				{
					path: input.path,
					kind: input.path.endsWith("[]") ? "path_list" : "path",
					jsonSchema: cloneJson(artifactSchema.schema) as JsonSchemaObject,
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
	const schema = normalized.schema;
	return {
		kind: "json-schema",
		schema,
		artifactAnnotations: normalized.artifactAnnotations,
		validate: (value) => validateAgainstJsonSchema(schema, value),
	};
};

export const getJsonSchemaArtifactAnnotations = (
	contract: JsonSchemaContract,
) => contract.artifactAnnotations;

export const validateJsonSchemaContract = (
	contract: JsonSchemaContract,
	value: unknown,
) => contract.validate(value);

const readOutputPath = (value: unknown, annotationPath: string) => {
	const path = annotationPath.replace(/^output\.?/, "");
	if (!path) {
		return value;
	}
	let current = value;
	for (const part of path.split(".")) {
		if (!part) {
			continue;
		}
		const isArray = part.endsWith("[]");
		const key = isArray ? part.slice(0, -2) : part;
		if (!isObject(current)) {
			throw new Error(`${annotationPath} parent is not an object`);
		}
		current = current[key];
		if (isArray) {
			if (!Array.isArray(current)) {
				throw new Error(`${annotationPath} must be an array of artifact paths`);
			}
			return current;
		}
	}
	return current;
};

export const validateJsonSchemaContractArtifacts = async (
	contract: JsonSchemaContract,
	value: unknown,
	readArtifactJson: (artifactPath: string) => Promise<unknown>,
) => {
	for (const annotation of contract.artifactAnnotations) {
		const artifactPaths = readOutputPath(value, annotation.path);
		const paths =
			annotation.kind === "path_list" ? artifactPaths : [artifactPaths];
		if (!Array.isArray(paths)) {
			throw new Error(`${annotation.path} must be an array of artifact paths`);
		}
		for (const artifactPath of paths) {
			if (typeof artifactPath !== "string" || artifactPath.length === 0) {
				throw new Error(`${annotation.path} must contain artifact path strings`);
			}
			const artifactJson = await readArtifactJson(artifactPath);
			try {
				validateAgainstJsonSchema(annotation.jsonSchema, artifactJson);
				continue;
			} catch (error) {
				throw new Error(
					`${annotation.path} artifact ${artifactPath} ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}
};

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
