import { docker } from "@vulseek/server/constants";
import { db } from "@vulseek/server/db";
import {
	type apiCreateApplication,
	applications,
	buildAppName,
	buildDefaultScanStageSettings,
	renameAppNameBase,
} from "@vulseek/server/db/schema";
import { getAdvancedStats } from "@vulseek/server/monitoring/utils";
import {
	buildApplication,
	getBuildCommand,
	mechanizeDockerContainer,
} from "@vulseek/server/utils/builders";
import { sendBuildErrorNotifications } from "@vulseek/server/utils/notifications/build-error";
import { sendBuildSuccessNotifications } from "@vulseek/server/utils/notifications/build-success";
import { execAsyncRemote } from "@vulseek/server/utils/process/execAsync";
import {
	cloneBitbucketRepository,
	getBitbucketCloneCommand,
} from "@vulseek/server/utils/providers/bitbucket";
import {
	buildDocker,
	buildRemoteDocker,
} from "@vulseek/server/utils/providers/docker";
import {
	cloneGitRepository,
	getCustomGitCloneCommand,
} from "@vulseek/server/utils/providers/git";
import {
	cloneGiteaRepository,
	getGiteaCloneCommand,
} from "@vulseek/server/utils/providers/gitea";
import {
	cloneGithubRepository,
	getGithubCloneCommand,
} from "@vulseek/server/utils/providers/github";
import {
	cloneGitlabRepository,
	getGitlabCloneCommand,
} from "@vulseek/server/utils/providers/gitlab";
import { createTraefikConfig } from "@vulseek/server/utils/traefik/application";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { encodeBase64 } from "../utils/docker/utils";
import { getVulseekUrl } from "./admin";
import { getAgentProfilesByOrganizationId } from "./ai";
import {
	createDeployment,
	createDeploymentPreview,
	updateDeploymentStatus,
} from "./deployment";
import { type Domain, getDomainHost } from "./domain";
import { findEnvironmentById } from "./environment";
import {
	createPreviewDeploymentComment,
	getIssueComment,
	issueCommentExists,
	updateIssueComment,
} from "./github";
import {
	findPreviewDeploymentById,
	updatePreviewDeployment,
} from "./preview-deployment";
import { validUniqueServerAppName } from "./project";
import { createRollback } from "./rollbacks";
export type Application = typeof applications.$inferSelect;

export const createApplication = async (
	input: typeof apiCreateApplication._type,
) => {
	const appName = buildAppName("app", input.appName);
	const environment = await findEnvironmentById(input.environmentId);
	const defaultAgentProfile =
		(
			await getAgentProfilesByOrganizationId(environment.project.organizationId)
		).find((profile) => profile.isEnabled) || null;

	const valid = await validUniqueServerAppName(appName);
	if (!valid) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Application with this 'AppName' already exists",
		});
	}

	return await db.transaction(async (tx) => {
		const newApplication = await tx
			.insert(applications)
			.values({
				...input,
				appName,
				autoDeltaScan: false,
				scanStageSettings: buildDefaultScanStageSettings(
					defaultAgentProfile?.agentProfileId ?? null,
				),
			})
			.returning({
				applicationId: applications.applicationId,
				appName: applications.appName,
				name: applications.name,
				environmentId: applications.environmentId,
				serverId: applications.serverId,
			})
			.then((value) => value[0]);

		if (!newApplication) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error creating the application",
			});
		}

		if (process.env.NODE_ENV === "development") {
			createTraefikConfig(newApplication.appName);
		}

		return newApplication;
	});
};

export const findApplicationById = async (applicationId: string) => {
	const application = await db.query.applications.findFirst({
		where: eq(applications.applicationId, applicationId),
		with: {
			environment: {
				with: {
					project: true,
				},
			},
			domains: true,
			deployments: true,
			mounts: true,
			redirects: true,
			security: true,
			ports: true,
			registry: true,
			gitlab: true,
			github: true,
			bitbucket: true,
			gitea: true,
			server: true,
			previewDeployments: true,
			customGitSSHKey: true,
		},
	});
	if (!application) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Application not found",
		});
	}

	return application;
};

