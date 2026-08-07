import { TRPCError } from "@trpc/server";
import {
	apiArchivePipeline,
	apiCopyVersionToDraft,
	apiCreatePipeline,
	apiCreatePipelineRun,
	apiDeletePipelineDraft,
	apiDuplicatePipeline,
	apiPipelineId,
	apiPipelineVersionId,
	apiPublishPipeline,
	apiPublishedPipelineOptions,
	apiSavePipelineDraft,
	apiSetCurrentVersion,
	apiUnarchivePipeline,
	apiValidatePipelineYaml,
} from "@vulseek/server/db/schema/pipeline";
import { createTRPCRouter, protectedProcedure } from "@/server/api/trpc";
import {
	archivePipelineForOrganization,
	copyPipelineVersionToDraftForOrganization,
	createPipelineForOrganization,
	deletePipelineDraftForOrganization,
	duplicatePipelineForOrganization,
	getPipelineForOrganization,
	getPipelineVersionForOrganization,
	isPipelineManager,
	listPipelineVersionsForOrganization,
	listPipelinesForOrganization,
	listPublishedPipelineOptions,
	publishPipelineForOrganization,
	savePipelineDraftForOrganization,
	setPipelineCurrentVersionForOrganization,
	unarchivePipelineForOrganization,
	validatePipelineYaml,
} from "@vulseek/server/services/pipeline";
import { createPipelineRun } from "@vulseek/server/services/scan/api/pipeline-runs";

/**
 * Organization-level pipeline router.
 *
 * - `list` / `get` / `getVersion` / `listVersions` / `publishedOptions` are
 *   open to every org member; members only ever see published content.
 * - Drafts, diagnostics and all mutations require owner/admin.
 * - Every query is scoped by `ctx.session.activeOrganizationId`.
 */

const requireManager = (role: string) => {
	if (!isPipelineManager(role)) {
		throw new TRPCError({ code: "FORBIDDEN", message: "Owner or admin required" });
	}
};

const managerContext = (ctx: {
	session: { activeOrganizationId: string };
	user: { id: string };
}) => ({
	organizationId: ctx.session.activeOrganizationId,
	userId: ctx.user.id,
});

