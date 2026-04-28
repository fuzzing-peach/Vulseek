import type { Queue } from "bullmq";

export type StageRunMode = "serial" | "fanout";

export type StageQueueBinding<
	TContext,
	TInput extends { taskId: string },
> = {
	queue: Queue<string>;
	getInputId?: (jobData: string, jobId: string) => string | null;
	loadInput: (ctx: TContext, inputId: string) => Promise<TInput | null>;
	poll: (ctx: TContext) => Promise<TInput | null>;
	enqueue: (taskId: string) => Promise<void>;
};

export type StageDefinition<
	TContext,
	TInput extends { taskId: string },
	TOutput = void,
> = {
	name: string;
	mode: StageRunMode;
	queue?: StageQueueBinding<TContext, TInput>;
	validateInput?: (ctx: TContext, input: TInput) => Promise<boolean>;
	run: (
		ctx: TContext,
		input: TInput,
	) => Promise<string>;
	validateOutput?: (
		ctx: TContext,
		input: TInput,
		rawOutput: string,
	) => Promise<TOutput>;
	getDesiredConcurrency?: (ctx: TContext) => Promise<number>;
	recoverQueue?: (ctx: TContext) => Promise<number>;
	onSuccess?: (
		ctx: TContext,
		input: TInput,
		output: TOutput,
	) => Promise<void>;
	onFailure?: (
		ctx: TContext,
		input: TInput,
		error: unknown,
	) => Promise<void>;
};

export const isFanoutStage = <
	TContext,
	TInput extends { taskId: string },
	TOutput,
>(
	stage: StageDefinition<TContext, TInput, TOutput>,
) => stage.mode === "fanout";

const defaultPollStageQueueBinding = async <
	TContext,
	TInput extends { taskId: string },
>(
	queueBinding: Omit<StageQueueBinding<TContext, TInput>, "poll" | "enqueue">,
	ctx: TContext,
): Promise<TInput | null> => {
	const jobs = await queueBinding.queue.getJobs(["waiting"], 0, 9, true);
	if (jobs.length === 0) {
		return null;
	}

	const client = await queueBinding.queue.client;
	for (const job of jobs) {
		const claimed = await client.set(
			`scan:pipeline:claim:${queueBinding.queue.name}:${job.id}`,
			"1",
			"EX",
			60,
			"NX",
		);
		if (claimed !== "OK") {
			continue;
		}

		const rawJobData = typeof job.data === "string" ? job.data : "";
		const inputId =
			queueBinding.getInputId?.(rawJobData, String(job.id ?? "")) ??
			(typeof job.data === "string" ? job.data : null);
		if (!inputId) {
			await job.remove().catch(() => {});
			continue;
		}

		const input = await queueBinding.loadInput(ctx, inputId);
		await job.remove().catch(() => {});
		if (input) {
			return input;
		}
	}

	return null;
};

export const createStageQueueBinding = <
	TContext,
	TInput extends { taskId: string },
>(
	binding: Omit<StageQueueBinding<TContext, TInput>, "poll" | "enqueue">,
): StageQueueBinding<TContext, TInput> => ({
	...binding,
	poll: async (ctx) => await defaultPollStageQueueBinding(binding, ctx),
	enqueue: async (taskId) => {
		await binding.queue.add(binding.queue.name, taskId, {
			jobId: `${binding.queue.name}:${taskId}`,
			removeOnComplete: true,
			removeOnFail: true,
		});
	},
});
