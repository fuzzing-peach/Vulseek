import type { StageDefinition } from "./stage-definition";

export type PipelineStageName = string;

export type AnyStageDefinition<TContext> = StageDefinition<TContext, any, any>;

export type StageInputOf<TStage> =
	TStage extends StageDefinition<any, infer TInput, any> ? TInput : never;

export type StageOutputOf<TStage> =
	TStage extends StageDefinition<any, any, infer TOutput> ? TOutput : never;

export type WithTaskId<T> = T & { taskId: string };
export type WithoutTaskId<T> = Omit<T, "taskId">;

export type PipelineEdge<
	TContext,
	TFromStage extends AnyStageDefinition<TContext>,
	TToStageInputObject,
	TToStage extends StageDefinition<
		TContext,
		WithTaskId<TToStageInputObject>,
		any
	> = StageDefinition<TContext, WithTaskId<TToStageInputObject>, any>,
> = {
	from: TFromStage;
	to: TToStage;
	transformOutput?: (input: {
		ctx: TContext;
		stageInput: StageInputOf<TFromStage>;
		stageOutput: StageOutputOf<TFromStage>;
	}) => Promise<TToStageInputObject[]>;
	createTasks?: (input: {
		ctx: TContext;
		stageInput: StageInputOf<TFromStage>;
		stageOutput: StageOutputOf<TFromStage>;
		nextInputObjects: TToStageInputObject[];
	}) => Promise<string[]>;
};

export type PipelineDefinition<
	TPipelineContext,
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
	TContext,
	TFromStage extends AnyStageDefinition<TContext>,
	TToStageInputObject,
	TToStage extends StageDefinition<
		TContext,
		WithTaskId<TToStageInputObject>,
		any
	> = StageDefinition<TContext, WithTaskId<TToStageInputObject>, any>,
>(
	edge: PipelineEdge<TContext, TFromStage, TToStageInputObject, TToStage>,
) => edge;

export const createPipelineDefinition = <
	TPipelineContext,
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

export const getPipelineStage = <TPipelineContext>(
	pipeline: PipelineDefinition<TPipelineContext>,
	stageName: PipelineStageName,
) => pipeline.stages.find((stage) => stage.name === stageName);

export const getDownstreamEdges = <
	TPipelineContext,
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
