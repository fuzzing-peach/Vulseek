import {
	updateCandidateAnalysisTaskRepo,
} from "../persistence/analysis-result.repo";
import {
	updateScanFunctionTaskRepo,
} from "../persistence/scan-function-task.repo";
import {
	updateScanModuleTaskRepo,
} from "../persistence/scan-module-task.repo";
import {
	updateScanRepositoryTaskRepo,
} from "../persistence/scan-repository-task.repo";
import {
	updateCandidateVerificationTaskRepo,
} from "../persistence/verification-result.repo";
import {
	getDownstreamEdges,
	getPipelineStage,
	type PipelineDefinition,
} from "./pipeline-definition";
import {
	isFanoutStage,
	type StageDefinition,
} from "./stage-definition";

type PipelineRefreshContext = {
	refreshPipelineState?: () => Promise<void>;
};

const refreshPipelineState = async (ctx: unknown) => {
	await (ctx as PipelineRefreshContext).refreshPipelineState?.();
};

type TaskDefaultStatusBinding =
	| {
			kind: "repository";
			taskId: string;
	  }
	| {
			kind: "module";
			taskId: string;
	  }
	| {
			kind: "function";
			taskId: string;
	  }
	| {
			kind: "analysis";
			taskId: string;
	  }
	| {
			kind: "verification";
			taskId: string;
	  };

const taskDefaultUpdaters = {
	repository: updateScanRepositoryTaskRepo,
	module: updateScanModuleTaskRepo,
	function: updateScanFunctionTaskRepo,
	analysis: updateCandidateAnalysisTaskRepo,
	verification: updateCandidateVerificationTaskRepo,
} as const;

const getErrorMessage = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

const inferTaskDefaultBinding = (
	stageName: string,
	input: { taskId: string },
): TaskDefaultStatusBinding | null => {
	switch (stageName) {
		case "RepositoryScanningStage":
			return { kind: "repository", taskId: input.taskId };
		case "ModuleScanningStage":
			return { kind: "module", taskId: input.taskId };
		case "FunctionScanningStage":
			return { kind: "function", taskId: input.taskId };
		case "AnalysisStage":
			return { kind: "analysis", taskId: input.taskId };
		case "VerifyingStage":
			return { kind: "verification", taskId: input.taskId };
		default:
			return null;
	}
};

const updateTaskDefault = async (
	binding: TaskDefaultStatusBinding | null,
	patch: {
		status?: "running" | "completed" | "failed";
		errorMessage?: string;
		containerName?: string;
		result?: string;
	},
) => {
	if (!binding) {
		return;
	}

	const taskPatch = {
		...(patch.containerName ? { containerName: patch.containerName } : {}),
		...(patch.result !== undefined ? { result: patch.result } : {}),
		...(patch.status
			? {
					status: patch.status,
					errorMessage: patch.errorMessage,
					...(patch.status === "running"
						? {
								startedAt: new Date().toISOString(),
								completedAt: null,
						  }
						: {}),
					...(patch.status === "completed" || patch.status === "failed"
						? { completedAt: new Date().toISOString() }
						: {}),
			  }
			: {}),
	};
	await taskDefaultUpdaters[binding.kind](binding.taskId, taskPatch);
};

const pollStageInput = async <
	TContext,
	TInput extends { taskId: string },
>(
	stage: StageDefinition<TContext, TInput, unknown>,
	ctx: TContext,
): Promise<TInput | null> =>
	stage.queue ? await stage.queue.poll(ctx) : null;

const getStageConcurrencyLimit = async <TContext>(
	stage: StageDefinition<TContext, { taskId: string }, unknown>,
	ctx: TContext,
) =>
	isFanoutStage(stage)
		? Math.max(1, (await stage.getDesiredConcurrency?.(ctx)) || 1)
		: 1;

export const runPipeline = async <TContext>(
	pipeline: PipelineDefinition<TContext>,
	ctx: TContext,
) => {
	const stageNames = pipeline.stages.map((stage) => stage.name);
	if (stageNames.length === 0) {
		return;
	}

	await runPipelineWorkList(pipeline, ctx, stageNames);
};

