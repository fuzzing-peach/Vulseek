import { zodToJsonSchema } from "zod-to-json-schema";
import { getArtifactSchemaAnnotations } from "../artifacts/artifact-schema-annotations";
import {
	getJsonSchemaArtifactAnnotations,
	isJsonSchemaContract,
	type StructuredOutputSchemaSource,
} from "../pipeline/scan-pipeline-schema-contracts";

export type RouteOutputSchema = {
	routeKey: string;
	description?: string;
	schema: StructuredOutputSchemaSource;
	default?: boolean;
};

const outputSchemaSourceToJsonSchema = (
	outputSchema: StructuredOutputSchemaSource,
) =>
	isJsonSchemaContract(outputSchema)
		? outputSchema.schema
		: zodToJsonSchema(outputSchema, {
				target: "jsonSchema7",
				$refStrategy: "none",
			});

export const buildStructuredOutputEnvelopeJsonSchema = (
	schema: StructuredOutputSchemaSource,
	routeOutputSchemas?: RouteOutputSchema[],
	options?: {
		nullableOutput?: boolean;
	},
) => {
	const buildEnvelopeOutputSchema = (
		outputSchema: StructuredOutputSchemaSource,
	) => {
		const jsonSchema = outputSchemaSourceToJsonSchema(outputSchema);
		return options?.nullableOutput
			? { anyOf: [jsonSchema, { type: "null" }] }
			: jsonSchema;
	};
	const buildEnvelopeSchema = (input: {
		route: string | null;
		outputSchema: StructuredOutputSchemaSource;
	}) => ({
		type: "object",
		properties: {
			route:
				input.route === null
					? { type: "null" }
					: { type: "string", const: input.route },
			exit: { type: "boolean" },
			output: buildEnvelopeOutputSchema(input.outputSchema),
		},
		required: ["route", "exit", "output"],
		additionalProperties: false,
		$schema: "http://json-schema.org/draft-07/schema#",
	});
	return routeOutputSchemas?.length
		? {
				anyOf: routeOutputSchemas.map((item) =>
					buildEnvelopeSchema({
						route: item.routeKey,
						outputSchema: item.schema,
					}),
				),
				$schema: "http://json-schema.org/draft-07/schema#",
			}
		: buildEnvelopeSchema({ route: null, outputSchema: schema });
};

const buildArtifactSchemaPromptLines = (
	schema: StructuredOutputSchemaSource,
	routeOutputSchemas?: RouteOutputSchema[],
) => {
	const entries = routeOutputSchemas?.length
		? routeOutputSchemas.flatMap((route) =>
				(isJsonSchemaContract(route.schema)
					? getJsonSchemaArtifactAnnotations(route.schema)
					: getArtifactSchemaAnnotations(route.schema)
				).map((annotation) => ({
					routeKey: route.routeKey,
					...annotation,
				})),
			)
		: (isJsonSchemaContract(schema)
				? getJsonSchemaArtifactAnnotations(schema)
				: getArtifactSchemaAnnotations(schema)
			).map((annotation) => ({
				routeKey: null,
				...annotation,
			}));
	if (entries.length === 0) {
		return [];
	}
	return [
		"",
		"Task artifact JSON schemas:",
		"- Some output fields are task artifact paths. For each such path, write a JSON file at that path whose content matches the schema below.",
		"- Validate both output.json and every referenced task artifact JSON file before ending your turn.",
		...entries.flatMap((entry, index) => [
			`- ${entry.routeKey ? `route ${entry.routeKey} ` : ""}${entry.path} points to ${entry.kind === "path_list" ? "JSON files" : "a JSON file"} matching artifact schema ${index + 1}:`,
			"```json",
			JSON.stringify(entry.jsonSchema, null, 2),
			"```",
		]),
	];
};

export const buildStructuredOutputPromptSuffix = (
	schema: StructuredOutputSchemaSource,
	schemaFilePath: string,
	outputFilePath: string,
	routeOutputSchemas?: RouteOutputSchema[],
	options?: {
		persistent?: boolean;
		groupedPersistent?: boolean;
		allowAgentExit?: boolean;
		nullableOutput?: boolean;
	},
) => {
	const jsonSchema = buildStructuredOutputEnvelopeJsonSchema(
		schema,
		routeOutputSchemas,
		{ nullableOutput: options?.nullableOutput },
	);
	const artifactSchemaLines = buildArtifactSchemaPromptLines(
		schema,
		routeOutputSchemas,
	);

	return [
		"",
		"Structured JSON output requirement:",
		`- Write the final structured result to ${outputFilePath}.`,
		"- The output file content must be only a JSON object, with no markdown fences, comments, or prose.",
		"- The top-level JSON object must be an envelope with exactly these fields: route, exit, output.",
		...(options?.nullableOutput
			? [
					"- If this stage has no structured result to return, output may be null.",
					"- Even when output is null, you must still write the complete route/exit/output envelope to output.json.",
				]
			: []),
		...(options?.allowAgentExit
			? [
					"- Set exit to true only when the stage prompt explicitly instructs this analysis workflow to exit; otherwise set exit to false.",
				]
			: ["- Set exit to false."]),
		`- The JSON Schema for the complete output.json envelope is written to ${schemaFilePath}.`,
		"- You must use that schema file as the source of truth and validate output.json against it before ending your turn.",
		"- Perform validation with Python and the jsonschema package available in the container environment.",
		`- Load ${outputFilePath}, load ${schemaFilePath}, and validate it locally with python before ending your turn.`,
		"- During validation, do not print the full JSON object to the terminal or write it to a tool-output file; print only a short success/failure line.",
		"- If validation fails, fix the JSON and validate again before returning.",
		"- The output.json envelope must conform exactly to that JSON Schema.",
		"- Do not add extra fields outside the schema.",
		"- Use null for nullable fields instead of omitting them unless the schema explicitly allows omission.",
		...artifactSchemaLines,
		...(routeOutputSchemas?.length
			? [
					"",
					"Dynamic route requirement:",
					"- Choose exactly one of the route keys below and set output.json route to that value.",
					"- The output object must match the object type for the route you choose.",
					"- If you cannot decide, use the route marked default.",
					...routeOutputSchemas.map(
						(item) =>
							`- ${item.routeKey}${item.default ? " (default)" : ""}: ${item.description || "no description"}`,
					),
				]
			: ["- This stage has no dynamic route; set output.json route to null."]),
		"- Do not include any runtime markers in your final response. Vulseek will wait for end_turn and then read output.json.",
		"",
		"```json",
		JSON.stringify(jsonSchema, null, 2),
		"```",
	].join("\n");
};