export const findApplicationByName = async (appName: string) => {
	const application = await db.query.applications.findFirst({
		where: eq(applications.appName, appName),
	});

	return application;
};

export const updateApplication = async (
	applicationId: string,
	applicationData: Partial<Application>,
) => {
	const currentApplication = await findApplicationById(applicationId);
	const { appName, ...rest } = applicationData;
	const nextName = rest.name?.trim();
	const shouldRenameAppName =
		typeof nextName === "string" &&
		nextName.length > 0 &&
		nextName !== currentApplication.name;
	const nextAppName = shouldRenameAppName
		? renameAppNameBase(currentApplication.appName, nextName)
		: currentApplication.appName;

	if (nextAppName !== currentApplication.appName) {
		const valid = await validUniqueServerAppName(nextAppName);
		if (!valid) {
			throw new TRPCError({
				code: "CONFLICT",
				message: "Application with this 'AppName' already exists",
			});
		}
	}

	const application = await db
		.update(applications)
		.set({
			...rest,
			appName: nextAppName,
		})
		.where(eq(applications.applicationId, applicationId))
		.returning();

	return application[0];
};

export const updateApplicationStatus = async (
	applicationId: string,
	applicationStatus: Application["applicationStatus"],
) => {
	const application = await db
		.update(applications)
		.set({
			applicationStatus: applicationStatus,
		})
		.where(eq(applications.applicationId, applicationId))
		.returning();

	return application;
};

export const deployApplication = async ({
	applicationId,
	titleLog = "Manual deployment",
	descriptionLog = "",
}: {
	applicationId: string;
	titleLog: string;
	descriptionLog: string;
}) => {
	const application = await findApplicationById(applicationId);

	const buildLink = `${await getVulseekUrl()}/dashboard/project/${application.environment.projectId}/environment/${application.environmentId}/profiles/application/${application.applicationId}?tab=deployments`;
	const deployment = await createDeployment({
		applicationId: applicationId,
		title: titleLog,
		description: descriptionLog,
	});

	try {
		if (application.sourceType === "github") {
			await cloneGithubRepository({
				...application,
				logPath: deployment.logPath,
			});
			await buildApplication(application, deployment.logPath);
		} else if (application.sourceType === "gitlab") {
			await cloneGitlabRepository(application, deployment.logPath);
			await buildApplication(application, deployment.logPath);
		} else if (application.sourceType === "gitea") {
			await cloneGiteaRepository(application, deployment.logPath);
			await buildApplication(application, deployment.logPath);
		} else if (application.sourceType === "bitbucket") {
			await cloneBitbucketRepository(application, deployment.logPath);
			await buildApplication(application, deployment.logPath);
		} else if (application.sourceType === "docker") {
			await buildDocker(application, deployment.logPath);
		} else if (application.sourceType === "git") {
			await cloneGitRepository(application, deployment.logPath);
			await buildApplication(application, deployment.logPath);
		} else if (application.sourceType === "drop") {
			await buildApplication(application, deployment.logPath);
		}

		await updateDeploymentStatus(deployment.deploymentId, "done");
		await updateApplicationStatus(applicationId, "done");

		if (application.rollbackActive) {
			const tagImage =
				application.sourceType === "docker"
					? application.dockerImage
					: application.appName;
			await createRollback({
				appName: tagImage || "",
				deploymentId: deployment.deploymentId,
			});
		}

		await sendBuildSuccessNotifications({
			projectName: application.environment.project.name,
			applicationName: application.name,
			applicationType: "application",
			buildLink,
			organizationId: application.environment.project.organizationId,
			domains: application.domains,
		});
	} catch (error) {
		await updateDeploymentStatus(deployment.deploymentId, "error");
		await updateApplicationStatus(applicationId, "error");

		await sendBuildErrorNotifications({
			projectName: application.environment.project.name,
			applicationName: application.name,
			applicationType: "application",
			// @ts-ignore
			errorMessage: error?.message || "Error building",
			buildLink,
			organizationId: application.environment.project.organizationId,
		});

		throw error;
	}

	return true;
};

