import {
	apiCreateDataset,
	apiCreateDatasetEvaluation,
	apiCreateDatasetProfile,
	apiDatasetEvaluationId,
	apiDatasetId,
	apiDatasetProfileId,
	apiListDatasetSamples,
	apiUpdateDataset,
	datasetEvaluations,
	datasetEvaluationTrials,
	datasetProfiles,
	datasetSamples,
	datasets,
	} from "@vulseek/server/db/schema";
import {
	cancelScanJob,
	cancelDatasetHookRuns,
	getScanPipelineDefinitions,
	pauseScanJob,
	prepareDatasetProfile,
	pruneDatasetProfile,
	resolveDatasetHostRoot,
	resumeScanJob,
} from "@vulseek/server";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import { createTRPCRouter, protectedProcedure } from "@/server/api/trpc";
import { db } from "@/server/db";
import { datasetEvaluationQueue } from "@/server/queues/queueSetup";

const isDatasetManager = (role: string) => role === "owner" || role === "admin";

const requireDatasetManager = (role: string) => {
	if (!isDatasetManager(role)) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "Only organization owners and admins can manage datasets",
		});
	}
};

const findDataset = async (datasetId: string, organizationId: string) => {
	const dataset = await db
		.select()
		.from(datasets)
		.where(and(eq(datasets.datasetId, datasetId), eq(datasets.organizationId, organizationId)))
		.limit(1)
		.then((rows) => rows[0]);
	if (!dataset) throw new TRPCError({ code: "NOT_FOUND", message: "Dataset not found" });
	return dataset;
};

const profileSummary = (profile: typeof datasetProfiles.$inferSelect) => ({
	profileId: profile.profileId,
	datasetId: profile.datasetId,
	profileKey: profile.profileKey,
	status: profile.status,
	sourceDigest: profile.sourceDigest,
	checkoutImage: profile.checkoutImage,
	checkoutImageDigest: profile.checkoutImageDigest,
	postCheckoutStatus: profile.postCheckoutStatus,
	postCheckoutLog: profile.postCheckoutLog,
	errorMessage: profile.errorMessage,
	createdAt: profile.createdAt,
	updatedAt: profile.updatedAt,
	hostRootSummary: profile.hostRoot.split(/[\\/]/).filter(Boolean).slice(-2).join("/"),
});

