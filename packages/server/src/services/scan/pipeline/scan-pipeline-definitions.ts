import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

export const SCAN_PIPELINE_IDS = {
	full: "full",
	delta: "delta",
} as const;

const stageRoleSchema = z.enum(["scan", "analysis", "verification"]);
const stageRunModeSchema = z.enum(["serial", "fanout"]);

const stageRuntimeConfigSchema = z
	.object({
		agentProfile: z.string().min(1).nullable().optional(),
		persistent: z.boolean().nullable().optional(),
		reuseContainer: z.boolean().nullable().optional(),
		mode: stageRunModeSchema.nullable().optional(),
		nullableOutput: z.boolean().nullable().optional(),
		cwd: z.string().min(1).nullable().optional(),
		skills: z.array(z.string().min(1)).nullable().optional(),
		prompt: z.string().nullable().optional(),
		promptFile: z.string().min(1).nullable().optional(),
		inputArtifacts: z.record(z.unknown()).nullable().optional(),
		outputSchema: z.record(z.unknown()).nullable().optional(),
	})
	.default({});

const stageConfigSchema = z.object({
	key: z.string().min(1),
	name: z.string().min(1),
	role: stageRoleSchema,
	group: z.string().min(1),
	concurrency: z.number().int().min(1),
	maxConcurrency: z.number().int().min(1).optional(),
	disableable: z.boolean().default(true),
	description: z.string().optional(),
	inputSchema: z.record(z.unknown()).optional(),
	outputSchema: z.record(z.unknown()).optional(),
	runtimeConfig: stageRuntimeConfigSchema,
});

const edgeConfigSchema = z.object({
	name: z.string().min(1),
	from: z.string().min(1),
	to: z.string().min(1),
	fork: z.boolean().default(false),
	mode: z.enum(["map", "fanOut"]).optional(),
	foreach: z.string().min(1).optional(),
	input: z.unknown().optional(),
	outputSchema: z.record(z.unknown()).optional(),
	outputSchemaDescription: z.string().optional(),
	route: z
		.object({
			key: z.string().min(1),
			default: z.boolean().optional(),
		})
		.optional(),
});

const groupConfigSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	leader: z.string().min(1),
	members: z.array(z.string().min(1)).default([]),
});

const pipelineConfigSchema = z.object({
	name: z.string().min(1),
	root: z.string().min(1),
	stages: z.array(z.string().min(1)).min(1),
	edges: z.array(edgeConfigSchema).default([]),
	groups: z.array(groupConfigSchema).default([]),
});

const scanPipelineDefinitionsSourceSchema = z.object({
	schemas: z.record(z.record(z.unknown())).default({}),
	stages: z.record(stageConfigSchema),
	pipelines: z.object({
		full: pipelineConfigSchema,
		delta: pipelineConfigSchema,
	}),
});

export type ScanStageRole = z.infer<typeof stageRoleSchema>;

export type ScanPipelineStageConfig = {
	id: string;
	key: string;
	name: string;
	role: ScanStageRole;
	group: string;
	concurrency: number;
	maxConcurrency: number | null;
	disableable: boolean;
	description: string | null;
	inputSchema: Record<string, unknown> | null;
	outputSchema: Record<string, unknown> | null;
	runtimeConfig: ScanStageRuntimeConfig | null;
};

export type ScanStageRuntimeConfig = {
	agentProfile: string | null;
	persistent: boolean | null;
	reuseContainer: boolean | null;
	mode: "serial" | "fanout" | null;
	nullableOutput: boolean | null;
	cwd: string | null;
	skills: string[] | null;
	prompt: string | null;
	promptFile: string | null;
	inputArtifacts: Record<string, unknown> | null;
	outputSchema: Record<string, unknown> | null;
};

export type ScanPipelineEdgeConfig = {
	id: string;
	name: string;
	from: string;
	to: string;
	fork: boolean;
	mode: "map" | "fanOut" | null;
	foreach: string | null;
	input: unknown;
	outputSchema: Record<string, unknown> | null;
	outputSchemaDescription: string | null;
	route: {
		key: string;
		default?: boolean;
	} | null;
};