export const rebuildApplication = async ({
	applicationId,
	titleLog = "Rebuild deployment",
	descriptionLog = "",
}: {
	applicationId: string;
	titleLog: string;
	descriptionLog: string;
}) => {
	const application = await findApplicationById(applicationId);

	const deployment = await createDeployment({
		applicationId: applicationId,
		title: titleLog,
		description: descriptionLog,
	});

	try {
		if (application.sourceType === "github") {
			await buildApplication(application, deployment.logPath);
		} else if (application.sourceType === "gitlab") {
			await buildApplication(application, deployment.logPath);
		} else if (application.sourceType === "bitbucket") {
			await buildApplication(application, deployment.logPath);
		} else if (application.sourceType === "docker") {
			await buildDocker(application, deployment.logPath);
		} else if (application.sourceType === "git") {
			await buildApplication(application, deployment.logPath);
		} else if (application.sourceType === "drop") {
			await buildApplication(application, deployment.logPath);
		}
		await updateDeploymentStatus(deployment.deploymentId, "done");
		await updateApplicationStatus(applicationId, "done");
	} catch (error) {
		await updateDeploymentStatus(deployment.deploymentId, "error");
		await updateApplicationStatus(applicationId, "error");
		throw error;
	}

	return true;
};

export const deployRemoteApplication = async ({
	applicationId,
	titleLog = "Manual deployment",
	descriptionLog = "",
}: {
	applicationId: string;
	titleLog: string;
	descriptionLog: string;
}) => {
	const application = await findApplicationById(applicationId);

	const buildLink = `${await getVulseekUrl()}/dashboard/project/${application.environment.projectId}/environment/${application.environmentId}/profiles/application/${application.applicationId}?tab=deployments`;
	const deployment = await createDeployment({
		applicationId: applicationId,
		title: titleLog,
		description: descriptionLog,
	});

	try {
		if (application.serverId) {
			let command = "set -e;";
			if (application.sourceType === "github") {
				command += await getGithubCloneCommand({
					...application,
					serverId: application.serverId,
					logPath: deployment.logPath,
				});
			} else if (application.sourceType === "gitlab") {
				command += await getGitlabCloneCommand(application, deployment.logPath);
			} else if (application.sourceType === "bitbucket") {
				command += await getBitbucketCloneCommand(
					application,
					deployment.logPath,
				);
			} else if (application.sourceType === "gitea") {
				command += await getGiteaCloneCommand(application, deployment.logPath);
			} else if (application.sourceType === "git") {
				command += await getCustomGitCloneCommand(
					application,
					deployment.logPath,
				);
			} else if (application.sourceType === "docker") {
				command += await buildRemoteDocker(application, deployment.logPath);
			}

			if (application.sourceType !== "docker") {
				command += getBuildCommand(application, deployment.logPath);
			}
			await execAsyncRemote(application.serverId, command);
			await mechanizeDockerContainer(application);
		}

		await updateDeploymentStatus(deployment.deploymentId, "done");
		await updateApplicationStatus(applicationId, "done");

		if (application.rollbackActive) {
			const tagImage =
				application.sourceType === "docker"
					? application.dockerImage
					: application.appName;
			await createRollback({
				appName: tagImage || "",
				deploymentId: deployment.deploymentId,
			});
		}

		await sendBuildSuccessNotifications({
			projectName: application.environment.project.name,
			applicationName: application.name,
			applicationType: "application",
			buildLink,
			organizationId: application.environment.project.organizationId,
			domains: application.domains,
		});
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);

		const encodedContent = encodeBase64(errorMessage);

		await execAsyncRemote(
			application.serverId,
			`
			echo "\n\n===================================EXTRA LOGS============================================" >> ${deployment.logPath};
			echo "Error occurred ❌, check the logs for details." >> ${deployment.logPath};
			echo "${encodedContent}" | base64 -d >> "${deployment.logPath}";`,
		);

		await updateDeploymentStatus(deployment.deploymentId, "error");
		await updateApplicationStatus(applicationId, "error");

		await sendBuildErrorNotifications({
			projectName: application.environment.project.name,
			applicationName: application.name,
			applicationType: "application",
			errorMessage: `Please check the logs for details: ${errorMessage}`,
			buildLink,
			organizationId: application.environment.project.organizationId,
		});

		throw error;
	}

	return true;
};

