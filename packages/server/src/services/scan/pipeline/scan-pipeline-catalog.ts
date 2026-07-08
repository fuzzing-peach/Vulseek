import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const SCAN_PIPELINE_IDS = {
	full: "full",
	delta: "delta",
} as const;

const stageRoleSchema = z.enum(["scan", "analysis", "verification"]);

const stageConfigSchema = z.object({
	key: z.string().min(1),
	name: z.string().min(1),
	role: stageRoleSchema,
	group: z.string().min(1),
	defaultConcurrency: z.number().int().min(1),
	maxConcurrency: z.number().int().min(1).optional(),
	disableable: z.boolean().default(true),
	description: z.string().optional(),
});

const edgeConfigSchema = z.object({
	name: z.string().min(1),
	from: z.string().min(1),
	to: z.string().min(1),
	fork: z.boolean().default(false),
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

const scanPipelineYamlSchema = z.object({
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
	defaultConcurrency: number;
	maxConcurrency: number | null;
	disableable: boolean;
	description: string | null;
};

export type ScanPipelineEdgeConfig = {
	id: string;
	name: string;
	from: string;
	to: string;
	fork: boolean;
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

export type ScanPipelineCatalog = {
	pipelineIds: typeof SCAN_PIPELINE_IDS;
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
			defaultConcurrency: number;
			maxConcurrency: number;
			disableable: boolean;
			description: string;
		}
	>;
	pipelines: Record<keyof typeof SCAN_PIPELINE_IDS, ScanPipelineConfig>;
};

export const SCAN_PIPELINES_YAML_URL = new URL(
	"./scan-pipelines.yaml",
	import.meta.url,
);

export const scanPipelineYamlUrlToPath = (
	url: URL | { href: string } | string,
) => fileURLToPath(typeof url === "string" ? url : url.href);

export const readScanPipelinesYaml = () =>
	readFileSync(scanPipelineYamlUrlToPath(SCAN_PIPELINES_YAML_URL), "utf-8");

const toObjectKey = (stageId: string) =>
	stageId.replace(/-([a-z])/g, (_match, char: string) => char.toUpperCase());

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

export const parseScanPipelineCatalogFromYaml = (
	rawYaml: string,
): ScanPipelineCatalog => {
	const parsed = scanPipelineYamlSchema.parse(parseYaml(rawYaml));
	const stageIds = Object.keys(parsed.stages);
	assertUnique(stageIds, "stage id");
	assertUnique(
		Object.values(parsed.stages).map((stage) => stage.key),
		"stage key",
	);

	const stages = Object.entries(parsed.stages).map(
		([id, stage]): ScanPipelineStageConfig => ({
			id,
			key: stage.key,
			name: stage.name,
			role: stage.role,
			group: stage.group,
			defaultConcurrency: stage.defaultConcurrency,
			maxConcurrency: stage.maxConcurrency ?? null,
			disableable: stage.disableable,
			description: stage.description ?? null,
		}),
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

	return {
		pipelineIds: SCAN_PIPELINE_IDS,
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
					defaultConcurrency: stage.defaultConcurrency,
					maxConcurrency: stage.maxConcurrency ?? 128,
					disableable: stage.disableable,
					description: stage.description ?? stage.name,
				},
			]),
		),
		pipelines,
	};
};

export const loadScanPipelineCatalog = () =>
	parseScanPipelineCatalogFromYaml(readScanPipelinesYaml());

export const SCAN_PIPELINE_CATALOG = loadScanPipelineCatalog();

export const validatePipelineRegistryCoverage = (
	catalog: ScanPipelineCatalog,
	registry: {
		stageIds: ReadonlySet<string>;
		edgeNames: ReadonlySet<string>;
	},
) => {
	for (const stageId of catalog.stageIds) {
		if (!registry.stageIds.has(stageId)) {
			throw new Error(`missing stage implementation: ${stageId}`);
		}
	}
	const edgeNames = new Set<string>();
	for (const pipeline of Object.values(catalog.pipelines)) {
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
