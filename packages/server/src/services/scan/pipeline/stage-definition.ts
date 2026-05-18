import type { Job, Queue } from "bullmq";
import type {
	PipelineContext,
	StageContext,
} from "../stages/full-scan-stage.runtime";

export type StageRunMode = "serial" | "fanout";

export type StageExecution<TInput> = {
	taskId: string;
	input: TInput;
};

export type StageRunResult =
	| {
			completion: "immediate";
			rawOutput: string;
	  }
	| {
			completion: "deferred";
			threadId?: string | null;
	  };

export type StageQueueBinding<
	TPipelineContext extends PipelineContext,
	TInput,
> = {
	queue: Queue<string>;
	poll: (ctx: TPipelineContext) => Promise<StageExecution<TInput> | undefined>;
	enqueue: (taskId: string) => Promise<void>;
};

type StageQueueBindingOptions<
	TPipelineContext extends PipelineContext,
	TInput,
> = {
	queue: Queue<string>;
	getInputId?: (jobData: string, jobId: string) => string | null;
	ownsInputId?: (
		ctx: TPipelineContext,
		inputId: string,
		jobData: string,
		jobId: string,
	) => Promise<boolean>;
	loadInput: (ctx: TPipelineContext, inputId: string) => Promise<TInput | undefined>;
};

export type StageDefinition<
	TPipelineContext extends PipelineContext,
	TInput,
	TOutput = void,
	TStageContext extends StageContext = StageContext,
> = {
	name: string;
	mode: StageRunMode;
	persistent?: boolean;
	queue?: StageQueueBinding<TPipelineContext, TInput>;
	validateInput?: (ctx: TStageContext, input: TInput) => Promise<boolean>;
	run: (
		ctx: TStageContext,
		input: TInput,
	) => Promise<StageRunResult>;
	validateOutput?: (
		ctx: TStageContext,
		input: TInput,
		rawOutput: string,
	) => Promise<TOutput>;
	getDesiredConcurrency?: (ctx: TPipelineContext) => Promise<number>;
	recoverQueue?: (ctx: TPipelineContext) => Promise<number>;
	onSuccess?: (
		ctx: TStageContext,
		input: TInput,
		output: TOutput,
	) => Promise<void>;
	onFailure?: (
		ctx: TStageContext,
		input: TInput,
		error: unknown,
	) => Promise<void>;
};

export const createStageDefinition = <
	TPipelineContext extends PipelineContext,
	TInput,
	TOutput = void,
	TStageContext extends StageContext = StageContext,
>(
	stage: StageDefinition<TPipelineContext, TInput, TOutput, TStageContext>,
): StageDefinition<TPipelineContext, TInput, TOutput, TStageContext> => ({
	...stage,
	persistent: stage.persistent ?? true,
});

export const isFanoutStage = <
	TPipelineContext extends PipelineContext,
	TInput,
	TOutput,
	TStageContext extends StageContext,
>(
	stage: StageDefinition<TPipelineContext, TInput, TOutput, TStageContext>,
) => stage.mode === "fanout";

const resolveJobInputId = <TPipelineContext extends PipelineContext, TInput>(
	binding: Pick<
		StageQueueBindingOptions<TPipelineContext, TInput>,
		"getInputId" | "queue"
	>,
	job: Job<string>,
) => {
	const rawJobData = typeof job.data === "string" ? job.data : "";
	return (
		binding.getInputId?.(rawJobData, String(job.id ?? "")) ??
		(typeof job.data === "string" ? job.data : null)
	);
};

const pollStageQueue = async <
	TPipelineContext extends PipelineContext,
	TInput,
>(
	binding: StageQueueBindingOptions<TPipelineContext, TInput>,
	ctx: TPipelineContext,
): Promise<StageExecution<TInput> | undefined> => {
	const jobs = await binding.queue.getJobs(["prioritized", "waiting"], 0, 25, true);
	for (const job of jobs) {
		const rawJobData = typeof job.data === "string" ? job.data : "";
		const jobId = String(job.id ?? "");
		const inputId = resolveJobInputId(binding, job);
		if (!inputId) {
			await job.remove().catch(() => {});
			console.log(
				"[scan-queue]",
				JSON.stringify({
					event: "poll.skipped_missing_input_id",
					scanJobId: ctx.scanJobId,
					queueName: binding.queue.name,
					jobId,
				}),
			);
			continue;
		}

		if (
			binding.ownsInputId &&
			!(await binding.ownsInputId(ctx, inputId, rawJobData, jobId))
		) {
			continue;
		}

		const input = await binding.loadInput(ctx, inputId);
		console.log(
			"[scan-queue]",
			JSON.stringify({
				event: input !== undefined ? "poll.loaded_input" : "poll.input_missing",
				scanJobId: ctx.scanJobId,
				queueName: binding.queue.name,
				jobId,
				inputId,
			}),
		);
		await job.remove().catch(() => {});
		if (input === undefined) {
			continue;
		}
		return {
			taskId: inputId,
			input,
		};
	}

	return undefined;
};

export const createStageQueueBinding = <
	TPipelineContext extends PipelineContext,
	TInput,
>(
	binding: StageQueueBindingOptions<TPipelineContext, TInput>,
): StageQueueBinding<TPipelineContext, TInput> => ({
	queue: binding.queue,
	poll: (ctx) => pollStageQueue(binding, ctx),
	enqueue: async (taskId) => {
		await binding.queue.add(binding.queue.name, taskId, {
			jobId: `${binding.queue.name}:${taskId}`,
			removeOnComplete: true,
			removeOnFail: true,
		});
	},
});