export const pipelineRouter = createTRPCRouter({
	list: protectedProcedure.query(async ({ ctx }) => {
		const includeDraft = isPipelineManager(ctx.user.role);
		return listPipelinesForOrganization(ctx.session.activeOrganizationId, {
			includeDraft,
		});
	}),

	get: protectedProcedure
		.input(apiPipelineId)
		.query(async ({ ctx, input }) => {
			const includeDraft = isPipelineManager(ctx.user.role);
			return getPipelineForOrganization(
				ctx.session.activeOrganizationId,
				input.pipelineId,
				{ includeDraft },
			);
		}),

	getVersion: protectedProcedure
		.input(apiPipelineId.merge(apiPipelineVersionId))
		.query(async ({ ctx, input }) =>
			getPipelineVersionForOrganization(
				ctx.session.activeOrganizationId,
				input.pipelineId,
				input.pipelineVersionId,
			),
		),

	listVersions: protectedProcedure
		.input(apiPipelineId)
		.query(async ({ ctx, input }) =>
			listPipelineVersionsForOrganization(
				ctx.session.activeOrganizationId,
				input.pipelineId,
			),
		),

	publishedOptions: protectedProcedure
		.input(apiPublishedPipelineOptions)
		.query(async ({ ctx, input }) =>
			listPublishedPipelineOptions(
				ctx.session.activeOrganizationId,
				input.targetType,
			),
		),

	/** Shared diagnostics for the editor; manager-only per the draft rule. */
	validate: protectedProcedure
		.input(apiValidatePipelineYaml)
		.query(async ({ ctx, input }) => {
			requireManager(ctx.user.role);
			return validatePipelineYaml(input.yaml);
		}),

	/** Built-in templates (systemKey → serialized V3 YAML) for copying. */
	templates: protectedProcedure.query(async () => {
		const { loadBuiltinPipelineTemplates } = await import(
			"@vulseek/server/services/scan/pipeline/document-v3/builtin-pipelines"
		);
		return loadBuiltinPipelineTemplates().map((template) => ({
			systemKey: template.systemKey,
			name: template.name,
			yaml: template.yaml,
		}));
	}),

	/**
	 * Agent profiles, skills, plugins and effects the editor can reference.
	 * The full skill registry is wired in the editor phase; plugins/effects
	 * are the server-registered safe lists from the V3 contract.
	 */
	runtimeCatalog: protectedProcedure.query(async () => ({
		agentProfiles: [],
		skills: [],
		plugins: ["research-track", "research-deadline", "tob-goal-native"],
		effects: [
			"sync-candidates",
			"project-candidate-result",
			"research-registry",
			"tob-goal-registry",
		],
	})),

	/**
	 * Start a run of a published pipeline version. Members may run; only
	 * published content is reachable (drafts can never run). The queue payload
	 * carries only the scanJobId — the worker reads the frozen snapshot.
	 */
	run: protectedProcedure
		.input(apiCreatePipelineRun)
		.mutation(async ({ ctx, input }) => {
			const scanJob = await createPipelineRun({
				organizationId: ctx.session.activeOrganizationId,
				userId: ctx.user.id,
				...input,
			});
			const { scansQueue } = await import("@/server/queues/queueSetup");
			await scansQueue.add(
				"scans",
				{ scanJobId: scanJob.scanJobId },
				{
					jobId: `scan:${scanJob.scanJobId}`,
					removeOnComplete: true,
					removeOnFail: true,
				},
			);
			return scanJob;
		}),

	create: protectedProcedure
		.input(apiCreatePipeline)
		.mutation(async ({ ctx, input }) => {
			requireManager(ctx.user.role);
			return createPipelineForOrganization({
				...managerContext(ctx),
				...input,
			});
		}),

	saveDraft: protectedProcedure
		.input(apiSavePipelineDraft)
		.mutation(async ({ ctx, input }) => {
			requireManager(ctx.user.role);
			return savePipelineDraftForOrganization({
				...managerContext(ctx),
				...input,
			});
		}),

	publish: protectedProcedure
		.input(apiPublishPipeline)
		.mutation(async ({ ctx, input }) => {
			requireManager(ctx.user.role);
			return publishPipelineForOrganization({
				...managerContext(ctx),
				...input,
			});
		}),

	copyVersionToDraft: protectedProcedure
		.input(apiCopyVersionToDraft)
		.mutation(async ({ ctx, input }) => {
			requireManager(ctx.user.role);
			return copyPipelineVersionToDraftForOrganization({
				...managerContext(ctx),
				pipelineId: input.pipelineId,
				versionId: input.pipelineVersionId,
			});
		}),

	setCurrentVersion: protectedProcedure
		.input(apiSetCurrentVersion)
		.mutation(async ({ ctx, input }) => {
			requireManager(ctx.user.role);
			return setPipelineCurrentVersionForOrganization({
				...managerContext(ctx),
				pipelineId: input.pipelineId,
				versionId: input.pipelineVersionId,
			});
		}),

	duplicate: protectedProcedure
		.input(apiDuplicatePipeline)
		.mutation(async ({ ctx, input }) => {
			requireManager(ctx.user.role);
			return duplicatePipelineForOrganization({
				...managerContext(ctx),
				...input,
			});
		}),

	archive: protectedProcedure
		.input(apiArchivePipeline)
		.mutation(async ({ ctx, input }) => {
			requireManager(ctx.user.role);
			return archivePipelineForOrganization({
				...managerContext(ctx),
				...input,
			});
		}),

	unarchive: protectedProcedure
		.input(apiUnarchivePipeline)
		.mutation(async ({ ctx, input }) => {
			requireManager(ctx.user.role);
			return unarchivePipelineForOrganization({
				...managerContext(ctx),
				...input,
			});
		}),

	deleteDraftOnly: protectedProcedure
		.input(apiDeletePipelineDraft)
		.mutation(async ({ ctx, input }) => {
			requireManager(ctx.user.role);
			return deletePipelineDraftForOrganization({
				...managerContext(ctx),
				...input,
			});
		}),
});
