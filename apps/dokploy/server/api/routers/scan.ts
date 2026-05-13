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
	cancelScanJob,
	retryFailedScanJobTasks,
	startCandidateVerification,
	syncFullScanTasksFromArtifacts,
	findVulnerabilityCandidateById,
	findVulnerabilityCandidatesWithLatestAnalysisResultByScanJobId,
	listScanJobDirectory,
	readCandidateFileContent,
	readCandidateFilesTree,
	readScanJobAppServerText,
	readScanJobFileContent,
	startCheckoutScanEnvironment,
	updateScanJobNote,
	findScanJobSandboxAgentSession,
	findCandidateSandboxAgentSession,
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
	apiUpdateScanJobNote,
	apiFindVulnerabilityCandidatesByScanJob,
} from "@/server/db/schema";
import type { ScanQueueJob } from "@/server/queues/queue-types";
import { scansQueue } from "@/server/queues/queueSetup";
import { createTRPCRouter, protectedProcedure } from "../trpc";
import { z } from "zod";

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

	candidate: protectedProcedure
		.input(
			z.object({
				vulnerabilityCandidateId: z.string().min(1),
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
					message: "You are not authorized to access this candidate",
				});
			}

			const candidates =
				await findVulnerabilityCandidatesWithLatestAnalysisResultByScanJobId(
					candidate.scanJobId,
				);
			const enrichedCandidate = candidates.find(
				(item) => item.vulnerabilityCandidateId === candidate.vulnerabilityCandidateId,
			);
			if (!enrichedCandidate) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Candidate not found",
				});
			}

			return enrichedCandidate;
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
					message: "You are not authorized to access candidate files",
				});
			}

			return await readCandidateFilesTree({
				scanJobId: candidate.scanJobId,
				candidateId: candidate.vulnerabilityCandidateId,
			});
		}),

	readCandidateFile: protectedProcedure
		.input(
			z.object({
				vulnerabilityCandidateId: z.string().min(1),
				filePath: z.string().min(1),
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
					message: "You are not authorized to access candidate files",
				});
			}

			return await readCandidateFileContent({
				scanJobId: candidate.scanJobId,
				candidateId: candidate.vulnerabilityCandidateId,
				filePath: input.filePath,
			});
		}),

	scannerSession: protectedProcedure
		.input(
			z.object({
				stage: z.enum([
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