export const deployPreviewApplication = async ({
	applicationId,
	titleLog = "Preview Deployment",
	descriptionLog = "",
	previewDeploymentId,
}: {
	applicationId: string;
	titleLog: string;
	descriptionLog: string;
	previewDeploymentId: string;
}) => {
	const application = await findApplicationById(applicationId);

	const deployment = await createDeploymentPreview({
		title: titleLog,
		description: descriptionLog,
		previewDeploymentId: previewDeploymentId,
	});

	const previewDeployment =
		await findPreviewDeploymentById(previewDeploymentId);

	await updatePreviewDeployment(previewDeploymentId, {
		createdAt: new Date().toISOString(),
	});

	const previewDomain = getDomainHost(previewDeployment?.domain as Domain);
	const issueParams = {
		owner: application?.owner || "",
		repository: application?.repository || "",
		issue_number: previewDeployment.pullRequestNumber,
		comment_id: Number.parseInt(previewDeployment.pullRequestCommentId),
		githubId: application?.githubId || "",
	};
	try {
		const commentExists = await issueCommentExists({
			...issueParams,
		});
		if (!commentExists) {
			const result = await createPreviewDeploymentComment({
				...issueParams,
				previewDomain,
				appName: previewDeployment.appName,
				githubId: application?.githubId || "",
				previewDeploymentId,
			});

			if (!result) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Pull request comment not found",
				});
			}

			issueParams.comment_id = Number.parseInt(result?.pullRequestCommentId);
		}
		const buildingComment = getIssueComment(
			application.name,
			"running",
			previewDomain,
		);
		await updateIssueComment({
			...issueParams,
			body: `### Vulseek Preview Deployment\n\n${buildingComment}`,
		});
		application.appName = previewDeployment.appName;
		application.env = `${application.previewEnv}\nVULSEEK_DEPLOY_URL=${previewDeployment?.domain?.host}`;
		application.buildArgs = `${application.previewBuildArgs}\nVULSEEK_DEPLOY_URL=${previewDeployment?.domain?.host}`;
		application.buildSecrets = `${application.previewBuildSecrets}\nVULSEEK_DEPLOY_URL=${previewDeployment?.domain?.host}`;

		if (application.sourceType === "github") {
			await cloneGithubRepository({
				...application,
				appName: previewDeployment.appName,
				branch: previewDeployment.branch,
				logPath: deployment.logPath,
			});
			await buildApplication(application, deployment.logPath);
		}
		const successComment = getIssueComment(
			application.name,
			"success",
			previewDomain,
		);
		await updateIssueComment({
			...issueParams,
			body: `### Vulseek Preview Deployment\n\n${successComment}`,
		});
		await updateDeploymentStatus(deployment.deploymentId, "done");
		await updatePreviewDeployment(previewDeploymentId, {
			previewStatus: "done",
		});
	} catch (error) {
		const comment = getIssueComment(application.name, "error", previewDomain);
		await updateIssueComment({
			...issueParams,
			body: `### Vulseek Preview Deployment\n\n${comment}`,
		});
		await updateDeploymentStatus(deployment.deploymentId, "error");
		await updatePreviewDeployment(previewDeploymentId, {
			previewStatus: "error",
		});
		throw error;
	}

	return true;
};

