import type { StageDefinition } from "./stage-definition";
import type {
	PipelineContext,
	StageContext,
} from "../stages/full-scan-stage.runtime";

export type PipelineStageName = string;

export type AnyStageDefinition<TPipelineContext extends PipelineContext> =
	StageDefinition<TPipelineContext, any, any, any>;

export type StageInputOf<TStage> =
	TStage extends StageDefinition<any, infer TInput, any, any> ? TInput : never;

export type StageOutputOf<TStage> =
	TStage extends StageDefinition<any, any, infer TOutput, any> ? TOutput : never;

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
	> = StageDefinition<
		TPipelineContext,
		TToStageInputObject,
		any,
		StageContext
	>,
> = {
	name: string;
	from: TFromStage;
	to: TToStage;
	fork?: boolean;
	transformOutput?: (input: {
		ctx: TPipelineContext;
		stageInput: StageInputOf<TFromStage>;
		stageOutput: StageOutputOf<TFromStage>;
	}) => Promise<TToStageInputObject[]>;
	createTasks?: (input: {
		ctx: TPipelineContext;
		fromTaskId: string;
		stageInput: StageInputOf<TFromStage>;
		stageOutput: StageOutputOf<TFromStage>;
		nextInputObjects: TToStageInputObject[];
	}) => Promise<string[]>;
};

export type PipelineDefinition<
	TPipelineContext extends PipelineContext,
	TStages extends readonly AnyStageDefinition<TPipelineContext>[] = readonly AnyStageDefinition<TPipelineContext>[],
	TEdges extends readonly PipelineEdge<
		TPipelineContext,
		TStages[number],
		any,
		TStages[number]
	>[] = readonly PipelineEdge<
		TPipelineContext,
		TStages[number],
		any,
		TStages[number]
	>[],
> = {
	name: string;
	stages: TStages;
	edges: TEdges;
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
	> = StageDefinition<
		TPipelineContext,
		TToStageInputObject,
		any,
		StageContext
	>,
>(
	edge: PipelineEdge<
		TPipelineContext,
		TFromStage,
		TToStageInputObject,
		TToStage
	>,
) => edge;

export const createPipelineDefinition = <
	TPipelineContext extends PipelineContext,
	TStages extends readonly AnyStageDefinition<TPipelineContext>[],
	TEdges extends readonly PipelineEdge<
		TPipelineContext,
		TStages[number],
		any,
		TStages[number]
	>[],
>(
	pipeline: {
		name: string;
		stages: TStages;
		edges: TEdges;
	},
): PipelineDefinition<TPipelineContext, TStages, TEdges> => pipeline;

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
		TStages[number]
	>[],
>(
	pipeline: PipelineDefinition<TPipelineContext, TStages, TEdges>,
	stageName: PipelineStageName,
) =>
	pipeline.edges.filter((edge) => edge.from.name === stageName);
