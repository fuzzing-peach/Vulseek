import type { ZodType } from "zod";
import type {
	PipelineContext,
	StageContext,
} from "../stages/full-scan-stage.runtime";
import type { StageDefinition } from "./stage-definition";

export type PipelineStageName = string;

export type AnyStageDefinition<TPipelineContext extends PipelineContext> =
	StageDefinition<TPipelineContext, any, any, any>;

export type StageInputOf<TStage> = TStage extends StageDefinition<
	any,
	infer TInput,
	any,
	any
>
	? TInput
	: never;

export type StageOutputOf<TStage> = TStage extends StageDefinition<
	any,
	any,
	infer TOutput,
	any
>
	? TOutput
	: never;

export type FirstStageOf<TStages extends readonly unknown[]> =
	TStages extends readonly [infer TFirst, ...unknown[]] ? TFirst : never;

export type FirstStageInputOf<TStages extends readonly unknown[]> =
	StageInputOf<FirstStageOf<TStages>>;

export type PipelineEdge<
	TPipelineContext extends PipelineContext,
	TFromStage extends AnyStageDefinition<TPipelineContext>,
	TToStageInputObject,
	TToStage extends StageDefinition<
		TPipelineContext,
		TToStageInputObject,
		any,
		StageContext
	> = StageDefinition<TPipelineContext, TToStageInputObject, any, StageContext>,
	TSelectedOutput = StageOutputOf<TFromStage>,
> = {
	name: string;
	from: TFromStage;
	to: TToStage;
	fork?: boolean;
	route?: {
		key: string;
		default?: boolean;
	};
	outputSchema?: ZodType<TSelectedOutput, any, any>;
	outputSchemaDescription?: string;
	transformOutput?: (input: {
		ctx: TPipelineContext;
		stageInput: StageInputOf<TFromStage>;
		stageOutput: TSelectedOutput;
	}) => Promise<TToStageInputObject[]>;
	createTasks?: (input: {
		ctx: TPipelineContext;
		fromTaskId: string;
		stageInput: StageInputOf<TFromStage>;
		stageOutput: TSelectedOutput;
		nextInputObjects: TToStageInputObject[];
	}) => Promise<string[]>;
};

export type PipelineStageGroup<
	TPipelineContext extends PipelineContext = PipelineContext,
> = {
	name: string;
	leader: AnyStageDefinition<TPipelineContext>;
	members: readonly AnyStageDefinition<TPipelineContext>[];
};

export type PipelineDefinition<
	TPipelineContext extends PipelineContext,
	TStages extends
		readonly AnyStageDefinition<TPipelineContext>[] = readonly AnyStageDefinition<TPipelineContext>[],
	TEdges extends readonly PipelineEdge<
		TPipelineContext,
		TStages[number],
		any,
		TStages[number],
		any
	>[] = readonly PipelineEdge<
		TPipelineContext,
		TStages[number],
		any,
		TStages[number],
		any
	>[],
> = {
	name: string;
	stages: TStages;
	edges: TEdges;
	groups?: readonly PipelineStageGroup<TPipelineContext>[];
};

export const createPipelineEdge = <
	TPipelineContext extends PipelineContext,
	TFromStage extends AnyStageDefinition<TPipelineContext>,
	TToStageInputObject,
	TToStage extends StageDefinition<
		TPipelineContext,
		TToStageInputObject,
		any,
		StageContext
	> = StageDefinition<TPipelineContext, TToStageInputObject, any, StageContext>,
	TSelectedOutput = StageOutputOf<TFromStage>,
>(
	edge: PipelineEdge<
		TPipelineContext,
		TFromStage,
		TToStageInputObject,
		TToStage,
		TSelectedOutput
	>,
) => edge;

export const createPipelineDefinition = <
	TPipelineContext extends PipelineContext,
	TStages extends readonly AnyStageDefinition<TPipelineContext>[],
	TEdges extends readonly PipelineEdge<
		TPipelineContext,
		TStages[number],
		any,
		TStages[number],
		any
	>[],
>(pipeline: {
	name: string;
	stages: TStages;
	edges: TEdges;
	groups?: readonly PipelineStageGroup<TPipelineContext>[];
}): PipelineDefinition<TPipelineContext, TStages, TEdges> => pipeline;

export const getPipelineStage = <TPipelineContext extends PipelineContext>(
	pipeline: PipelineDefinition<TPipelineContext>,
	stageName: PipelineStageName,
) => pipeline.stages.find((stage) => stage.name === stageName);

