import { db } from "@vulseek/server/db";
import {
	candidateResultProjectionBackfills,
	tasks,
	vulnerabilityCandidates,
} from "@vulseek/server/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { readCandidateIdFromTaskInputArtifact } from "./task-artifact-resolver";
import {
	CANDIDATE_RESULT_STAGE_NAMES,
	upsertCandidateResultProjectionTx,
	validateCandidateResultOutput,
} from "./candidate-result-projection.repo";

const BACKFILL_ID = "v2";

type SkippedTask = {
	taskId: string;
	scanJobId: string;
	stageName: string;
	reason: string;
};

const updateBackfill = async (patch: {
	status?: "pending" | "running" | "completed";
	processedCount?: number;
	skippedCount?: number;
	skippedTasks?: SkippedTask[];
	errorMessage?: string | null;
	startedAt?: string | null;
	completedAt?: string | null;
}) => {
	await db
		.update(candidateResultProjectionBackfills)
		.set({ ...patch, updatedAt: new Date().toISOString() })
		.where(eq(candidateResultProjectionBackfills.backfillId, BACKFILL_ID));
};

export const backfillCandidateResultProjections = async () => {
	await db
		.insert(candidateResultProjectionBackfills)
		.values({
			backfillId: BACKFILL_ID,
			status: "pending",
			updatedAt: new Date().toISOString(),
		})
		.onConflictDoNothing();
	const marker = await db
		.select()
		.from(candidateResultProjectionBackfills)
		.where(eq(candidateResultProjectionBackfills.backfillId, BACKFILL_ID))
		.limit(1)
		.then((rows) => rows[0] || null);
	if (marker?.status === "completed") {
		return {
			processedCount: marker.processedCount,
			skippedCount: marker.skippedCount,
			skippedTasks: marker.skippedTasks,
		};
	}
	if (!marker) {
		throw new Error(
			`Candidate result projection backfill ${BACKFILL_ID} is missing`,
		);
	}

	const startedAt = new Date().toISOString();
	await updateBackfill({
		status: "running",
		processedCount: 0,
		skippedCount: 0,
		skippedTasks: [],
		errorMessage: null,
		startedAt,
		completedAt: null,
	});

	let processedCount = 0;
	const skippedTasks: SkippedTask[] = [];
	const skipTask = (task: SkippedTask) => {
		skippedTasks.push(task);
		console.warn("Skipping candidate result projection task", task);
	};
	try {
		const historicalTasks = await db
			.select()
			.from(tasks)
			.where(
				and(
					inArray(tasks.stageName, [...CANDIDATE_RESULT_STAGE_NAMES]),
					inArray(tasks.status, [
						"completed",
						"failed",
						"exited",
					]),
				),
			)
			.orderBy(tasks.createdAt);

		for (const task of historicalTasks) {
			if (!validateCandidateResultOutput(task.stageName, task.output)) {
				skipTask({
					taskId: task.taskId,
					scanJobId: task.scanJobId,
					stageName: task.stageName,
					reason: "output is missing or does not match its schema",
				});
				continue;
			}

			const candidateId =
				task.vulnerabilityCandidateId ||
				(await readCandidateIdFromTaskInputArtifact(task));
			if (!candidateId) {
				skipTask({
					taskId: task.taskId,
					scanJobId: task.scanJobId,
					stageName: task.stageName,
					reason: "candidate artifact is missing or invalid",
				});
				continue;
			}

			const candidateExists = await db
				.select({ id: vulnerabilityCandidates.vulnerabilityCandidateId })
				.from(vulnerabilityCandidates)
				.where(
					and(
						eq(vulnerabilityCandidates.scanJobId, task.scanJobId),
						eq(vulnerabilityCandidates.vulnerabilityCandidateId, candidateId),
					),
				)
				.limit(1);
			if (!candidateExists[0]) {
				skipTask({
					taskId: task.taskId,
					scanJobId: task.scanJobId,
					stageName: task.stageName,
					reason: "candidate does not exist",
				});
				continue;
			}

			await db.transaction(async (tx) => {
				let currentTask = task;
				if (currentTask.vulnerabilityCandidateId !== candidateId) {
					const updated = await tx
						.update(tasks)
						.set({
							vulnerabilityCandidateId: candidateId,
							updatedAt: new Date().toISOString(),
						})
						.where(eq(tasks.taskId, task.taskId))
						.returning();
					if (updated[0]) {
						currentTask = updated[0];
					}
				}
				await upsertCandidateResultProjectionTx(tx, currentTask, candidateId);
			});
			processedCount += 1;
		}

		await updateBackfill({
			status: "completed",
			processedCount,
			skippedCount: skippedTasks.length,
			skippedTasks,
			completedAt: new Date().toISOString(),
		});
		if (skippedTasks.length > 0) {
			console.warn(
				`Candidate result projection backfill skipped ${skippedTasks.length} task(s)`,
			);
		}
		return {
			processedCount,
			skippedCount: skippedTasks.length,
			skippedTasks,
		};
	} catch (error) {
		try {
			await updateBackfill({
				status: "pending",
				processedCount,
				skippedCount: skippedTasks.length,
				skippedTasks,
				errorMessage: error instanceof Error ? error.message : String(error),
			});
		} catch {
			// Preserve the original database or migration error.
		}
		throw error;
	}
};