export type ScanPipelineGroupConfig = {
	id: string;
	name: string;
	leader: string;
	members: string[];
};

export type ScanPipelineConfig = {
	id: keyof typeof SCAN_PIPELINE_IDS;
	name: string;
	rootStageId: string;
	stageIds: string[];
	edges: ScanPipelineEdgeConfig[];
	groups: ScanPipelineGroupConfig[];
};

export type ScanPipelineDefinitions = {
	pipelineIds: typeof SCAN_PIPELINE_IDS;
	schemas: Record<string, Record<string, unknown>>;
	stageIds: string[];
	stages: ScanPipelineStageConfig[];
	stageMetadata: Record<string, { id: string; name: string }>;
	stageMetadataById: Record<string, { key: string; id: string; name: string }>;
	stageSettings: Record<
		string,
		{
			stageName: string;
			label: string;
			role: ScanStageRole;
			group: string;
			concurrency: number;
			maxConcurrency: number;
			disableable: boolean;
			description: string;
			inputSchema: Record<string, unknown> | null;
			outputSchema: Record<string, unknown> | null;
			runtimeConfig: ScanStageRuntimeConfig | null;
		}
	>;
	pipelines: Record<keyof typeof SCAN_PIPELINE_IDS, ScanPipelineConfig>;
};

export type ScanPipelineDefinitionsSource = z.infer<
	typeof scanPipelineDefinitionsSourceSchema
>;

export const normalizeLegacyVerificationSchema = (
	definitions: ScanPipelineDefinitions,
): ScanPipelineDefinitions => {
	const verification = definitions.schemas.Verification;
	const properties = verification?.properties;
	const result =
		properties && typeof properties === "object"
			? (properties as Record<string, unknown>).result
			: null;
	const values =
		result && typeof result === "object"
			? (result as { enum?: unknown }).enum
			: null;
	if (
		!Array.isArray(values) ||
		values.length !== 3 ||
		values[0] !== true ||
		values[1] !== "likely" ||
		values[2] !== false
	) {
		return definitions;
	}
	return {
		...definitions,
		schemas: {
			...definitions.schemas,
			Verification: {
				...verification,
				properties: {
					...(properties as Record<string, unknown>),
					result: {
						...(result as Record<string, unknown>),
						enum: ["true", "likely", "false"],
					},
				},
			},
		},
	};
};

export const resolveScanPipelineDefinitionsDir = (
	moduleUrl: string,
	runtimeRoot = process.cwd(),
) => {
	const moduleDefinitionsDir = join(
		dirname(fileURLToPath(moduleUrl)),
		"definitions",
	);
	return existsSync(join(moduleDefinitionsDir, "schemas"))
		? moduleDefinitionsDir
		: join(runtimeRoot, "dist", "definitions");
};

export const SCAN_PIPELINE_DEFINITIONS_DIR = resolveScanPipelineDefinitionsDir(
	import.meta.url,
);

const yamlFileExtensions = new Set([".yaml", ".yml"]);

const listDefinitionYamlFiles = (directory: string) =>
	readdirSync(directory, { withFileTypes: true })
		.filter((entry) => entry.isFile() && yamlFileExtensions.has(extname(entry.name)))
		.map((entry) => entry.name)
		.sort((left, right) => left.localeCompare(right))
		.map((fileName) => join(directory, fileName));

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value);

const readDefinitionSection = (
	sectionName: "schemas" | "stages" | "pipelines",
): Record<string, unknown> => {
	const sectionDir = join(SCAN_PIPELINE_DEFINITIONS_DIR, sectionName);
	const merged: Record<string, unknown> = {};
	for (const filePath of listDefinitionYamlFiles(sectionDir)) {
		const parsed = parseYaml(readFileSync(filePath, "utf-8")) as unknown;
		if (!isRecord(parsed)) {
			throw new Error(
				`Scan pipeline ${sectionName} definition ${basename(filePath)} must be a YAML object`,
			);
		}
		for (const [key, value] of Object.entries(parsed)) {
			if (key in merged) {
				throw new Error(
					`Duplicate scan pipeline ${sectionName} definition ${key} in ${basename(filePath)}`,
				);
			}
			merged[key] = value;
		}
	}
	return merged;
};