export const getDownstreamEdges = <
	TPipelineContext extends PipelineContext,
	TStages extends readonly AnyStageDefinition<TPipelineContext>[],
	TEdges extends readonly PipelineEdge<
		TPipelineContext,
		TStages[number],
		any,
		TStages[number],
		any
	>[],
>(
	pipeline: PipelineDefinition<TPipelineContext, TStages, TEdges>,
	stageName: PipelineStageName,
) => pipeline.edges.filter((edge) => edge.from.name === stageName);

export const getStageGroup = <TPipelineContext extends PipelineContext>(
	pipeline: PipelineDefinition<TPipelineContext>,
	stageName: PipelineStageName,
) =>
	pipeline.groups?.find(
		(group) =>
			group.leader.name === stageName ||
			group.members.some((stage) => stage.name === stageName),
	) || null;

export const getStageLeaderGroup = <TPipelineContext extends PipelineContext>(
	pipeline: PipelineDefinition<TPipelineContext>,
	stageName: PipelineStageName,
) => pipeline.groups?.find((group) => group.leader.name === stageName) || null;

export const isStageInGroup = <TPipelineContext extends PipelineContext>(
	group: PipelineStageGroup<TPipelineContext>,
	stageName: PipelineStageName,
) =>
	group.leader.name === stageName ||
	group.members.some((stage) => stage.name === stageName);

export const getStageRouteOutputSchemas = <
	TPipelineContext extends PipelineContext,
>(
	pipeline: PipelineDefinition<TPipelineContext>,
	stageName: PipelineStageName,
): StageContext["routeOutputSchemas"] => {
	const edges = getDownstreamEdges(pipeline, stageName);
	const routedEdges = edges.filter((edge) => edge.route && edge.outputSchema);
	if (routedEdges.length === 0) {
		return undefined;
	}
	return routedEdges.map((edge) => ({
		routeKey: edge.route!.key,
		description:
			edge.outputSchemaDescription ||
			`Output for route ${edge.route!.key} to ${edge.to.name}`,
		schema: edge.outputSchema!,
		default: edge.route?.default,
	}));
};

export const validatePipelineRouteConfiguration = <
	TPipelineContext extends PipelineContext,
>(
	pipeline: PipelineDefinition<TPipelineContext>,
) => {
	for (const stage of pipeline.stages) {
		const edges = getDownstreamEdges(pipeline, stage.name);
		if (!edges.some((edge) => edge.route)) {
			continue;
		}
		if (edges.some((edge) => !edge.route)) {
			throw new Error(
				`Stage ${stage.name} mixes routed and non-routed downstream edges`,
			);
		}
		const routeKeys = new Set<string>();
		for (const edge of edges) {
			if (routeKeys.has(edge.route!.key)) {
				throw new Error(
					`Duplicate route key ${edge.route!.key} for stage ${stage.name}`,
				);
			}
			routeKeys.add(edge.route!.key);
		}
		const defaultCount = edges.filter((edge) => edge.route?.default).length;
		if (defaultCount !== 1) {
			throw new Error(
				`Stage ${stage.name} must define exactly one default route`,
			);
		}
	}
};

export const selectDownstreamEdgesForRoute = <
	TPipelineContext extends PipelineContext,
>(
	pipeline: PipelineDefinition<TPipelineContext>,
	stageName: PipelineStageName,
	routeKey?: string | null,
) => {
	const downstreamEdges = getDownstreamEdges(pipeline, stageName);
	const hasRoutedEdges = downstreamEdges.some((edge) => edge.route);
	if (!hasRoutedEdges) {
		return {
			edges: downstreamEdges,
			selectedRouteKey: null,
			fallback: false,
		};
	}

	const routedEdges = downstreamEdges.filter((edge) => edge.route);
	const matched = routedEdges.find((edge) => edge.route?.key === routeKey);
	const fallback = routeKey == null
		? routedEdges.find((edge) => edge.route?.default)
		: undefined;
	const selected = matched || fallback;
	if (!selected) {
		throw new Error(
			routeKey == null
				? `No default route configured for stage ${stageName}`
				: `Invalid route key ${routeKey} for stage ${stageName}`,
		);
	}

	return {
		edges: [selected],
		selectedRouteKey: selected.route?.key ?? null,
		fallback: !matched,
	};
};