export const runStageOnce = async <
	TContext,
	TInput extends { taskId: string },
	TOutput,
>(
	stage: StageDefinition<TContext, TInput, TOutput>,
	ctx: TContext,
	input: TInput,
): Promise<TOutput> => {
	const taskBinding = inferTaskDefaultBinding(stage.name, input);
	try {
		if (stage.validateInput) {
			const isValid = await stage.validateInput(ctx, input);
			if (!isValid) {
				throw new Error(
					`Stage ${stage.name} rejected input ${input.taskId}`,
				);
			}
		}

		await updateTaskDefault(taskBinding, { status: "running" });

		const rawOutput = await stage.run(ctx, input);
		await updateTaskDefault(taskBinding, { result: rawOutput });
		const output = await stage.validateOutput!(ctx, input, rawOutput);
		await stage.onSuccess?.(ctx, input, output);
		await updateTaskDefault(taskBinding, { status: "completed" });
		await refreshPipelineState(ctx);
		return output;
	} catch (error) {
		await updateTaskDefault(taskBinding, {
			status: "failed",
			errorMessage: getErrorMessage(error),
		}).catch(() => {});
		await refreshPipelineState(ctx).catch(() => {});
		await stage.onFailure?.(ctx, input, error);
		throw error;
	}
};

const runPipelineWorkList = async <TContext>(
	pipeline: PipelineDefinition<TContext>,
	ctx: TContext,
	initialStageNames: string[],
) => {
	const stageNames = [...initialStageNames];
	const activeCounts = new Map<string, number>();
	const running = new Set<Promise<void>>();

	const scheduleStageIfPossible = async (stageName: string) => {
		const stage = getPipelineStage(pipeline, stageName);
		if (!stage) {
			throw new Error(
				`Stage ${stageName} not found in pipeline ${pipeline.name}`,
			);
		}

		const limit = await getStageConcurrencyLimit(stage, ctx);
		let launchedAny = false;

		while ((activeCounts.get(stageName) || 0) < limit) {
			const input = await pollStageInput(stage, ctx);
			if (input == null) {
				break;
			}

			const activeCount = activeCounts.get(stageName) || 0;
			activeCounts.set(stageName, activeCount + 1);
			launchedAny = true;

			const task = (async () => {
				try {
					const output = await runStageOnce(stage, ctx, input);
					await enqueuePipelineDownstream(
						pipeline,
						stageName,
						ctx,
						input,
						output,
					);
				} finally {
					const nextActiveCount =
						Math.max(0, (activeCounts.get(stageName) || 1) - 1);
					activeCounts.set(stageName, nextActiveCount);
				}
			})().finally(() => {
				running.delete(task);
			});

			running.add(task);
		}

		return launchedAny;
	};

	while (stageNames.length > 0 || running.size > 0) {
		let dispatched = false;

		for (const stageName of stageNames) {
			const launched = await scheduleStageIfPossible(stageName);
			if (launched) {
				dispatched = true;
			}
		}

		if (running.size === 0) {
			break;
		}

		if (!dispatched) {
			await Promise.race(running);
		}
	}
};

const enqueuePipelineDownstream = async <
	TContext,
	TInput extends { taskId: string },
	TOutput,
>(
	pipeline: PipelineDefinition<TContext>,
	stageName: string,
	ctx: TContext,
	stageInput: TInput,
	stageOutput: TOutput,
) => {
	for (const edge of getDownstreamEdges(pipeline, stageName)) {
		const downstreamInputs = edge.transformOutput
			? await edge.transformOutput({
					ctx,
					stageInput,
					stageOutput,
				})
			: [];
		if (edge.createTasks) {
			const taskIds = await edge.createTasks({
				ctx,
				stageInput,
				stageOutput,
				nextInputObjects: downstreamInputs,
			});
			await refreshPipelineState(ctx);
			if (edge.to.queue) {
				for (const taskId of taskIds) {
					await edge.to.queue.enqueue(taskId);
				}
			}
		}
	}
};