export const readScanPipelineDefinitionsSource = () => ({
	schemas: readDefinitionSection("schemas"),
	stages: readDefinitionSection("stages"),
	pipelines: readDefinitionSection("pipelines"),
});

export const readScanPipelineDefinitionsYaml = () =>
	stringifyYaml(readScanPipelineDefinitionsSource());

const toObjectKey = (stageId: string) =>
	stageId.replace(/-([a-z])/g, (_match, char: string) => char.toUpperCase());

const normalizeStageRuntimeConfig = (
	config: z.infer<typeof stageRuntimeConfigSchema>,
): ScanStageRuntimeConfig => ({
	agentProfile: config.agentProfile ?? null,
	persistent: config.persistent ?? null,
	reuseContainer: config.reuseContainer ?? null,
	mode: config.mode ?? null,
	nullableOutput: config.nullableOutput ?? null,
	cwd: config.cwd ?? null,
	skills: config.skills ?? null,
	prompt: config.prompt ?? null,
	promptFile: config.promptFile ?? null,
	inputArtifacts: config.inputArtifacts ?? null,
	outputSchema: config.outputSchema ?? null,
});

const assertUnique = (values: string[], label: string) => {
	const seen = new Set<string>();
	for (const value of values) {
		if (seen.has(value)) {
			throw new Error(`Duplicate ${label}: ${value}`);
		}
		seen.add(value);
	}
};

const validatePipelineTopology = (
	pipelineId: keyof typeof SCAN_PIPELINE_IDS,
	pipeline: ScanPipelineConfig,
	allStageIds: Set<string>,
) => {
	const pipelineStageIds = new Set(pipeline.stageIds);
	if (!allStageIds.has(pipeline.rootStageId)) {
		throw new Error(
			`Pipeline ${pipelineId} references unknown root stage ${pipeline.rootStageId}`,
		);
	}
	if (!pipelineStageIds.has(pipeline.rootStageId)) {
		throw new Error(
			`Pipeline ${pipelineId} root stage ${pipeline.rootStageId} is not listed in stages`,
		);
	}
	for (const stageId of pipeline.stageIds) {
		if (!allStageIds.has(stageId)) {
			throw new Error(
				`Pipeline ${pipelineId} references unknown stage ${stageId}`,
			);
		}
	}
	assertUnique(
		pipeline.edges.map((edge) => edge.name),
		`${pipelineId} edge name`,
	);
	for (const edge of pipeline.edges) {
		if (!pipelineStageIds.has(edge.from)) {
			throw new Error(
				`Pipeline ${pipelineId} edge ${edge.name} references unknown source stage ${edge.from}`,
			);
		}
		if (!pipelineStageIds.has(edge.to)) {
			throw new Error(
				`Pipeline ${pipelineId} edge ${edge.name} references unknown target stage ${edge.to}`,
			);
		}
	}
	for (const group of pipeline.groups) {
		if (!pipelineStageIds.has(group.leader)) {
			throw new Error(
				`Pipeline ${pipelineId} group ${group.id} references unknown leader stage ${group.leader}`,
			);
		}
		for (const member of group.members) {
			if (!pipelineStageIds.has(member)) {
				throw new Error(
					`Pipeline ${pipelineId} group ${group.id} references unknown member stage ${member}`,
				);
			}
		}
	}

	const edgesBySource = new Map<string, ScanPipelineEdgeConfig[]>();
	for (const edge of pipeline.edges) {
		edgesBySource.set(edge.from, [...(edgesBySource.get(edge.from) ?? []), edge]);
	}
	for (const [source, edges] of edgesBySource) {
		if (!edges.some((edge) => edge.route)) {
			continue;
		}
		if (edges.some((edge) => !edge.route)) {
			throw new Error(
				`Pipeline ${pipelineId} stage ${source} mixes routed and non-routed downstream edges`,
			);
		}
		const defaultCount = edges.filter((edge) => edge.route?.default).length;
		if (defaultCount !== 1) {
			throw new Error(
				`Pipeline ${pipelineId} stage ${source} must define exactly one default route`,
			);
		}
		assertUnique(
			edges.map((edge) => edge.route?.key).filter((key): key is string => Boolean(key)),
			`${pipelineId} ${source} route key`,
		);
	}
};

