import {
	cancelScanJob,
	createScanJob,
	findAllScanJobsByApplicationId,
	findAllScanJobsByComposeId,
	findApplicationById,
	findCandidateSandboxAgentSession,
	findCandidateTaskLineage,
	findCheckoutImageStatus,
	findCheckoutStatus,
	findCheckoutToolsBuildStatus,
	findCheckoutToolsStatus,
	findComposeById,
	findRunningCheckoutTask,
	findScanJobById,
	findFullScanStageGraph,
	getScanPipelineDefinitions,
	getScanPipelineYaml,
	findScanJobSandboxAgentSession,
	findScanJobStageGraph,
	findScanJobOrganizationId,
	findScanJobTerminalTasksPage,
	findLatestScanEvaluationResult,
	findScanJobResultSummary,
	findTaskById,
	findVulnerabilityCandidateById,
	findVulnerabilityCandidatesPageWithLatestAnalysisResultByScanJobId,
	findVulnerabilityCandidateWithLatestAnalysisResultById,
	getAgentProfileById,
	getScanHomeOverview,
	getScanHomeOverviewActivity,
	getScanHomeOverviewSummary,
	getScanHomeOverviewWorkload,
	listScanEvaluationResults,
	listCandidateTags,
	listScanJobDirectory,
	listScanTaskDirectory,
	readCandidateFileContent,
	readCandidateFilesTree,
	readScanJobAppServerText,
	readScanJobFileContent,
	readScanTaskFileContent,
	pauseScanJob,
	rerunScanTask,
	resumeScanJob,
	retryFailedScanJobTasks,
	startCandidateAnalysis,
	startCandidateReviewContainer,
	startCandidateVerification,
	startCheckoutScanEnvironment,
	startCheckoutToolsBuild,
	canRebuildCheckoutTools,
	createScanEvaluationResult,
	scanEvaluationConfigSchema,
	syncFullScanTasksFromArtifacts,
	updateVulnerabilityCandidateMetadata,
	updateScanJobNote,
	updateScanJobPipelineDefinitionSnapshot,
	updateScanJobRuntimeSettings,
} from "@vulseek/server";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
	apiCheckoutScanEnvironment,
	apiCreateScanJob,
	apiFindCheckoutStatus,
	apiFindOneScanJob,
	apiFindRunningCheckout,
	apiFindScanJobsByApplication,
	apiFindScanJobsByCompose,
	apiUpdateScanJobNote,
	ScanRuntimeSettingsSchema,
} from "@/server/db/schema";
import type { ScanQueueJob } from "@/server/queues/queue-types";
import { scanEvaluationsQueue, scansQueue } from "@/server/queues/queueSetup";
import { createTRPCRouter, protectedProcedure } from "../trpc";
import { jobRuntimeStatusStore } from "../../scan/job-runtime-cache";

const apiFindVulnerabilityCandidatesPageByScanJob = z
	.object({
		scanJobId: z.string().min(1),
		page: z.number().int().min(1).default(1),
		pageSize: z.number().int().min(1).max(100).default(20),
		query: z.string().default(""),
		analysisResults: z.string().default(""),
		verifyResults: z.string().default(""),
		triageResults: z.string().default(""),
		sortKey: z
			.enum([
				"latestResultUpdatedAt",
				"createdAt",
				"candidate",
				"analysis",
				"verify",
				"score",
			])
			.default("latestResultUpdatedAt"),
		sortDirection: z.enum(["asc", "desc"]).default("desc"),
	})
	.required();

const parseCsvFilter = (value: string) =>
	value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);

const authorizeScanJobRuntimeAccess = async (
	scanJobId: string,
	activeOrganizationId: string | null | undefined,
) => {
	const organizationId = await findScanJobOrganizationId(scanJobId);
	if (!organizationId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Invalid scan job target",
		});
	}
	if (organizationId !== activeOrganizationId) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You are not authorized to access this scan job",
		});
	}
};

const apiUpdateCandidateMetadata = z.object({
	vulnerabilityCandidateId: z.string().min(1),
	scanJobId: z.string().min(1),
	producerTaskId: z.string().min(1).optional(),
	note: z.string().max(10000).default(""),
	tags: z.array(z.string().min(1).max(64)).max(50).default([]),
});

const apiFindScanJobTerminalTasksPage = z
	.object({
		scanJobId: z.string().min(1),
		page: z.number().int().min(1).default(1),
		pageSize: z.number().int().min(1).max(100).default(20),
		query: z.string().default(""),
		stage: z.string().default("all"),
		status: z.string().default("all"),
	})
	.required();

const apiFindFullScanStageGraph = z
	.object({
		applicationId: z.string().min(1).optional(),
		composeId: z.string().min(1).optional(),
		scanType: z.enum(["delta", "full"]).optional(),
	})
	.refine(
		(value) => Boolean(value.applicationId) !== Boolean(value.composeId),
		{
			message: "Provide exactly one target: applicationId or composeId",
			path: ["applicationId"],
		},
	);

const apiUpdateScanRuntimeSettings = z.object({
	scanJobId: z.string().min(1),
	scanRuntimeSettings: ScanRuntimeSettingsSchema,
});

const apiUpdateScanPipelineDefinitionSnapshot = z.object({
	scanJobId: z.string().min(1),
	scanPipelineDefinitionSnapshot: z.record(z.unknown()),
});

const apiStartScanEvaluation = z.object({
	scanJobId: z.string().min(1),
	configSnapshot: scanEvaluationConfigSchema,
});