export const datasetRouter = createTRPCRouter({
	all: protectedProcedure.query(async ({ ctx }) => {
		const rows = await db
			.select()
			.from(datasets)
			.where(eq(datasets.organizationId, ctx.session.activeOrganizationId))
			.orderBy(desc(datasets.createdAt));
		if (rows.length === 0) return [];
		const datasetIds = rows.map((row) => row.datasetId);
		const [profiles, evaluations] = await Promise.all([
			db.select().from(datasetProfiles).where(inArray(datasetProfiles.datasetId, datasetIds)).orderBy(desc(datasetProfiles.createdAt)),
			db.select().from(datasetEvaluations).where(inArray(datasetEvaluations.datasetId, datasetIds)).orderBy(desc(datasetEvaluations.createdAt)),
		]);
		const sampleCounts = profiles.length
			? await db.select({ profileId: datasetSamples.profileId, count: sql<number>`count(*)` }).from(datasetSamples).where(inArray(datasetSamples.profileId, profiles.map((profile) => profile.profileId))).groupBy(datasetSamples.profileId)
			: [];
		const sampleCountByProfile = new Map(sampleCounts.map((row) => [row.profileId, Number(row.count)]));
		return rows.map((dataset) => ({
			...dataset,
			profiles: profiles.filter((profile) => profile.datasetId === dataset.datasetId).map(profileSummary),
			evaluationCount: evaluations.filter((evaluation) => evaluation.datasetId === dataset.datasetId).length,
			sampleCount: profiles.filter((profile) => profile.datasetId === dataset.datasetId).reduce((sum, profile) => sum + (sampleCountByProfile.get(profile.profileId) ?? 0), 0),
		}));
	}),

	one: protectedProcedure.input(apiDatasetId).query(async ({ ctx, input }) => {
		const dataset = await findDataset(input.datasetId, ctx.session.activeOrganizationId);
		const [profiles, evaluations] = await Promise.all([
			db.select().from(datasetProfiles).where(eq(datasetProfiles.datasetId, dataset.datasetId)).orderBy(desc(datasetProfiles.createdAt)),
			db.select().from(datasetEvaluations).where(eq(datasetEvaluations.datasetId, dataset.datasetId)).orderBy(desc(datasetEvaluations.createdAt)),
		]);
		return {
			...dataset,
			profiles: profiles.map(profileSummary),
			evaluations,
			canManage: isDatasetManager(ctx.user.role),
		};
	}),

	create: protectedProcedure.input(apiCreateDataset).mutation(async ({ ctx, input }) => {
		requireDatasetManager(ctx.user.role);
		if (input.source.type === "local" && !input.source.path.startsWith("/")) {
			throw new TRPCError({ code: "BAD_REQUEST", message: "Local dataset paths must be absolute" });
		}
		return db.insert(datasets).values({
			organizationId: ctx.session.activeOrganizationId,
			name: input.name,
			description: input.description,
			source: input.source,
			postCheckoutHook: input.postCheckoutHook,
			postCheckoutSchema: input.postCheckoutSchema,
			postScanHook: input.postScanHook,
			postEvaluationHook: input.postEvaluationHook,
			postScanSchema: input.postScanSchema,
			postEvaluationSchema: input.postEvaluationSchema,
		}).returning().then((rows) => rows[0]);
	}),

	update: protectedProcedure.input(apiUpdateDataset).mutation(async ({ ctx, input }) => {
		requireDatasetManager(ctx.user.role);
		await findDataset(input.datasetId, ctx.session.activeOrganizationId);
		const { datasetId, ...values } = input;
		if (values.source?.type === "local" && !values.source.path.startsWith("/")) {
			throw new TRPCError({ code: "BAD_REQUEST", message: "Local dataset paths must be absolute" });
		}
		return db.update(datasets).set({ ...values, updatedAt: new Date().toISOString() }).where(eq(datasets.datasetId, datasetId)).returning().then((rows) => rows[0]);
	}),

	remove: protectedProcedure.input(apiDatasetId).mutation(async ({ ctx, input }) => {
		requireDatasetManager(ctx.user.role);
		await findDataset(input.datasetId, ctx.session.activeOrganizationId);
		const referenced = await db.select({ id: datasetEvaluations.evaluationId }).from(datasetEvaluations).where(eq(datasetEvaluations.datasetId, input.datasetId)).limit(1);
		if (referenced[0]) throw new TRPCError({ code: "BAD_REQUEST", message: "Delete evaluations before deleting the dataset" });
		const profiles = await db.select({ profileId: datasetProfiles.profileId }).from(datasetProfiles).where(eq(datasetProfiles.datasetId, input.datasetId));
		for (const profile of profiles) await pruneDatasetProfile(profile.profileId);
		return db.delete(datasets).where(eq(datasets.datasetId, input.datasetId)).returning().then((rows) => rows[0]);
	}),

	profiles: createTRPCRouter({
		all: protectedProcedure.input(apiDatasetId).query(async ({ ctx, input }) => {
			await findDataset(input.datasetId, ctx.session.activeOrganizationId);
			return db.select().from(datasetProfiles).where(eq(datasetProfiles.datasetId, input.datasetId)).orderBy(desc(datasetProfiles.createdAt)).then((rows) => rows.map(profileSummary));
		}),
		create: protectedProcedure.input(apiCreateDatasetProfile).mutation(async ({ ctx, input }) => {
			requireDatasetManager(ctx.user.role);
			await findDataset(input.datasetId, ctx.session.activeOrganizationId);
			const profileId = `profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			return db.insert(datasetProfiles).values({
				profileId,
				datasetId: input.datasetId,
				profileKey: input.profileKey ?? new Date().toISOString().replace(/[:.]/g, "-"),
				hostRoot: resolveDatasetHostRoot(input.datasetId, profileId),
				status: "preparing",
			}).returning().then((rows) => rows[0]);
		}),
		checkout: protectedProcedure.input(apiDatasetProfileId).mutation(async ({ ctx, input }) => {
			requireDatasetManager(ctx.user.role);
			const profile = await db.select({ profile: datasetProfiles, dataset: datasets }).from(datasetProfiles).innerJoin(datasets, eq(datasetProfiles.datasetId, datasets.datasetId)).where(and(eq(datasetProfiles.profileId, input.profileId), eq(datasets.organizationId, ctx.session.activeOrganizationId))).limit(1).then((rows) => rows[0]);
			if (!profile) throw new TRPCError({ code: "NOT_FOUND", message: "Dataset profile not found" });
			const activeEvaluation = await db.select({ evaluationId: datasetEvaluations.evaluationId }).from(datasetEvaluations).where(and(eq(datasetEvaluations.profileId, input.profileId), inArray(datasetEvaluations.status, ["pending", "running", "paused", "finalizing"]))).limit(1);
			if (activeEvaluation[0]) throw new TRPCError({ code: "BAD_REQUEST", message: "Dataset profile is locked by an active evaluation" });
			await prepareDatasetProfile(input.profileId);
			return db.select().from(datasetProfiles).where(eq(datasetProfiles.profileId, input.profileId)).limit(1).then((rows) => rows[0] && profileSummary(rows[0]));
		}),
		remove: protectedProcedure.input(apiDatasetProfileId).mutation(async ({ ctx, input }) => {
			requireDatasetManager(ctx.user.role);
			const profile = await db.select({ profile: datasetProfiles, dataset: datasets }).from(datasetProfiles).innerJoin(datasets, eq(datasetProfiles.datasetId, datasets.datasetId)).where(and(eq(datasetProfiles.profileId, input.profileId), eq(datasets.organizationId, ctx.session.activeOrganizationId))).limit(1).then((rows) => rows[0]);
			if (!profile) throw new TRPCError({ code: "NOT_FOUND", message: "Dataset profile not found" });
			try {
				return await pruneDatasetProfile(input.profileId);
			} catch (error) {
				throw new TRPCError({ code: "BAD_REQUEST", message: error instanceof Error ? error.message : String(error) });
			}
		}),
	}),

	samples: createTRPCRouter({
		list: protectedProcedure.input(apiListDatasetSamples).query(async ({ ctx, input }) => {
			const profile = await db.select({ profile: datasetProfiles, datasetId: datasets.datasetId }).from(datasetProfiles).innerJoin(datasets, eq(datasetProfiles.datasetId, datasets.datasetId)).where(and(eq(datasetProfiles.profileId, input.profileId), eq(datasets.organizationId, ctx.session.activeOrganizationId))).limit(1).then((rows) => rows[0]);
			if (!profile) throw new TRPCError({ code: "NOT_FOUND", message: "Dataset profile not found" });
			const condition = input.search?.trim() ? ilike(datasetSamples.sampleKey, `%${input.search.trim()}%`) : undefined;
			const where = condition ? and(eq(datasetSamples.profileId, input.profileId), condition) : eq(datasetSamples.profileId, input.profileId);
			const [items, count] = await Promise.all([
				db.select().from(datasetSamples).where(where).orderBy(asc(datasetSamples.ordinal)).limit(input.pageSize).offset((input.page - 1) * input.pageSize),
				db.select({ count: sql<number>`count(*)` }).from(datasetSamples).where(where).then((rows) => Number(rows[0]?.count ?? 0)),
			]);
			return { items, total: count, page: input.page, pageSize: input.pageSize };
		}),
	}),

	evaluations: createTRPCRouter({
		all: protectedProcedure.input(apiDatasetId).query(async ({ ctx, input }) => {
			await findDataset(input.datasetId, ctx.session.activeOrganizationId);
			return db.select().from(datasetEvaluations).where(eq(datasetEvaluations.datasetId, input.datasetId)).orderBy(desc(datasetEvaluations.createdAt));
		}),
		one: protectedProcedure.input(apiDatasetEvaluationId).query(async ({ ctx, input }) => {
			const evaluation = await db.select({ evaluation: datasetEvaluations, dataset: datasets, profile: datasetProfiles }).from(datasetEvaluations).innerJoin(datasets, eq(datasetEvaluations.datasetId, datasets.datasetId)).innerJoin(datasetProfiles, eq(datasetEvaluations.profileId, datasetProfiles.profileId)).where(and(eq(datasetEvaluations.evaluationId, input.evaluationId), eq(datasets.organizationId, ctx.session.activeOrganizationId))).limit(1).then((rows) => rows[0]);
			if (!evaluation) throw new TRPCError({ code: "NOT_FOUND", message: "Evaluation not found" });
			const trials = await db.select().from(datasetEvaluationTrials).where(eq(datasetEvaluationTrials.evaluationId, input.evaluationId)).orderBy(asc(datasetEvaluationTrials.ordinal));
			const samples = trials.length
				? await db.select({ sampleId: datasetSamples.sampleId, sampleKey: datasetSamples.sampleKey, title: datasetSamples.title }).from(datasetSamples).where(inArray(datasetSamples.sampleId, trials.map((trial) => trial.sampleId)))
				: [];
			const sampleById = new Map(samples.map((sample) => [sample.sampleId, sample]));
			const totals = trials.reduce((result, trial) => ({
				durationMs: result.durationMs + (trial.durationMs ?? 0),
				totalTokens: result.totalTokens + trial.totalTokens,
				estimatedCost: result.estimatedCost + trial.estimatedCost,
			}), { durationMs: 0, totalTokens: 0, estimatedCost: 0 });
			return {
				...evaluation.evaluation,
				datasetName: evaluation.dataset.name,
				profileKey: evaluation.profile.profileKey,
				totals,
				trials: trials.map((trial) => ({ ...trial, sample: sampleById.get(trial.sampleId) ?? null })),
			};
		}),
		create: protectedProcedure.input(apiCreateDatasetEvaluation).mutation(async ({ ctx, input }) => {
			requireDatasetManager(ctx.user.role);
			const dataset = await findDataset(input.datasetId, ctx.session.activeOrganizationId);
			const profile = await db.select().from(datasetProfiles).where(and(eq(datasetProfiles.profileId, input.profileId), eq(datasetProfiles.datasetId, input.datasetId))).limit(1).then((rows) => rows[0]);
			if (!profile || profile.status !== "ready") throw new TRPCError({ code: "BAD_REQUEST", message: "A ready Dataset Profile is required" });
			const samples = await db.select().from(datasetSamples).where(and(eq(datasetSamples.profileId, input.profileId), inArray(datasetSamples.sampleKey, input.sampleKeys))).orderBy(asc(datasetSamples.ordinal));
			if (samples.length !== new Set(input.sampleKeys).size) throw new TRPCError({ code: "BAD_REQUEST", message: "One or more samples are not in the selected profile" });
			const definitions = getScanPipelineDefinitions();
			if (!definitions.pipelines[input.pipelineId]) throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown scan pipeline" });
			const evaluationId = `evaluation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			const result = await db.transaction(async (tx) => {
				const evaluation = await tx.insert(datasetEvaluations).values({
					evaluationId,
					datasetId: dataset.datasetId,
					profileId: profile.profileId,
					name: input.name,
					pipelineId: input.pipelineId,
					sampleKeys: input.sampleKeys,
					repetitions: input.repetitions,
					timeBudgetSeconds: input.timeBudgetSeconds ?? null,
					scanRuntimeSettings: input.scanRuntimeSettings,
					scanPipelineDefinitionSnapshot: definitions,
				}).returning().then((rows) => rows[0]);
				const ordered = [];
				for (let repetition = 1; repetition <= input.repetitions; repetition += 1) {
					for (const sample of samples) ordered.push({ evaluationId, sampleId: sample.sampleId, repetition, ordinal: ordered.length });
				}
				await tx.insert(datasetEvaluationTrials).values(ordered);
				return evaluation;
			});
			await datasetEvaluationQueue.add("dataset-evaluation", { evaluationId }, { jobId: evaluationId, removeOnComplete: 100, removeOnFail: 100 });
			return result;
		}),
	}),

	start: protectedProcedure.input(apiDatasetEvaluationId).mutation(async ({ ctx, input }) => {
		requireDatasetManager(ctx.user.role);
		const evaluation = await db.select({ evaluation: datasetEvaluations, dataset: datasets }).from(datasetEvaluations).innerJoin(datasets, eq(datasetEvaluations.datasetId, datasets.datasetId)).where(and(eq(datasetEvaluations.evaluationId, input.evaluationId), eq(datasets.organizationId, ctx.session.activeOrganizationId))).limit(1).then((rows) => rows[0]);
		if (!evaluation) throw new TRPCError({ code: "NOT_FOUND", message: "Evaluation not found" });
		if (evaluation.evaluation.status === "running" || evaluation.evaluation.status === "finalizing") {
			return { evaluationId: input.evaluationId, status: evaluation.evaluation.status };
		}
		const activeTrial = await db.select({ scanJobId: datasetEvaluationTrials.scanJobId }).from(datasetEvaluationTrials).where(and(eq(datasetEvaluationTrials.evaluationId, input.evaluationId), inArray(datasetEvaluationTrials.status, ["preparing", "running", "post_processing"]))).orderBy(asc(datasetEvaluationTrials.ordinal)).limit(1).then((rows) => rows[0]);
		if (evaluation.evaluation.status === "paused" && activeTrial?.scanJobId) await resumeScanJob(activeTrial.scanJobId).catch(() => {});
		await db.update(datasetEvaluations).set({ status: "pending", errorMessage: null, updatedAt: new Date().toISOString() }).where(eq(datasetEvaluations.evaluationId, input.evaluationId));
		await datasetEvaluationQueue.add("dataset-evaluation", { evaluationId: input.evaluationId }, { jobId: `resume-${input.evaluationId}-${Date.now()}`, removeOnComplete: 100, removeOnFail: 100 });
		return { evaluationId: input.evaluationId };
	}),

	pause: protectedProcedure.input(apiDatasetEvaluationId).mutation(async ({ ctx, input }) => {
		requireDatasetManager(ctx.user.role);
		const evaluation = await db.select({ evaluation: datasetEvaluations, dataset: datasets }).from(datasetEvaluations).innerJoin(datasets, eq(datasetEvaluations.datasetId, datasets.datasetId)).where(and(eq(datasetEvaluations.evaluationId, input.evaluationId), eq(datasets.organizationId, ctx.session.activeOrganizationId))).limit(1).then((rows) => rows[0]);
		if (!evaluation) throw new TRPCError({ code: "NOT_FOUND", message: "Evaluation not found" });
		const activeTrial = await db.select({ scanJobId: datasetEvaluationTrials.scanJobId }).from(datasetEvaluationTrials).where(and(eq(datasetEvaluationTrials.evaluationId, input.evaluationId), inArray(datasetEvaluationTrials.status, ["preparing", "running", "post_processing"]))).orderBy(asc(datasetEvaluationTrials.ordinal)).limit(1).then((rows) => rows[0]);
		if (activeTrial?.scanJobId) await pauseScanJob(activeTrial.scanJobId).catch(() => {});
		await cancelDatasetHookRuns(input.evaluationId);
		await db.update(datasetEvaluations).set({ status: "paused", updatedAt: new Date().toISOString() }).where(eq(datasetEvaluations.evaluationId, input.evaluationId));
		return { evaluationId: input.evaluationId, status: "paused" as const };
	}),

	cancel: protectedProcedure.input(apiDatasetEvaluationId).mutation(async ({ ctx, input }) => {
		requireDatasetManager(ctx.user.role);
		const evaluation = await db.select({ evaluation: datasetEvaluations, dataset: datasets }).from(datasetEvaluations).innerJoin(datasets, eq(datasetEvaluations.datasetId, datasets.datasetId)).where(and(eq(datasetEvaluations.evaluationId, input.evaluationId), eq(datasets.organizationId, ctx.session.activeOrganizationId))).limit(1).then((rows) => rows[0]);
		if (!evaluation) throw new TRPCError({ code: "NOT_FOUND", message: "Evaluation not found" });
		const activeTrial = await db
			.select({ trialId: datasetEvaluationTrials.trialId, scanJobId: datasetEvaluationTrials.scanJobId })
			.from(datasetEvaluationTrials)
			.where(and(
				eq(datasetEvaluationTrials.evaluationId, input.evaluationId),
				inArray(datasetEvaluationTrials.status, ["preparing", "running", "post_processing"]),
			))
			.orderBy(asc(datasetEvaluationTrials.ordinal))
			.limit(1)
			.then((rows) => rows[0]);
		if (activeTrial?.scanJobId) await cancelScanJob(activeTrial.scanJobId).catch(() => {});
		await cancelDatasetHookRuns(input.evaluationId);
		await db.update(datasetEvaluationTrials).set({ status: "canceled", errorMessage: "Evaluation canceled", finishedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).where(and(eq(datasetEvaluationTrials.evaluationId, input.evaluationId), inArray(datasetEvaluationTrials.status, ["pending", "preparing", "running", "post_processing"])));
		await db.update(datasetEvaluations).set({ status: "canceled", finishedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).where(eq(datasetEvaluations.evaluationId, input.evaluationId));
		return { evaluationId: input.evaluationId, status: "canceled" as const };
	}),
});