const validateJsonSchemaReferences = (
	schema: unknown,
	schemas: Record<string, Record<string, unknown>>,
) => {
	if (!schema || typeof schema !== "object") {
		return;
	}
	if (Array.isArray(schema)) {
		for (const item of schema) {
			validateJsonSchemaReferences(item, schemas);
		}
		return;
	}

	const record = schema as Record<string, unknown>;
	for (const key of ["$ref", "$pathOf"]) {
		const ref = record[key];
		if (typeof ref !== "string") {
			continue;
		}
		const prefix = "#/schemas/";
		if (!ref.startsWith(prefix)) {
			throw new Error(`Unsupported schema reference ${ref}`);
		}
		if (!schemas[ref.slice(prefix.length)]) {
			throw new Error(`Unknown schema reference ${ref}`);
		}
	}

	for (const value of Object.values(record)) {
		validateJsonSchemaReferences(value, schemas);
	}
};

const validateDefinitionsSchemaReferences = (
	stages: ScanPipelineStageConfig[],
	pipelines: Record<keyof typeof SCAN_PIPELINE_IDS, ScanPipelineConfig>,
	schemas: Record<string, Record<string, unknown>>,
) => {
	for (const stage of stages) {
		validateJsonSchemaReferences(stage.inputSchema, schemas);
		validateJsonSchemaReferences(stage.outputSchema, schemas);
	}
	for (const pipeline of Object.values(pipelines)) {
		for (const edge of pipeline.edges) {
			validateJsonSchemaReferences(edge.outputSchema, schemas);
		}
	}
	for (const schema of Object.values(schemas)) {
		validateJsonSchemaReferences(schema, schemas);
	}
};

const resolveSchemaObject = (
	schema: Record<string, unknown> | null | undefined,
	schemas: Record<string, Record<string, unknown>>,
): Record<string, unknown> | null => {
	if (!schema) {
		return null;
	}
	const ref = schema.$ref;
	if (typeof ref === "string") {
		const prefix = "#/schemas/";
		return schemas[ref.slice(prefix.length)] ?? null;
	}
	return schema;
};

const getSchemaProperties = (
	schema: Record<string, unknown> | null | undefined,
	schemas: Record<string, Record<string, unknown>>,
): Record<string, unknown> => {
	const resolved = resolveSchemaObject(schema, schemas);
	if (!resolved) {
		return {};
	}
	if (resolved.properties && typeof resolved.properties === "object") {
		return resolved.properties as Record<string, unknown>;
	}
	if (Array.isArray(resolved.allOf)) {
		return Object.assign(
			{},
			...resolved.allOf.map((item) =>
				typeof item === "object" && item
					? getSchemaProperties(item as Record<string, unknown>, schemas)
					: {},
			),
		);
	}
	return {};
};

const collectTransformExpressions = (value: unknown): string[] => {
	if (typeof value === "string" && value.startsWith("$")) {
		return [value];
	}
	if (Array.isArray(value)) {
		return value.flatMap(collectTransformExpressions);
	}
	if (value && typeof value === "object") {
		return Object.values(value).flatMap(collectTransformExpressions);
	}
	return [];
};

const readFirstField = (expression: string, prefix: string) => {
	const tail = expression.slice(prefix.length);
	const normalized = tail.endsWith("[*]") ? tail.slice(0, -3) : tail;
	return normalized.split(".")[0] || "";
};