const apiStartCandidateReviewContainer = z.object({
	scanJobId: z.string().min(1),
	candidateIds: z.array(z.string().min(1)).min(1),
});

export const scanRouter = createTRPCRouter({
	pipelineDefinitions: protectedProcedure.query(async () => getScanPipelineDefinitions()),

	pipelineYaml: protectedProcedure.query(async () => ({
		yaml: getScanPipelineYaml(),
	})),

	homeSummary: protectedProcedure.query(async ({ ctx }) => {
		if (!ctx.session.activeOrganizationId) {
			throw new TRPCError({
				code: "UNAUTHORIZED",
				message: "No active organization selected",
			});
		}
		return await getScanHomeOverviewSummary(ctx.session.activeOrganizationId);
	}),

	homeActivity: protectedProcedure
		.input(
			z
				.object({
					days: z.number().int().min(1).max(366).optional(),
				})
				.optional(),
		)
		.query(async ({ input, ctx }) => {
			if (!ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "No active organization selected",
				});
			}
			return await getScanHomeOverviewActivity({
				organizationId: ctx.session.activeOrganizationId,
				days: input?.days,
			});
		}),

	homeWorkload: protectedProcedure.query(async ({ ctx }) => {
		if (!ctx.session.activeOrganizationId) {
			throw new TRPCError({
				code: "UNAUTHORIZED",
				message: "No active organization selected",
			});
		}
		return await getScanHomeOverviewWorkload(ctx.session.activeOrganizationId);
	}),

	homeOverview: protectedProcedure
		.input(
			z
				.object({
					days: z.number().int().min(1).max(366).optional(),
				})
				.optional(),
		)
		.query(async ({ input, ctx }) => {
			if (!ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "No active organization selected",
				});
			}
			return await getScanHomeOverview({
				organizationId: ctx.session.activeOrganizationId,
				days: input?.days,
			});
		}),

	checkoutToolsStatus: protectedProcedure.query(async ({ ctx }) =>
		await findCheckoutToolsStatus(canRebuildCheckoutTools(ctx.user.role)),
	),

	rebuildCheckoutTools: protectedProcedure.mutation(async ({ ctx }) => {
		if (!canRebuildCheckoutTools(ctx.user.role)) {
			throw new TRPCError({
				code: "UNAUTHORIZED",
				message: "You are not authorized to rebuild checkout tools",
			});
		}
		const build = await startCheckoutToolsBuild();
		return {
			buildId: build.buildId,
			version: build.version,
			imageTag: build.imageTag,
			status: build.status,
		};
	}),

	checkoutToolsBuildStatus: protectedProcedure
		.input(z.object({ buildId: z.string().min(1) }).required())
		.query(({ input }) => findCheckoutToolsBuildStatus(input.buildId)),

	checkout: protectedProcedure
		.input(apiCheckoutScanEnvironment)
		.mutation(async ({ input, ctx }) => {
			if (input.applicationId) {
				const application = await findApplicationById(input.applicationId);
				if (
					application.environment.project.organizationId !==
					ctx.session.activeOrganizationId
				) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to checkout this application",
					});
				}
			}
			if (input.composeId) {
				const compose = await findComposeById(input.composeId);
				if (
					compose.environment.project.organizationId !==
					ctx.session.activeOrganizationId
				) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to checkout this compose",
					});
				}
			}

			return await startCheckoutScanEnvironment(input);
		}),

	checkoutStatus: protectedProcedure
		.input(apiFindCheckoutStatus)
		.query(async ({ input, ctx }) => {
			const status = await findCheckoutStatus(input.checkoutId);
			if (!status) {
				return null;
			}
			if (status.applicationId) {
				const application = await findApplicationById(status.applicationId);
				if (
					application.environment.project.organizationId !==
					ctx.session.activeOrganizationId
				) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to access this checkout task",
					});
				}
			}
			if (status.composeId) {
				const compose = await findComposeById(status.composeId);
				if (
					compose.environment.project.organizationId !==
					ctx.session.activeOrganizationId
				) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to access this checkout task",
					});
				}
			}
			return status;
		}),
	checkoutImageStatus: protectedProcedure
		.input(apiCheckoutScanEnvironment)
		.query(async ({ input, ctx }) => {
			if (input.applicationId) {
				const application = await findApplicationById(input.applicationId);
				if (
					application.environment.project.organizationId !==
					ctx.session.activeOrganizationId
				) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to access this application",
					});
				}
			}
			if (input.composeId) {
				const compose = await findComposeById(input.composeId);
				if (
					compose.environment.project.organizationId !==
					ctx.session.activeOrganizationId
				) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to access this compose",
					});
				}
			}
			return await findCheckoutImageStatus(input);
		}),
	runningCheckout: protectedProcedure
		.input(apiFindRunningCheckout)
		.query(async ({ input, ctx }) => {
			if (input.applicationId) {
				const application = await findApplicationById(input.applicationId);
				if (
					application.environment.project.organizationId !==
					ctx.session.activeOrganizationId
				) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to access this application",
					});
				}
			}
			if (input.composeId) {
				const compose = await findComposeById(input.composeId);
				if (
					compose.environment.project.organizationId !==
					ctx.session.activeOrganizationId
				) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to access this compose",
					});
				}
			}
			return await findRunningCheckoutTask(input);
		}),

	create: protectedProcedure
		.input(apiCreateScanJob)
		.mutation(async ({ input, ctx }) => {
			if (input.applicationId) {
				const application = await findApplicationById(input.applicationId);
				if (
					application.environment.project.organizationId !==
					ctx.session.activeOrganizationId
				) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to scan this application",
					});
				}
			}

			if (input.composeId) {
				const compose = await findComposeById(input.composeId);
				if (
					compose.environment.project.organizationId !==
					ctx.session.activeOrganizationId
				) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to scan this compose",
					});
				}
			}

			const scanJob = await createScanJob(input);
			const queueData: ScanQueueJob = {
				scanJobId: scanJob.scanJobId,
			};

			await scansQueue.add("scans", queueData, {
				jobId: `scan:${scanJob.scanJobId}`,
				removeOnComplete: true,
				removeOnFail: true,
			});

			return scanJob;
		}),

	allByApplication: protectedProcedure
		.input(apiFindScanJobsByApplication)
		.query(async ({ input, ctx }) => {
			const application = await findApplicationById(input.applicationId);
			if (
				application.environment.project.organizationId !==
				ctx.session.activeOrganizationId
			) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message:
						"You are not authorized to access scan jobs for this application",
				});
			}

			return await findAllScanJobsByApplicationId(input.applicationId);
		}),

	allByCompose: protectedProcedure
		.input(apiFindScanJobsByCompose)
		.query(async ({ input, ctx }) => {
			const compose = await findComposeById(input.composeId);
			if (
				compose.environment.project.organizationId !==
				ctx.session.activeOrganizationId
			) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message:
						"You are not authorized to access scan jobs for this compose",
				});
			}

			return await findAllScanJobsByComposeId(input.composeId);
		}),

	one: protectedProcedure
		.input(apiFindOneScanJob)
		.query(async ({ input, ctx }) => {
			const scanJob = await findScanJobById(input.scanJobId);
			let organizationId: string | undefined;
			if (scanJob.applicationId) {
				const application = await findApplicationById(scanJob.applicationId);
				organizationId = application.environment.project.organizationId;
			}
			if (scanJob.composeId) {
				const compose = await findComposeById(scanJob.composeId);
				organizationId = compose.environment.project.organizationId;
			}
			if (!organizationId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid scan job target",
				});
			}

			if (organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access this scan job",
				});
			}

			return scanJob;
		}),

	task: protectedProcedure
		.input(
			z.object({
				taskId: z.string().min(1),
				scanJobId: z.string().min(1).optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			const task = await findTaskById(input.taskId);
			if (input.scanJobId && task.scanJobId !== input.scanJobId) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Task not found for this scan job",
				});
			}

			const scanJob = await findScanJobById(task.scanJobId);
			let organizationId: string | undefined;
			if (scanJob.applicationId) {
				const application = await findApplicationById(scanJob.applicationId);
				organizationId = application.environment.project.organizationId;
			}
			if (scanJob.composeId) {
				const compose = await findComposeById(scanJob.composeId);
				organizationId = compose.environment.project.organizationId;
			}
			if (!organizationId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid scan job target",
				});
			}

			if (organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access this scan task",
				});
			}

			return { task, scanJob };
		}),

	updateNote: protectedProcedure
		.input(apiUpdateScanJobNote)
		.mutation(async ({ input, ctx }) => {
			const scanJob = await findScanJobById(input.scanJobId);
			let organizationId: string | undefined;
			if (scanJob.applicationId) {
				const application = await findApplicationById(scanJob.applicationId);
				organizationId = application.environment.project.organizationId;
			}
			if (scanJob.composeId) {
				const compose = await findComposeById(scanJob.composeId);
				organizationId = compose.environment.project.organizationId;
			}
			if (!organizationId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid scan job target",
				});
			}

			if (organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to update this scan job",
				});
			}

			const note = input.note?.trim() ? input.note.trim() : null;
			return await updateScanJobNote(input.scanJobId, note);
		}),

	updateRuntimeSettings: protectedProcedure
		.input(apiUpdateScanRuntimeSettings)
		.mutation(async ({ input, ctx }) => {
			const scanJob = await findScanJobById(input.scanJobId);
			let organizationId: string | undefined;
			if (scanJob.applicationId) {
				const application = await findApplicationById(scanJob.applicationId);
				organizationId = application.environment.project.organizationId;
			}
			if (scanJob.composeId) {
				const compose = await findComposeById(scanJob.composeId);
				organizationId = compose.environment.project.organizationId;
			}
			if (!organizationId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid scan job target",
				});
			}

			if (organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to update this scan job",
				});
			}

			return await updateScanJobRuntimeSettings(
				input.scanJobId,
				input.scanRuntimeSettings,
			);
		}),

	updatePipelineDefinitionSnapshot: protectedProcedure
		.input(apiUpdateScanPipelineDefinitionSnapshot)
		.mutation(async ({ input, ctx }) => {
			const scanJob = await findScanJobById(input.scanJobId);
			let organizationId: string | undefined;
			if (scanJob.applicationId) {
				const application = await findApplicationById(scanJob.applicationId);
				organizationId = application.environment.project.organizationId;
			}
			if (scanJob.composeId) {
				const compose = await findComposeById(scanJob.composeId);
				organizationId = compose.environment.project.organizationId;
			}
			if (!organizationId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid scan job target",
				});
			}

			if (organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to update this scan job",
				});
			}

			return await updateScanJobPipelineDefinitionSnapshot(
				input.scanJobId,
				input.scanPipelineDefinitionSnapshot,
			);
		}),

	cancel: protectedProcedure
		.input(apiFindOneScanJob)
		.mutation(async ({ input, ctx }) => {
			const scanJob = await findScanJobById(input.scanJobId);
			let organizationId: string | undefined;
			if (scanJob.applicationId) {
				const application = await findApplicationById(scanJob.applicationId);
				organizationId = application.environment.project.organizationId;
			}
			if (scanJob.composeId) {
				const compose = await findComposeById(scanJob.composeId);
				organizationId = compose.environment.project.organizationId;
			}
			if (!organizationId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid scan job target",
				});
			}

			if (organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to cancel this scan job",
				});
			}

			await Promise.all([
				scansQueue
					.getJob(`scan:${input.scanJobId}`)
					.then((job) => job?.remove())
					.catch(() => {}),
				scansQueue
					.getJob(`scan:retry:${input.scanJobId}`)
					.then((job) => job?.remove())
					.catch(() => {}),
				scansQueue
					.getJob(`scan:retry-analysis:${input.scanJobId}`)
					.then((job) => job?.remove())
					.catch(() => {}),
				scansQueue
					.getJob(`scan:retry-verification:${input.scanJobId}`)
					.then((job) => job?.remove())
					.catch(() => {}),
			]);

			return await cancelScanJob(input.scanJobId);
		}),

	pause: protectedProcedure
		.input(apiFindOneScanJob)
		.mutation(async ({ input, ctx }) => {
			const scanJob = await findScanJobById(input.scanJobId);
			let organizationId: string | undefined;
			if (scanJob.applicationId) {
				const application = await findApplicationById(scanJob.applicationId);
				organizationId = application.environment.project.organizationId;
			}
			if (scanJob.composeId) {
				const compose = await findComposeById(scanJob.composeId);
				organizationId = compose.environment.project.organizationId;
			}
			if (!organizationId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid scan job target",
				});
			}

			if (organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to pause this scan job",
				});
			}

			return await pauseScanJob(input.scanJobId);
		}),

	resume: protectedProcedure
		.input(apiFindOneScanJob)
		.mutation(async ({ input, ctx }) => {
			const scanJob = await findScanJobById(input.scanJobId);
			let organizationId: string | undefined;
			if (scanJob.applicationId) {
				const application = await findApplicationById(scanJob.applicationId);
				organizationId = application.environment.project.organizationId;
			}
			if (scanJob.composeId) {
				const compose = await findComposeById(scanJob.composeId);
				organizationId = compose.environment.project.organizationId;
			}
			if (!organizationId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid scan job target",
				});
			}

			if (organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to resume this scan job",
				});
			}

			return await resumeScanJob(input.scanJobId);
		}),

	syncArtifacts: protectedProcedure
		.input(apiFindOneScanJob)
		.mutation(async ({ input, ctx }) => {
			const scanJob = await findScanJobById(input.scanJobId);
			let organizationId: string | undefined;
			if (scanJob.applicationId) {
				const application = await findApplicationById(scanJob.applicationId);
				organizationId = application.environment.project.organizationId;
			}
			if (scanJob.composeId) {
				const compose = await findComposeById(scanJob.composeId);
				organizationId = compose.environment.project.organizationId;
			}
			if (!organizationId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid scan job target",
				});
			}

			if (organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to sync this scan job",
				});
			}

			return await syncFullScanTasksFromArtifacts(input.scanJobId);
		}),

	retryFailedTasks: protectedProcedure
		.input(apiFindOneScanJob)
		.mutation(async ({ input, ctx }) => {
			const scanJob = await findScanJobById(input.scanJobId);
			let organizationId: string | undefined;
			if (scanJob.applicationId) {
				const application = await findApplicationById(scanJob.applicationId);
				organizationId = application.environment.project.organizationId;
			}
			if (scanJob.composeId) {
				const compose = await findComposeById(scanJob.composeId);
				organizationId = compose.environment.project.organizationId;
			}
			if (!organizationId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid scan job target",
				});
			}

			if (organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to retry this scan job",
				});
			}

			const result = await retryFailedScanJobTasks(input.scanJobId);
			const queueData: ScanQueueJob = {
				scanJobId: scanJob.scanJobId,
				mode: "retry-failed-tasks",
			};

			await scansQueue.add("scans", queueData, {
				jobId: `scan:retry:${scanJob.scanJobId}`,
				removeOnComplete: true,
				removeOnFail: true,
			});

			return result;
		}),

	rerunTask: protectedProcedure
		.input(z.object({ taskId: z.string().min(1) }))
		.mutation(async ({ input, ctx }) => {
			const sourceTask = await findTaskById(input.taskId);
			const scanJob = await findScanJobById(sourceTask.scanJobId);
			let organizationId: string | undefined;
			if (scanJob.applicationId) {
				const application = await findApplicationById(scanJob.applicationId);
				organizationId = application.environment.project.organizationId;
			}
			if (scanJob.composeId) {
				const compose = await findComposeById(scanJob.composeId);
				organizationId = compose.environment.project.organizationId;
			}
			if (!organizationId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid scan job target",
				});
			}

			if (organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to rerun this scan task",
				});
			}

			const result = await rerunScanTask(input.taskId);
			const queueData: ScanQueueJob = {
				scanJobId: result.task.scanJobId,
				mode: "rerun-task",
			};

			await scansQueue.add("scans", queueData, {
				jobId: `scan:rerun-task:${result.task.scanJobId}:${result.task.taskId}`,
				removeOnComplete: true,
				removeOnFail: true,
			});

			return result;
		}),

	candidates: protectedProcedure
		.input(apiFindVulnerabilityCandidatesPageByScanJob)
		.query(async ({ input, ctx }) => {
			const scanJob = await findScanJobById(input.scanJobId);
			let organizationId: string | undefined;
			if (scanJob.applicationId) {
				const application = await findApplicationById(scanJob.applicationId);
				organizationId = application.environment.project.organizationId;
			}
			if (scanJob.composeId) {
				const compose = await findComposeById(scanJob.composeId);
				organizationId = compose.environment.project.organizationId;
			}
			if (!organizationId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid scan job target",
				});
			}

			if (organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message:
						"You are not authorized to access candidates for this scan job",
				});
			}

			return await findVulnerabilityCandidatesPageWithLatestAnalysisResultByScanJobId(
				{
					...input,
					analysisResults: parseCsvFilter(input.analysisResults),
					verifyResults: parseCsvFilter(input.verifyResults),
					triageResults: parseCsvFilter(input.triageResults),
				},
			);
		}),

	startEvaluation: protectedProcedure
		.input(apiStartScanEvaluation)
		.mutation(async ({ input, ctx }) => {
			const scanJob = await findScanJobById(input.scanJobId);
			if (!scanJob.applicationId || scanJob.composeId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Evaluate only supports application scan jobs",
				});
			}
			const application = await findApplicationById(scanJob.applicationId);
			if (
				application.environment.project.organizationId !==
				ctx.session.activeOrganizationId
			) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to evaluate this scan job",
				});
			}
			if (input.configSnapshot.agentProfileId) {
				const agentProfile = await getAgentProfileById(
					input.configSnapshot.agentProfileId,
				);
				if (agentProfile.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message:
							"You are not authorized to use this evaluate agent profile",
					});
				}
				if (!agentProfile.isEnabled) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "Evaluate agent profile is disabled",
					});
				}
			}

			const evaluation = await createScanEvaluationResult({
				scanJobId: input.scanJobId,
				configSnapshot: input.configSnapshot,
			});
			if (!evaluation) {
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: "Failed to create scan evaluation result",
				});
			}
			await scanEvaluationsQueue.add(
				"scan-evaluations",
				{ evaluateResultId: evaluation.evaluateResultId },
				{
					jobId: `scan-evaluation:${evaluation.evaluateResultId}`,
					removeOnComplete: true,
					removeOnFail: true,
				},
			);
			return evaluation;
		}),

	latestEvaluation: protectedProcedure
		.input(apiFindOneScanJob)
		.query(async ({ input, ctx }) => {
			const scanJob = await findScanJobById(input.scanJobId);
			if (!scanJob.applicationId || scanJob.composeId) {
				return null;
			}
			const application = await findApplicationById(scanJob.applicationId);
			if (
				application.environment.project.organizationId !==
				ctx.session.activeOrganizationId
			) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message:
						"You are not authorized to access evaluations for this scan job",
				});
			}

			return await findLatestScanEvaluationResult(input.scanJobId);
		}),

	evaluationHistory: protectedProcedure
		.input(apiFindOneScanJob)
		.query(async ({ input, ctx }) => {
			const scanJob = await findScanJobById(input.scanJobId);
			if (!scanJob.applicationId || scanJob.composeId) {
				return [];
			}
			const application = await findApplicationById(scanJob.applicationId);
			if (
				application.environment.project.organizationId !==
				ctx.session.activeOrganizationId
			) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message:
						"You are not authorized to access evaluations for this scan job",
				});
			}

			return await listScanEvaluationResults(input.scanJobId);
		}),

	resultSummary: protectedProcedure
		.input(apiFindOneScanJob)
		.query(async ({ input, ctx }) => {
			const scanJob = await findScanJobById(input.scanJobId);
			let organizationId: string | undefined;
			if (scanJob.applicationId) {
				const application = await findApplicationById(scanJob.applicationId);
				organizationId = application.environment.project.organizationId;
			}
			if (scanJob.composeId) {
				const compose = await findComposeById(scanJob.composeId);
				organizationId = compose.environment.project.organizationId;
			}
			if (!organizationId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid scan job target",
				});
			}

			if (organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message:
						"You are not authorized to access result summary for this scan job",
				});
			}

			return await findScanJobResultSummary(input.scanJobId);
		}),

	textSnapshot: protectedProcedure
		.input(apiFindOneScanJob)
		.query(async ({ input, ctx }) => {
			const scanJob = await findScanJobById(input.scanJobId);
			let organizationId: string | undefined;
			if (scanJob.applicationId) {
				const application = await findApplicationById(scanJob.applicationId);
				organizationId = application.environment.project.organizationId;
			}
			if (scanJob.composeId) {
				const compose = await findComposeById(scanJob.composeId);
				organizationId = compose.environment.project.organizationId;
			}
			if (!organizationId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid scan job target",
				});
			}

			if (organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access this scan job",
				});
			}

			return {
				text: await readScanJobAppServerText(input.scanJobId),
			};
		}),

	listDirectory: protectedProcedure
		.input(
			z.object({
				scanJobId: z.string(),
				directoryPath: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			const scanJob = await findScanJobById(input.scanJobId);
			let organizationId: string | undefined;
			if (scanJob.applicationId) {
				const application = await findApplicationById(scanJob.applicationId);
				organizationId = application.environment.project.organizationId;
			}
			if (scanJob.composeId) {
				const compose = await findComposeById(scanJob.composeId);
				organizationId = compose.environment.project.organizationId;
			}
			if (!organizationId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid scan job target",
				});
			}

			if (organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access files for this scan job",
				});
			}

			return await listScanJobDirectory(input);
		}),

	readFile: protectedProcedure
		.input(
			z.object({
				scanJobId: z.string(),
				filePath: z.string(),
			}),
		)
		.query(async ({ input, ctx }) => {
			const scanJob = await findScanJobById(input.scanJobId);
			let organizationId: string | undefined;
			if (scanJob.applicationId) {
				const application = await findApplicationById(scanJob.applicationId);
				organizationId = application.environment.project.organizationId;
			}
			if (scanJob.composeId) {
				const compose = await findComposeById(scanJob.composeId);
				organizationId = compose.environment.project.organizationId;
			}
			if (!organizationId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid scan job target",
				});
			}

			if (organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access files for this scan job",
				});
			}

			return await readScanJobFileContent(input);
		}),

	listTaskDirectory: protectedProcedure
		.input(
			z.object({
				scanJobId: z.string().min(1),
				taskId: z.string().min(1),
				directoryPath: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			const task = await findTaskById(input.taskId);
			if (task.scanJobId !== input.scanJobId) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Task not found for this scan job",
				});
			}
			const scanJob = await findScanJobById(task.scanJobId);
			let organizationId: string | undefined;
			if (scanJob.applicationId) {
				const application = await findApplicationById(scanJob.applicationId);
				organizationId = application.environment.project.organizationId;
			}
			if (scanJob.composeId) {
				const compose = await findComposeById(scanJob.composeId);
				organizationId = compose.environment.project.organizationId;
			}
			if (!organizationId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid scan job target",
				});
			}

			if (organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access files for this scan task",
				});
			}

			return await listScanTaskDirectory(input);
		}),

	readTaskFile: protectedProcedure
		.input(
			z.object({
				scanJobId: z.string().min(1),
				taskId: z.string().min(1),
				filePath: z.string().min(1),
			}),
		)
		.query(async ({ input, ctx }) => {
			const task = await findTaskById(input.taskId);
			if (task.scanJobId !== input.scanJobId) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Task not found for this scan job",
				});
			}
			const scanJob = await findScanJobById(task.scanJobId);
			let organizationId: string | undefined;
			if (scanJob.applicationId) {
				const application = await findApplicationById(scanJob.applicationId);
				organizationId = application.environment.project.organizationId;
			}
			if (scanJob.composeId) {
				const compose = await findComposeById(scanJob.composeId);
				organizationId = compose.environment.project.organizationId;
			}
			if (!organizationId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid scan job target",
				});
			}

			if (organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access files for this scan task",
				});
			}

			return await readScanTaskFileContent(input);
		}),

	candidate: protectedProcedure
		.input(
			z.object({
				vulnerabilityCandidateId: z.string().min(1),
				scanJobId: z.string().min(1).optional(),
				producerTaskId: z.string().min(1).optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			const candidate = input.scanJobId
				? null
				: await findVulnerabilityCandidateById(input.vulnerabilityCandidateId);
			const candidateScanJobId = input.scanJobId || candidate?.scanJobId || "";
			const scanJob = await findScanJobById(candidateScanJobId);
			let organizationId: string | undefined;
			if (scanJob.applicationId) {
				const application = await findApplicationById(scanJob.applicationId);
				organizationId = application.environment.project.organizationId;
			}
			if (scanJob.composeId) {
				const compose = await findComposeById(scanJob.composeId);
				organizationId = compose.environment.project.organizationId;
			}
			if (!organizationId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid scan job target",
				});
			}

			if (organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access this candidate",
				});
			}

			const enrichedCandidate =
				await findVulnerabilityCandidateWithLatestAnalysisResultById({
					vulnerabilityCandidateId: input.vulnerabilityCandidateId,
					scanJobId: candidateScanJobId,
					producerTaskId: input.producerTaskId,
				});
			if (!enrichedCandidate) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Candidate not found",
				});
			}

			return enrichedCandidate;
		}),

	candidateTags: protectedProcedure.query(async () => {
		return await listCandidateTags();
	}),

	updateCandidateMetadata: protectedProcedure
		.input(apiUpdateCandidateMetadata)
		.mutation(async ({ input, ctx }) => {
			const scanJob = await findScanJobById(input.scanJobId);
			let organizationId: string | undefined;
			if (scanJob.applicationId) {
				const application = await findApplicationById(scanJob.applicationId);
				organizationId = application.environment.project.organizationId;
			}
			if (scanJob.composeId) {
				const compose = await findComposeById(scanJob.composeId);
				organizationId = compose.environment.project.organizationId;
			}
			if (!organizationId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid scan job target",
				});
			}

			if (organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to update this candidate",
				});
			}

				await findVulnerabilityCandidateWithLatestAnalysisResultById({
					vulnerabilityCandidateId: input.vulnerabilityCandidateId,
					scanJobId: input.scanJobId,
					producerTaskId: input.producerTaskId,
				});

			return await updateVulnerabilityCandidateMetadata(input);
		}),

		candidateTaskLineage: protectedProcedure
			.input(
				z.object({
					vulnerabilityCandidateId: z.string().min(1),
					scanJobId: z.string().min(1).optional(),
					producerTaskId: z.string().min(1).optional(),
				}),
			)
		.query(async ({ input, ctx }) => {
			const candidate = input.scanJobId
				? null
				: await findVulnerabilityCandidateById(input.vulnerabilityCandidateId);
			const candidateScanJobId = input.scanJobId || candidate?.scanJobId || "";
			const scanJob = await findScanJobById(candidateScanJobId);
			let organizationId: string | undefined;
			if (scanJob.applicationId) {
				const application = await findApplicationById(scanJob.applicationId);
				organizationId = application.environment.project.organizationId;
			}
			if (scanJob.composeId) {
				const compose = await findComposeById(scanJob.composeId);
				organizationId = compose.environment.project.organizationId;
			}
			if (!organizationId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid scan job target",
				});
			}

			if (organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access this candidate",
				});
			}

				return await findCandidateTaskLineage({
					vulnerabilityCandidateId: input.vulnerabilityCandidateId,
					scanJobId: candidateScanJobId,
					producerTaskId: input.producerTaskId,
				});
			}),

		analyzeCandidate: protectedProcedure
			.input(
				z.object({
					vulnerabilityCandidateId: z.string().min(1),
					scanJobId: z.string().min(1),
					producerTaskId: z.string().min(1).optional(),
				}),
			)
			.mutation(async ({ input, ctx }) => {
			const scanJob = await findScanJobById(input.scanJobId);
			let organizationId: string | undefined;
			if (scanJob.applicationId) {
				const application = await findApplicationById(scanJob.applicationId);
				organizationId = application.environment.project.organizationId;
			}
			if (scanJob.composeId) {
				const compose = await findComposeById(scanJob.composeId);
				organizationId = compose.environment.project.organizationId;
			}
			if (!organizationId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid scan job target",
				});
			}

			if (organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to analyze this candidate",
				});
			}

			const result = await startCandidateAnalysis(input);
			const queueData: ScanQueueJob = {
				scanJobId: result.scanJobId,
				mode: "full",
			};

			await scansQueue.add("scans", queueData, {
				jobId: `scan:reanalyze:${result.scanJobId}:${result.taskId}`,
				removeOnComplete: true,
				removeOnFail: true,
			});

			return result;
		}),

	startCandidateReviewContainer: protectedProcedure
		.input(apiStartCandidateReviewContainer)
		.mutation(async ({ input, ctx }) => {
			const scanJob = await findScanJobById(input.scanJobId);
			let organizationId: string | undefined;
			if (scanJob.applicationId) {
				const application = await findApplicationById(scanJob.applicationId);
				organizationId = application.environment.project.organizationId;
			}
			if (scanJob.composeId) {
				const compose = await findComposeById(scanJob.composeId);
				organizationId = compose.environment.project.organizationId;
			}
			if (!organizationId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid scan job target",
				});
			}
			if (organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message:
						"You are not authorized to launch a review container for this scan job",
				});
			}

			return await startCandidateReviewContainer(input);
		}),

	verifyCandidate: protectedProcedure
		.input(
			z.object({
				vulnerabilityCandidateId: z.string().min(1),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const candidate = await findVulnerabilityCandidateById(
				input.vulnerabilityCandidateId,
			);
			const scanJob = await findScanJobById(candidate.scanJobId);
			let organizationId: string | undefined;
			if (scanJob.applicationId) {
				const application = await findApplicationById(scanJob.applicationId);
				organizationId = application.environment.project.organizationId;
			}
			if (scanJob.composeId) {
				const compose = await findComposeById(scanJob.composeId);
				organizationId = compose.environment.project.organizationId;
			}
			if (!organizationId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid scan job target",
				});
			}

			if (organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to verify this candidate",
				});
			}

			return await startCandidateVerification(input.vulnerabilityCandidateId);
		}),

	candidateFilesTree: protectedProcedure
		.input(
			z.object({
				vulnerabilityCandidateId: z.string().min(1),
				scanJobId: z.string().min(1).optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			const candidate = input.scanJobId
				? null
				: await findVulnerabilityCandidateById(input.vulnerabilityCandidateId);
			const candidateScanJobId = input.scanJobId || candidate?.scanJobId || "";
			const scanJob = await findScanJobById(candidateScanJobId);
			let organizationId: string | undefined;
			if (scanJob.applicationId) {
				const application = await findApplicationById(scanJob.applicationId);
				organizationId = application.environment.project.organizationId;
			}
			if (scanJob.composeId) {
				const compose = await findComposeById(scanJob.composeId);
				organizationId = compose.environment.project.organizationId;
			}
			if (!organizationId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid scan job target",
				});
			}

			if (organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access candidate files",
				});
			}

			return await readCandidateFilesTree({
				scanJobId: candidateScanJobId,
				candidateId: input.vulnerabilityCandidateId,
			});
		}),

	readCandidateFile: protectedProcedure
		.input(
			z.object({
				vulnerabilityCandidateId: z.string().min(1),
				scanJobId: z.string().min(1).optional(),
				filePath: z.string().min(1),
			}),
		)
		.query(async ({ input, ctx }) => {
			const candidate = input.scanJobId
				? null
				: await findVulnerabilityCandidateById(input.vulnerabilityCandidateId);
			const candidateScanJobId = input.scanJobId || candidate?.scanJobId || "";
			const scanJob = await findScanJobById(candidateScanJobId);
			let organizationId: string | undefined;
			if (scanJob.applicationId) {
				const application = await findApplicationById(scanJob.applicationId);
				organizationId = application.environment.project.organizationId;
			}
			if (scanJob.composeId) {
				const compose = await findComposeById(scanJob.composeId);
				organizationId = compose.environment.project.organizationId;
			}
			if (!organizationId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid scan job target",
				});
			}

			if (organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access candidate files",
				});
			}

			return await readCandidateFileContent({
				scanJobId: candidateScanJobId,
				candidateId: input.vulnerabilityCandidateId,
				filePath: input.filePath,
			});
		}),

	scannerSession: protectedProcedure
		.input(
			z.object({
				stage: z.enum([
					"delta_scoping",
					"repository_scanning",
					"module_scanning",
					"function_scanning",
				]),
				taskId: z.string().min(1),
			}),
		)
		.query(async ({ input, ctx }) => {
			const session = await findScanJobSandboxAgentSession(input);
			if (!session) {
				return null;
			}

			const scanJob = await findScanJobById(session.scanJobId);
			let organizationId: string | undefined;
			if (scanJob.applicationId) {
				const application = await findApplicationById(scanJob.applicationId);
				organizationId = application.environment.project.organizationId;
			}
			if (scanJob.composeId) {
				const compose = await findComposeById(scanJob.composeId);
				organizationId = compose.environment.project.organizationId;
			}
			if (!organizationId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid scan job target",
				});
			}

			if (organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access this scan session",
				});
			}

			return {
				sessionId: session.sessionId,
				provider: session.provider,
				containerName: session.containerName,
				baseUrl: session.baseUrl,
			};
		}),

	candidateSession: protectedProcedure
		.input(
			z.object({
				vulnerabilityCandidateId: z.string().min(1),
				stage: z.enum(["analyzing", "verifying"]),
			}),
		)
		.query(async ({ input, ctx }) => {
			const candidate = await findVulnerabilityCandidateById(
				input.vulnerabilityCandidateId,
			);
			const scanJob = await findScanJobById(candidate.scanJobId);
			let organizationId: string | undefined;
			if (scanJob.applicationId) {
				const application = await findApplicationById(scanJob.applicationId);
				organizationId = application.environment.project.organizationId;
			}
			if (scanJob.composeId) {
				const compose = await findComposeById(scanJob.composeId);
				organizationId = compose.environment.project.organizationId;
			}
			if (!organizationId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid scan job target",
				});
			}

			if (organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access this candidate session",
				});
			}

			const session = await findCandidateSandboxAgentSession({
				candidateId: input.vulnerabilityCandidateId,
				stage: input.stage,
			});
			if (!session) {
				return null;
			}

			return {
				sessionId: session.sessionId,
				provider: session.provider,
				containerName: session.containerName,
				baseUrl: session.baseUrl,
			};
		}),

	jobOverview: protectedProcedure
		.input(apiFindOneScanJob)
		.query(async ({ input, ctx }) => {
			await authorizeScanJobRuntimeAccess(
				input.scanJobId,
				ctx.session.activeOrganizationId,
			);
			return await jobRuntimeStatusStore.readOverview(input.scanJobId);
		}),

	jobRunningTasks: protectedProcedure
		.input(apiFindOneScanJob)
		.query(async ({ input, ctx }) => {
			await authorizeScanJobRuntimeAccess(
				input.scanJobId,
				ctx.session.activeOrganizationId,
			);
			return await jobRuntimeStatusStore.readRunningTasks(input.scanJobId);
		}),

	jobQueueCounts: protectedProcedure
		.input(apiFindOneScanJob)
		.query(async ({ input, ctx }) => {
			await authorizeScanJobRuntimeAccess(
				input.scanJobId,
				ctx.session.activeOrganizationId,
			);
			return await jobRuntimeStatusStore.readQueueCounts(input.scanJobId);
		}),

	jobPipeline: protectedProcedure
		.input(apiFindOneScanJob)
		.query(async ({ input, ctx }) => {
			await authorizeScanJobRuntimeAccess(
				input.scanJobId,
				ctx.session.activeOrganizationId,
			);
			return await jobRuntimeStatusStore.readPipeline(input.scanJobId);
		}),

	terminalTasks: protectedProcedure
		.input(apiFindScanJobTerminalTasksPage)
		.query(async ({ input, ctx }) => {
			const scanJob = await findScanJobById(input.scanJobId);
			let organizationId: string | undefined;
			if (scanJob.applicationId) {
				const application = await findApplicationById(scanJob.applicationId);
				organizationId = application.environment.project.organizationId;
			}
			if (scanJob.composeId) {
				const compose = await findComposeById(scanJob.composeId);
				organizationId = compose.environment.project.organizationId;
			}
			if (!organizationId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid scan job target",
				});
			}

			if (organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access tasks for this scan job",
				});
			}

			return await findScanJobTerminalTasksPage(input);
		}),

	fullScanStageGraph: protectedProcedure
		.input(apiFindFullScanStageGraph)
		.query(async ({ input, ctx }) => {
			let organizationId: string | undefined;
			if (input.applicationId) {
				const application = await findApplicationById(input.applicationId);
				organizationId = application.environment.project.organizationId;
			}
			if (input.composeId) {
				const compose = await findComposeById(input.composeId);
				organizationId = compose.environment.project.organizationId;
			}
			if (!organizationId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid scan target",
				});
			}

			if (organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message:
						"You are not authorized to access stage graph for this scan target",
				});
			}

			return await findFullScanStageGraph(input);
		}),

	stageGraph: protectedProcedure
		.input(apiFindOneScanJob)
		.query(async ({ input, ctx }) => {
			const scanJob = await findScanJobById(input.scanJobId);
			let organizationId: string | undefined;
			if (scanJob.applicationId) {
				const application = await findApplicationById(scanJob.applicationId);
				organizationId = application.environment.project.organizationId;
			}
			if (scanJob.composeId) {
				const compose = await findComposeById(scanJob.composeId);
				organizationId = compose.environment.project.organizationId;
			}
			if (!organizationId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid scan job target",
				});
			}

			if (organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message:
						"You are not authorized to access stage graph for this scan job",
				});
			}

			return await findScanJobStageGraph(input.scanJobId);
		}),
});
