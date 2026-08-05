import {
	cancelScanJob,
	createScanJob,
	findScanJobById,
	runDatasetPromptHook,
	runDatasetScriptHook,
	createJsonSchemaContract,
	validateJsonSchemaContract,
	resolveDatasetSampleHostPath,
} from "@vulseek/server";
import {
	datasetEvaluations,
	datasetEvaluationTrials,
	datasetProfiles,
	datasetSamples,
	datasets,
	datasetHookSchema,
	scanJobs,
} from "@vulseek/server/db/schema";
import { Job, Worker } from "bullmq";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/server/db";
import { datasetEvaluationQueue } from "./queueSetup";
import type { DatasetEvaluationQueueJob } from "./queue-types";
import { redisConfig } from "./redis-connection";

const TERMINAL_SCAN_STATUSES = new Set([
	"finished",
	"partially_finished",
	"failed",
	"canceled",
]);
const activeEvaluations = new Set<string>();

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const parseHookOutput = (raw: string) => {
	const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		try {
			return JSON.parse(lines[index] as string) as unknown;
		} catch {}
	}
	throw new Error("Dataset hook must print a JSON result as its final non-empty line");
};

const normalizeHookResult = (raw: string, schema: Record<string, unknown>) => {
	const parsed = parseHookOutput(raw);
	const envelope = parsed && typeof parsed === "object" && !Array.isArray(parsed) && "output" in parsed
		? parsed as { route?: unknown; output?: unknown }
		: { route: null, output: parsed };
	const output = envelope.output;
	const contract = createJsonSchemaContract({
		schemas: {},
		schema: Object.keys(schema).length > 0 ? schema : { type: "object", additionalProperties: true },
	});
	validateJsonSchemaContract(contract, output);
	return { route: envelope.route ?? null, output };
};

const getEvaluation = async (evaluationId: string) =>
	await db
		.select({ evaluation: datasetEvaluations, dataset: datasets, profile: datasetProfiles })
		.from(datasetEvaluations)
		.innerJoin(datasets, eq(datasetEvaluations.datasetId, datasets.datasetId))
		.innerJoin(datasetProfiles, eq(datasetEvaluations.profileId, datasetProfiles.profileId))
		.where(eq(datasetEvaluations.evaluationId, evaluationId))
		.limit(1)
		.then((rows) => rows[0] ?? null);

const getProfileHookConfig = (input: NonNullable<Awaited<ReturnType<typeof getEvaluation>>>) => {
	const snapshot = input.profile.configSnapshot;
	const values = snapshot && typeof snapshot === "object" ? snapshot : {};
	const get = (key: string, fallback: unknown) =>
		key in values ? values[key as keyof typeof values] : fallback;
	return {
		postScanHook: datasetHookSchema.parse(get("postScanHook", { type: "none" })),
		postScanSchema: (get("postScanSchema", {}) ?? {}) as Record<string, unknown>,
		postEvaluationHook: datasetHookSchema.parse(get("postEvaluationHook", { type: "none" })),
		postEvaluationSchema: (get("postEvaluationSchema", {}) ?? {}) as Record<string, unknown>,
	};
};

const getCurrentTrial = async (evaluationId: string) =>
	await db
		.select({ trial: datasetEvaluationTrials, sample: datasetSamples })
		.from(datasetEvaluationTrials)
		.innerJoin(datasetSamples, eq(datasetEvaluationTrials.sampleId, datasetSamples.sampleId))
		.where(and(
			eq(datasetEvaluationTrials.evaluationId, evaluationId),
			inArray(datasetEvaluationTrials.status, ["preparing", "running", "post_processing"]),
		))
		.orderBy(asc(datasetEvaluationTrials.ordinal))
		.limit(1)
		.then((rows) => rows[0] ?? null);