export const deployRemotePreviewApplication = async ({
	applicationId,
	titleLog = "Preview Deployment",
	descriptionLog = "",
	previewDeploymentId,
}: {
	applicationId: string;
	titleLog: string;
	descriptionLog: string;
	previewDeploymentId: string;
}) => {
	const application = await findApplicationById(applicationId);

	const deployment = await createDeploymentPreview({
		title: titleLog,
		description: descriptionLog,
		previewDeploymentId: previewDeploymentId,
	});

	const previewDeployment =
		await findPreviewDeploymentById(previewDeploymentId);

	await updatePreviewDeployment(previewDeploymentId, {
		createdAt: new Date().toISOString(),
	});

	const previewDomain = getDomainHost(previewDeployment?.domain as Domain);
	const issueParams = {
		owner: application?.owner || "",
		repository: application?.repository || "",
		issue_number: previewDeployment.pullRequestNumber,
		comment_id: Number.parseInt(previewDeployment.pullRequestCommentId),
		githubId: application?.githubId || "",
	};
	try {
		const commentExists = await issueCommentExists({
			...issueParams,
		});
		if (!commentExists) {
			const result = await createPreviewDeploymentComment({
				...issueParams,
				previewDomain,
				appName: previewDeployment.appName,
				githubId: application?.githubId || "",
				previewDeploymentId,
			});

			if (!result) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Pull request comment not found",
				});
			}

			issueParams.comment_id = Number.parseInt(result?.pullRequestCommentId);
		}
		const buildingComment = getIssueComment(
			application.name,
			"running",
			previewDomain,
		);
		await updateIssueComment({
			...issueParams,
			body: `### Vulseek Preview Deployment\n\n${buildingComment}`,
		});
		application.appName = previewDeployment.appName;
		application.env = `${application.previewEnv}\nVULSEEK_DEPLOY_URL=${previewDeployment?.domain?.host}`;
		application.buildArgs = `${application.previewBuildArgs}\nVULSEEK_DEPLOY_URL=${previewDeployment?.domain?.host}`;
		application.buildSecrets = `${application.previewBuildSecrets}\nVULSEEK_DEPLOY_URL=${previewDeployment?.domain?.host}`;

		if (application.serverId) {
			let command = "set -e;";
			if (application.sourceType === "github") {
				command += await getGithubCloneCommand({
					...application,
					appName: previewDeployment.appName,
					branch: previewDeployment.branch,
					serverId: application.serverId,
					logPath: deployment.logPath,
				});
			}

			command += getBuildCommand(application, deployment.logPath);
			await execAsyncRemote(application.serverId, command);
			await mechanizeDockerContainer(application);
		}

		const successComment = getIssueComment(
			application.name,
			"success",
			previewDomain,
		);
		await updateIssueComment({
			...issueParams,
			body: `### Vulseek Preview Deployment\n\n${successComment}`,
		});
		await updateDeploymentStatus(deployment.deploymentId, "done");
		await updatePreviewDeployment(previewDeploymentId, {
			previewStatus: "done",
		});
	} catch (error) {
		const comment = getIssueComment(application.name, "error", previewDomain);
		await updateIssueComment({
			...issueParams,
			body: `### Vulseek Preview Deployment\n\n${comment}`,
		});
		await updateDeploymentStatus(deployment.deploymentId, "error");
		await updatePreviewDeployment(previewDeploymentId, {
			previewStatus: "error",
		});
		throw error;
	}

	return true;
};

export const rebuildRemoteApplication = async ({
	applicationId,
	titleLog = "Rebuild deployment",
	descriptionLog = "",
}: {
	applicationId: string;
	titleLog: string;
	descriptionLog: string;
}) => {
	const application = await findApplicationById(applicationId);

	const deployment = await createDeployment({
		applicationId: applicationId,
		title: titleLog,
		description: descriptionLog,
	});

	try {
		if (application.serverId) {
			if (application.sourceType !== "docker") {
				let command = "set -e;";
				command += getBuildCommand(application, deployment.logPath);
				await execAsyncRemote(application.serverId, command);
			}
			await mechanizeDockerContainer(application);
		}
		await updateDeploymentStatus(deployment.deploymentId, "done");
		await updateApplicationStatus(applicationId, "done");
	} catch (error) {
		// @ts-ignore
		const encodedContent = encodeBase64(error?.message);

		await execAsyncRemote(
			application.serverId,
			`
			echo "\n\n===================================EXTRA LOGS============================================" >> ${deployment.logPath};
			echo "Error occurred ❌, check the logs for details." >> ${deployment.logPath};
			echo "${encodedContent}" | base64 -d >> "${deployment.logPath}";`,
		);
		await updateDeploymentStatus(deployment.deploymentId, "error");
		await updateApplicationStatus(applicationId, "error");
		throw error;
	}

	return true;
};

export const getApplicationStats = async (appName: string) => {
	const filter = {
		status: ["running"],
		label: [`com.docker.swarm.service.name=${appName}`],
	};

	const containers = await docker.listContainers({
		filters: JSON.stringify(filter),
	});

	const container = containers[0];
	if (!container || container?.State !== "running") {
		return null;
	}

	const data = await getAdvancedStats(appName);

	return data;
};
