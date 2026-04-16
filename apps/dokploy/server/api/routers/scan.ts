import {
	findCheckoutStatus,
	findCheckoutImageStatus,
	findRunningCheckoutTask,
	createScanJob,
	findAllScanJobsByApplicationId,
	findAllScanJobsByComposeId,
	findApplicationById,
	findComposeById,
	findScanJobById,
	findScanJobStatusView,
	findVulnerabilityCandidatesWithLatestAnalysisResultByScanJobId,
	startCheckoutScanEnvironment,
} from "@dokploy/server";
import { TRPCError } from "@trpc/server";
import {
	apiCheckoutScanEnvironment,
	apiCreateScanJob,
	apiFindCheckoutStatus,
	apiFindRunningCheckout,
	apiFindOneScanJob,
	apiFindScanJobsByApplication,
	apiFindScanJobsByCompose,
	apiFindVulnerabilityCandidatesByScanJob,
} from "@/server/db/schema";
import type { ScanQueueJob } from "@/server/queues/queue-types";
import { scansQueue } from "@/server/queues/queueSetup";
import { createTRPCRouter, protectedProcedure } from "../trpc";

export const scanRouter = createTRPCRouter({
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
					message: "You are not authorized to access scan jobs for this application",
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
					message: "You are not authorized to access scan jobs for this compose",
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

	candidates: protectedProcedure
		.input(apiFindVulnerabilityCandidatesByScanJob)
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
					message: "You are not authorized to access candidates for this scan job",
				});
			}

			return await findVulnerabilityCandidatesWithLatestAnalysisResultByScanJobId(
				input.scanJobId,
			);
		}),

	statusView: protectedProcedure
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
					message: "You are not authorized to access status for this scan job",
				});
			}

			return await findScanJobStatusView(input.scanJobId);
		}),
});