const claimNextTrial = async (evaluationId: string) => {
	const pending = await db
		.select({ trial: datasetEvaluationTrials, sample: datasetSamples })
		.from(datasetEvaluationTrials)
		.innerJoin(datasetSamples, eq(datasetEvaluationTrials.sampleId, datasetSamples.sampleId))
		.where(and(eq(datasetEvaluationTrials.evaluationId, evaluationId), eq(datasetEvaluationTrials.status, "pending")))
		.orderBy(asc(datasetEvaluationTrials.ordinal))
		.limit(1)
		.then((rows) => rows[0] ?? null);
	if (!pending) return null;
	const claimed = await db
		.update(datasetEvaluationTrials)
		.set({ status: "preparing", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
		.where(and(eq(datasetEvaluationTrials.trialId, pending.trial.trialId), eq(datasetEvaluationTrials.status, "pending")))
		.returning({ trialId: datasetEvaluationTrials.trialId });
	return claimed[0] ? pending : null;
};

const finishTrial = async (input: {
	trialId: string;
	scanJobId: string;
	status: "completed" | "scan_failed" | "timed_out" | "canceled" | "postprocess_failed";
	scanJob: Awaited<ReturnType<typeof findScanJobById>>;
	postScanResult?: unknown;
	errorMessage?: string | null;
	}) => {
	const startedAt = input.scanJob.startedAt ? Date.parse(input.scanJob.startedAt) : Date.now();
	const finishedAt = input.scanJob.finishedAt ? Date.parse(input.scanJob.finishedAt) : Date.now();
	await db.update(datasetEvaluationTrials).set({
		status: input.status,
		scanJobId: input.scanJobId,
		postScanStatus: input.postScanResult === undefined ? (input.status === "postprocess_failed" ? "failed" : "skipped") : "completed",
		postScanResult: input.postScanResult ?? null,
		durationMs: Math.max(0, finishedAt - startedAt),
		inputTokens: input.scanJob.inputTokens,
		outputTokens: input.scanJob.outputTokens,
		thoughtTokens: input.scanJob.thoughtTokens,
		totalTokens: input.scanJob.totalTokens,
		estimatedCost: input.scanJob.estimatedCost ?? 0,
		result: { scanJobId: input.scanJobId, scanStatus: input.scanJob.status },
		errorMessage: input.errorMessage ?? input.scanJob.errorMessage,
		finishedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	}).where(eq(datasetEvaluationTrials.trialId, input.trialId));
};

const waitForScan = async (scanJobId: string, evaluationId: string, budgetSeconds: number | null) => {
	const startedAt = Date.now();
	let pausedAt: number | null = null;
	let pausedDurationMs = 0;
	while (true) {
		const evaluation = await db.select({ status: datasetEvaluations.status }).from(datasetEvaluations).where(eq(datasetEvaluations.evaluationId, evaluationId)).limit(1).then((rows) => rows[0]);
		if (!evaluation || evaluation.status === "canceled") {
			await cancelScanJob(scanJobId).catch(() => {});
			return { scanJob: await findScanJobById(scanJobId), timedOut: false };
		}
		if (evaluation.status === "paused") {
			pausedAt ??= Date.now();
			await sleep(1000);
			continue;
		}
		if (pausedAt !== null) {
			pausedDurationMs += Date.now() - pausedAt;
			pausedAt = null;
		}
		const scanJob = await findScanJobById(scanJobId);
		if (TERMINAL_SCAN_STATUSES.has(scanJob.status)) return { scanJob, timedOut: false };
		if (budgetSeconds && Date.now() - startedAt - pausedDurationMs >= budgetSeconds * 1000) {
			await cancelScanJob(scanJobId).catch(() => {});
			return { scanJob: await findScanJobById(scanJobId), timedOut: true };
		}
		await sleep(2000);
	}
};

const processTrial = async (input: {
	evaluation: NonNullable<Awaited<ReturnType<typeof getEvaluation>>>;
	trial: typeof datasetEvaluationTrials.$inferSelect;
	sample: typeof datasetSamples.$inferSelect;
}) => {
	let scanJobId = input.trial.scanJobId;
	if (!scanJobId) {
		const existing = await db
			.select({ scanJobId: scanJobs.scanJobId })
			.from(scanJobs)
			.where(eq(scanJobs.datasetEvaluationTrialId, input.trial.trialId))
			.limit(1)
			.then((rows) => rows[0]);
		if (existing) {
			scanJobId = existing.scanJobId;
		} else {
			const scanJob = await createScanJob({
				datasetEvaluationTrialId: input.trial.trialId,
				scanType: input.evaluation.evaluation.pipelineId as "full" | "research" | "tob-goal",
				title: `${input.evaluation.evaluation.name}: ${input.sample.title || input.sample.sampleKey}`,
				description: `Dataset evaluation trial ${input.trial.trialId}`,
				triggerSource: "manual",
				datasetSampleInput: input.sample.scannerInput,
				scanRuntimeSettings: input.evaluation.evaluation.scanRuntimeSettings,
				scanPipelineDefinitionSnapshot: input.evaluation.evaluation.scanPipelineDefinitionSnapshot,
			});
			scanJobId = scanJob.scanJobId;
		}
		await db.update(datasetEvaluationTrials).set({ scanJobId, status: "running", updatedAt: new Date().toISOString() }).where(and(eq(datasetEvaluationTrials.trialId, input.trial.trialId), eq(datasetEvaluationTrials.status, "preparing")));
	}
	await import("./queueSetup").then(({ scansQueue }) => scansQueue.add("dataset-trial-scan", { scanJobId: scanJobId as string, mode: input.evaluation.evaluation.pipelineId }, { jobId: `dataset-trial-${scanJobId}`, removeOnComplete: 100, removeOnFail: 100 }));
	const outcome = await waitForScan(scanJobId, input.evaluation.evaluation.evaluationId, input.evaluation.evaluation.timeBudgetSeconds);
	const scanJob = outcome.scanJob;
	const hookConfig = getProfileHookConfig(input.evaluation);
	const sampleHostPath = await resolveDatasetSampleHostPath(input.sample.sampleId);
	if ((hookConfig.postScanHook.type === "script" || hookConfig.postScanHook.type === "prompt") && scanJob.status !== "canceled") {
		await db.update(datasetEvaluationTrials).set({ status: "post_processing", postScanStatus: "running", updatedAt: new Date().toISOString() }).where(eq(datasetEvaluationTrials.trialId, input.trial.trialId));
		try {
			const hookInput = {
				evaluationId: input.evaluation.evaluation.evaluationId,
				trialId: input.trial.trialId,
				scanJobId,
				scanStatus: scanJob.status,
			};
			const postScanResult = hookConfig.postScanHook.type === "prompt"
				? await runDatasetPromptHook({
						prompt: hookConfig.postScanHook.prompt,
						agentProfileId: hookConfig.postScanHook.agentProfileId,
						organizationId: input.evaluation.dataset.organizationId,
						profileHostRoot: input.evaluation.profile.hostRoot,
						workspaceHostPath: sampleHostPath,
						image: input.evaluation.profile.checkoutImage || "",
						timeoutSeconds: hookConfig.postScanHook.timeoutSeconds,
						cancellationKey: input.evaluation.evaluation.evaluationId,
						input: hookInput,
						schema: hookConfig.postScanSchema,
					})
				: normalizeHookResult(await runDatasetScriptHook({
						command: hookConfig.postScanHook.command,
						sampleHostPath,
						profileHostRoot: input.evaluation.profile.hostRoot,
						image: input.evaluation.profile.checkoutImage || "",
						timeoutSeconds: hookConfig.postScanHook.timeoutSeconds,
						cancellationKey: input.evaluation.evaluation.evaluationId,
						input: hookInput,
					}), hookConfig.postScanSchema);
			await finishTrial({ trialId: input.trial.trialId, scanJobId, status: outcome.timedOut ? "timed_out" : scanJob.status === "finished" || scanJob.status === "partially_finished" ? "completed" : "scan_failed", scanJob, postScanResult });
			return;
		} catch (error) {
			const status = await db.select({ status: datasetEvaluations.status }).from(datasetEvaluations).where(eq(datasetEvaluations.evaluationId, input.evaluation.evaluation.evaluationId)).limit(1).then((rows) => rows[0]?.status);
			if (status === "paused") {
				await db.update(datasetEvaluationTrials).set({ status: "post_processing", postScanStatus: "pending", errorMessage: null, updatedAt: new Date().toISOString() }).where(eq(datasetEvaluationTrials.trialId, input.trial.trialId));
				return;
			}
			if (status === "canceled") return;
			await finishTrial({ trialId: input.trial.trialId, scanJobId, status: "postprocess_failed", scanJob, errorMessage: error instanceof Error ? error.message : String(error) });
			return;
		}
	}
	await finishTrial({
		trialId: input.trial.trialId,
		scanJobId,
		status: outcome.timedOut ? "timed_out" : scanJob.status === "canceled" ? "canceled" : scanJob.status === "finished" || scanJob.status === "partially_finished" ? "completed" : "scan_failed",
		scanJob,
	});
};

export const runDatasetEvaluation = async (evaluationId: string) => {
	if (activeEvaluations.has(evaluationId)) return;
	activeEvaluations.add(evaluationId);
	try {
		const initial = await getEvaluation(evaluationId);
		if (
			!initial ||
			["canceled", "paused", "completed", "completed_with_errors", "failed"].includes(initial.evaluation.status)
		) return;
		await db.update(datasetEvaluations).set({ status: "running", startedAt: initial.evaluation.startedAt || new Date().toISOString(), errorMessage: null, updatedAt: new Date().toISOString() }).where(eq(datasetEvaluations.evaluationId, evaluationId));
		while (true) {
			const current = await getEvaluation(evaluationId);
			if (!current || current.evaluation.status === "canceled") return;
			if (current.evaluation.status === "paused") {
				await sleep(1000);
				continue;
			}
			const active = await getCurrentTrial(evaluationId);
			const claimed = active || await claimNextTrial(evaluationId);
			if (!claimed) break;
			const stateBeforeLaunch = await getEvaluation(evaluationId);
			if (stateBeforeLaunch?.evaluation.status === "paused" && !active) {
				await db.update(datasetEvaluationTrials).set({ status: "pending", startedAt: null, updatedAt: new Date().toISOString() }).where(and(eq(datasetEvaluationTrials.trialId, claimed.trial.trialId), eq(datasetEvaluationTrials.status, "preparing")));
				continue;
			}
			await processTrial({ evaluation: current, trial: claimed.trial, sample: claimed.sample });
		}
		const finalEvaluation = await getEvaluation(evaluationId);
		if (!finalEvaluation || finalEvaluation.evaluation.status === "canceled") return;
		const trialRows = await db.select().from(datasetEvaluationTrials).where(eq(datasetEvaluationTrials.evaluationId, evaluationId)).orderBy(asc(datasetEvaluationTrials.ordinal));
		const aggregate = {
			evaluationId,
			status: finalEvaluation.evaluation.status,
			trials: trialRows.map((trial) => ({ trialId: trial.trialId, sampleId: trial.sampleId, repetition: trial.repetition, status: trial.status, durationMs: trial.durationMs, totalTokens: trial.totalTokens, estimatedCost: trial.estimatedCost, result: trial.result })),
			totals: trialRows.reduce((totals, trial) => ({ totalTokens: totals.totalTokens + trial.totalTokens, estimatedCost: totals.estimatedCost + trial.estimatedCost, durationMs: totals.durationMs + (trial.durationMs ?? 0) }), { totalTokens: 0, estimatedCost: 0, durationMs: 0 }),
		};
		const completedWithErrors = trialRows.some((row) => row.status !== "completed");
		const hookConfig = getProfileHookConfig(finalEvaluation);
		let postEvaluationStatus: "completed" | "failed" | "skipped" = "skipped";
		let postEvaluationResult: unknown = null;
		if (hookConfig.postEvaluationHook.type === "script" || hookConfig.postEvaluationHook.type === "prompt") {
			await db.update(datasetEvaluations).set({ status: "finalizing", postEvaluationStatus: "running", updatedAt: new Date().toISOString() }).where(eq(datasetEvaluations.evaluationId, evaluationId));
			try {
				postEvaluationResult = hookConfig.postEvaluationHook.type === "prompt"
					? await runDatasetPromptHook({
							prompt: hookConfig.postEvaluationHook.prompt,
							agentProfileId: hookConfig.postEvaluationHook.agentProfileId,
							organizationId: finalEvaluation.dataset.organizationId,
							profileHostRoot: finalEvaluation.profile.hostRoot,
							image: finalEvaluation.profile.checkoutImage || "",
							timeoutSeconds: hookConfig.postEvaluationHook.timeoutSeconds,
							cancellationKey: evaluationId,
							input: aggregate,
							schema: hookConfig.postEvaluationSchema,
						})
					: normalizeHookResult(await runDatasetScriptHook({
							command: hookConfig.postEvaluationHook.command,
							profileHostRoot: finalEvaluation.profile.hostRoot,
							image: finalEvaluation.profile.checkoutImage || "",
							timeoutSeconds: hookConfig.postEvaluationHook.timeoutSeconds,
							cancellationKey: evaluationId,
							input: aggregate,
						}), hookConfig.postEvaluationSchema);
				postEvaluationStatus = "completed";
			} catch (error) {
				postEvaluationStatus = "failed";
				const evaluationStatus = await db.select({ status: datasetEvaluations.status }).from(datasetEvaluations).where(eq(datasetEvaluations.evaluationId, evaluationId)).limit(1).then((rows) => rows[0]?.status);
				if (evaluationStatus === "paused" || evaluationStatus === "canceled") {
					if (evaluationStatus === "paused") {
						await db.update(datasetEvaluations).set({ status: "paused", postEvaluationStatus: "pending", errorMessage: null, updatedAt: new Date().toISOString() }).where(eq(datasetEvaluations.evaluationId, evaluationId));
					}
					return;
				}
				await db.update(datasetEvaluations).set({ status: "failed", postEvaluationStatus, errorMessage: (error instanceof Error ? error.message : String(error)).slice(0, 4000), finishedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).where(eq(datasetEvaluations.evaluationId, evaluationId));
				return;
			}
		}
		await db.update(datasetEvaluations).set({ status: completedWithErrors ? "completed_with_errors" : "completed", postEvaluationStatus, postEvaluationResult, finishedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).where(eq(datasetEvaluations.evaluationId, evaluationId));
	} catch (error) {
		await db.update(datasetEvaluations).set({ status: "failed", errorMessage: (error instanceof Error ? error.message : String(error)).slice(0, 4000), finishedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).where(eq(datasetEvaluations.evaluationId, evaluationId)).catch(() => {});
		throw error;
	} finally {
		activeEvaluations.delete(evaluationId);
	}
};

export const recoverPendingDatasetEvaluations = async () => {
	const rows = await db.select({ evaluationId: datasetEvaluations.evaluationId }).from(datasetEvaluations).where(inArray(datasetEvaluations.status, ["pending", "running", "finalizing"]));
	for (const row of rows) {
		await datasetEvaluationQueue.add("dataset-evaluation-recovery", { evaluationId: row.evaluationId }, { jobId: `recovery-${row.evaluationId}`, removeOnComplete: 100, removeOnFail: 100 }).catch(() => {});
	}
};

export const datasetEvaluationsWorker = new Worker<DatasetEvaluationQueueJob>(
	"dataset-evaluations",
	async (job: Job<DatasetEvaluationQueueJob>) => {
		await runDatasetEvaluation(job.data.evaluationId);
	},
	{ autorun: false, connection: redisConfig, concurrency: 1 },
);