const validatePathExpressionPrefix = (input: {
	expression: string;
	edge: ScanPipelineEdgeConfig;
	sourceStage: ScanPipelineStageConfig;
	schemas: Record<string, Record<string, unknown>>;
	allowForEachSuffix: boolean;
}) => {
	const { expression, edge, sourceStage, schemas, allowForEachSuffix } = input;
	if (expression === "$item") {
		if (edge.mode !== "fanOut") {
			throw new Error(`Edge ${edge.name} uses $item outside fanOut mode`);
		}
		return;
	}
	if (/^\$item\.[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/.test(expression)) {
		if (edge.mode !== "fanOut") {
			throw new Error(`Edge ${edge.name} uses $item outside fanOut mode`);
		}
		return;
	}
	if (/^\$ctx\.[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/.test(expression)) {
		return;
	}
	if (/^\$computed\.[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/.test(expression)) {
		return;
	}
	const outputPattern = allowForEachSuffix
		? /^\$\.[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*(\[\*\])?$/
		: /^\$\.[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;
	if (outputPattern.test(expression)) {
		const field = readFirstField(expression, "$.");
		const properties = getSchemaProperties(sourceStage.outputSchema, schemas);
		if (Object.keys(properties).length > 0 && !(field in properties)) {
			throw new Error(
				`Edge ${edge.name} references unknown output field ${field}`,
			);
		}
		return;
	}
	if (/^\$input\.[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/.test(expression)) {
		const field = readFirstField(expression, "$input.");
		const properties = getSchemaProperties(sourceStage.inputSchema, schemas);
		if (Object.keys(properties).length > 0 && !(field in properties)) {
			throw new Error(
				`Edge ${edge.name} references unknown input field ${field}`,
			);
		}
		return;
	}
	throw new Error(`Unsupported transform expression: ${expression}`);
};

const validateFileExpression = (input: {
	expression: string;
	edge: ScanPipelineEdgeConfig;
	sourceStage: ScanPipelineStageConfig;
	schemas: Record<string, Record<string, unknown>>;
	requireForEach: boolean;
}) => {
	const match = input.expression.match(
		/^\$file\((.+?)\)((?:\.[A-Za-z0-9_-]+)*)(\[\*\])?$/,
	);
	if (!match) {
		throw new Error(
			`Unsupported transform expression: ${input.expression}`,
		);
	}
	const pathExpr = match[1] ?? "";
	const hasForEach = Boolean(match[3]);
	if (input.requireForEach && !hasForEach) {
		throw new Error(
			`Edge ${input.edge.name} fanOut foreach $file expression must end with [*]`,
		);
	}
	if (!input.requireForEach && hasForEach) {
		throw new Error(
			`Edge ${input.edge.name} uses foreach [*] outside fanOut foreach`,
		);
	}
	validatePathExpressionPrefix({
		expression: pathExpr,
		edge: input.edge,
		sourceStage: input.sourceStage,
		schemas: input.schemas,
		allowForEachSuffix: false,
	});
};

const validateTransformExpression = (input: {
	expression: string;
	edge: ScanPipelineEdgeConfig;
	sourceStage: ScanPipelineStageConfig;
	schemas: Record<string, Record<string, unknown>>;
	isForEach?: boolean;
}) => {
	const { expression, edge, sourceStage, schemas, isForEach = false } = input;
	if (expression.startsWith("$file(")) {
		validateFileExpression({
			expression,
			edge,
			sourceStage,
			schemas,
			requireForEach: isForEach,
		});
		return;
	}
	validatePathExpressionPrefix({
		expression,
		edge,
		sourceStage,
		schemas,
		allowForEachSuffix: isForEach,
	});
};

const validateDefinitionsEdgeTransformExpressions = (
	stages: ScanPipelineStageConfig[],
	pipelines: Record<keyof typeof SCAN_PIPELINE_IDS, ScanPipelineConfig>,
	schemas: Record<string, Record<string, unknown>>,
) => {
	const stagesById = new Map(stages.map((stage) => [stage.id, stage]));
	for (const pipeline of Object.values(pipelines)) {
		for (const edge of pipeline.edges) {
			if (edge.mode === "fanOut") {
				if (!edge.foreach) {
					throw new Error(`Edge ${edge.name} fanOut requires foreach`);
				}
				validateTransformExpression({
					expression: edge.foreach,
					edge,
					sourceStage: stagesById.get(edge.from)!,
					schemas,
					isForEach: true,
				});
			}
			for (const expression of collectTransformExpressions(edge.input)) {
				validateTransformExpression({
					expression,
					edge,
					sourceStage: stagesById.get(edge.from)!,
					schemas,
					isForEach: false,
				});
			}
		}
	}
};

export const parseScanPipelineDefinitionsSource = (
	source: unknown,
): ScanPipelineDefinitions => {
	const parsed = scanPipelineDefinitionsSourceSchema.parse(source);
	const stageIds = Object.keys(parsed.stages);
	assertUnique(stageIds, "stage id");
	assertUnique(
		Object.values(parsed.stages).map((stage) => stage.key),
		"stage key",
	);

	const stages = Object.entries(parsed.stages).map(
		([id, stage]): ScanPipelineStageConfig => {
			return {
				id,
				key: stage.key,
				name: stage.name,
				role: stage.role,
				group: stage.group,
				concurrency: stage.concurrency,
				maxConcurrency: stage.maxConcurrency ?? null,
				disableable: stage.disableable,
				description: stage.description ?? null,
				inputSchema: stage.inputSchema ?? null,
				outputSchema: stage.outputSchema ?? null,
				runtimeConfig: normalizeStageRuntimeConfig(stage.runtimeConfig),
			};
		},
	);
	const allStageIds = new Set(stageIds);
	const buildPipeline = (
		id: keyof typeof SCAN_PIPELINE_IDS,
	): ScanPipelineConfig => {
		const pipeline = parsed.pipelines[id];
		return {
			id,
			name: pipeline.name,
			rootStageId: pipeline.root,
			stageIds: [...pipeline.stages],
			edges: pipeline.edges.map((edge) => ({
				id: edge.name,
				name: edge.name,
				from: edge.from,
				to: edge.to,
				fork: edge.fork,
				mode: edge.mode ?? null,
				foreach: edge.foreach ?? null,
				input: edge.input ?? null,
				outputSchema: edge.outputSchema ?? null,
				outputSchemaDescription: edge.outputSchemaDescription ?? null,
				route: edge.route
					? {
							key: edge.route.key,
							default: edge.route.default,
						}
					: null,
			})),
			groups: pipeline.groups.map((group) => ({
				id: group.id,
				name: group.name,
				leader: group.leader,
				members: [...group.members],
			})),
		};
	};
	const pipelines = {
		full: buildPipeline("full"),
		delta: buildPipeline("delta"),
	};
	validatePipelineTopology("full", pipelines.full, allStageIds);
	validatePipelineTopology("delta", pipelines.delta, allStageIds);
	validateDefinitionsSchemaReferences(stages, pipelines, parsed.schemas);
	validateDefinitionsEdgeTransformExpressions(stages, pipelines, parsed.schemas);

	return {
		pipelineIds: SCAN_PIPELINE_IDS,
		schemas: parsed.schemas,
		stageIds,
		stages,
		stageMetadata: Object.fromEntries(
			stages.map((stage) => [stage.key, { id: stage.id, name: stage.name }]),
		),
		stageMetadataById: Object.fromEntries(
			stages.map((stage) => [
				stage.id,
				{ key: stage.key, id: stage.id, name: stage.name },
			]),
		),
		stageSettings: Object.fromEntries(
			stages.map((stage) => [
				toObjectKey(stage.id),
				{
					stageName: stage.id,
					label: stage.name,
					role: stage.role,
					group: stage.group,
					concurrency: stage.concurrency,
					maxConcurrency: stage.maxConcurrency ?? 128,
					disableable: stage.disableable,
					description: stage.description ?? stage.name,
					inputSchema: stage.inputSchema,
					outputSchema: stage.outputSchema,
					runtimeConfig: stage.runtimeConfig,
				},
			]),
		),
		pipelines,
	};
};

export const parseScanPipelineDefinitionsFromYaml = (rawYaml: string) =>
	parseScanPipelineDefinitionsSource(parseYaml(rawYaml));

export const loadScanPipelineDefinitions = () =>
	parseScanPipelineDefinitionsSource(readScanPipelineDefinitionsSource());

export const SCAN_PIPELINE_DEFINITIONS = loadScanPipelineDefinitions();

export type StageRuntimeConfigDeps = {
	loadScanJobPipelineDefinitionSnapshot: (
		scanJobId: string,
	) => Promise<ScanPipelineDefinitions>;
};

export const resolvePromptFileContent = (promptFile: string) => {
	const fileName = basename(promptFile);
	if (fileName !== promptFile) {
		throw new Error(`Invalid prompt file name: ${promptFile}`);
	}
	for (const promptDir of ["stages", "prompts"]) {
		try {
			return readFileSync(
				join(dirname(SCAN_PIPELINE_DEFINITIONS_DIR), "..", promptDir, fileName),
				"utf-8",
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw error;
			}
		}
	}
	throw new Error(`Prompt file not found: ${promptFile}`);
};

export const createStageRuntimeConfigWithDeps = (input: {
	scanJobId: string;
	stageName: string;
	loadScanJobPipelineDefinitionSnapshot: StageRuntimeConfigDeps["loadScanJobPipelineDefinitionSnapshot"];
}) => {
	const loadStage = async () => {
		const definitions = await input.loadScanJobPipelineDefinitionSnapshot(
			input.scanJobId,
		);
		const stage = definitions.stages.find((item) => item.id === input.stageName);
		if (!stage) {
			throw new Error(
				`Stage ${input.stageName} not found in scan job pipeline definition snapshot`,
			);
		}
		return stage;
	};
	const loadRuntimeConfig = async () => (await loadStage()).runtimeConfig;
	return {
		getConcurrency: async () => (await loadStage()).concurrency,
		getAgentProfile: async () =>
			(await loadRuntimeConfig())?.agentProfile ?? null,
		getPersistent: async () => (await loadRuntimeConfig())?.persistent ?? null,
		getReuseContainer: async () =>
			(await loadRuntimeConfig())?.reuseContainer ?? null,
		getMode: async () => (await loadRuntimeConfig())?.mode ?? null,
		getNullableOutput: async () =>
			(await loadRuntimeConfig())?.nullableOutput ?? null,
		getCwd: async () => (await loadRuntimeConfig())?.cwd ?? null,
		getSkills: async () => (await loadRuntimeConfig())?.skills ?? [],
		getPrompt: async () => {
			const runtimeConfig = await loadRuntimeConfig();
			if (runtimeConfig?.prompt != null) {
				return runtimeConfig.prompt;
			}
			if (runtimeConfig?.promptFile) {
				return resolvePromptFileContent(runtimeConfig.promptFile);
			}
			return null;
		},
		getInputArtifacts: async () =>
			(await loadRuntimeConfig())?.inputArtifacts ?? null,
		getOutputSchema: async () =>
			(await loadRuntimeConfig())?.outputSchema ??
			(await loadStage()).outputSchema ??
			null,
	};
};

export const validatePipelineRegistryCoverage = (
	definitions: ScanPipelineDefinitions,
	registry: {
		stageIds: ReadonlySet<string>;
		edgeNames: ReadonlySet<string>;
	},
) => {
	for (const stageId of definitions.stageIds) {
		if (!registry.stageIds.has(stageId)) {
			throw new Error(`missing stage implementation: ${stageId}`);
		}
	}
	const edgeNames = new Set<string>();
	for (const pipeline of Object.values(definitions.pipelines)) {
		for (const edge of pipeline.edges) {
			edgeNames.add(edge.name);
		}
	}
	for (const edgeName of edgeNames) {
		if (!registry.edgeNames.has(edgeName)) {
			throw new Error(`missing edge implementation: ${edgeName}`);
		}
	}
};
