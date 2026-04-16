import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { db } from "@dokploy/server/db";
import {
	analysisResults,
	type apiCheckoutScanEnvironment,
	type apiCreateScanJob,
	scanJobs,
	scanJobStatusEnum,
	vulnerabilityCandidateStatusEnum,
	vulnerabilityCandidates,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { execAsync } from "../utils/process/execAsync";
import { getGlobalContainerEnvironmentPairs } from "../utils/docker/utils";
import { findApplicationById } from "./application";
import { findComposeById } from "./compose";

export const DEFAULT_DELTA_COMMIT_WINDOW = 3;

export type ScanJob = typeof scanJobs.$inferSelect;
export type VulnerabilityCandidate = typeof vulnerabilityCandidates.$inferSelect;
export type AnalysisResult = typeof analysisResults.$inferSelect;
type VulnerabilityCandidateStage = "analyzing" | "fuzzing";

type ScanBridgeEventRecord = {
	recordedAt: string;
	type: "candidate" | "candidate_batch" | "next_stage" | "analysis_result";
	payload: Record<string, unknown>;
};

type JsonRpcMessage = {
	id?: number | string;
	method?: string;
	params?: Record<string, unknown>;
	result?: Record<string, unknown>;
	error?: {
		code?: number;
		message?: string;
		data?: unknown;
	};
};

type ScanRuntimeLiveAction = {
	itemId: string;
	itemType: string;
	actionType: string;
	actionText: string;
};

const ANALYSIS_CONCURRENCY = 2;

type AgentProfileLike = {
	agentProfileId: string;
	name: string;
	provider: "codex" | "claude_code";
	baseUrl: string;
	apiKey: string;
	model: string;
	thinkingLevel: string;
	isEnabled: boolean;
};

const extractNamedString = (
	value: unknown,
	keys: string[],
): string | null => {
	if (!value || typeof value !== "object") {
		return null;
	}

	const record = value as Record<string, unknown>;
	for (const key of keys) {
		if (typeof record[key] === "string") {
			return record[key] as string;
		}
	}

	return null;
};

const extractTurnErrorMessage = (value: unknown): string | null => {
	if (!value || typeof value !== "object") {
		return null;
	}

	const record = value as Record<string, unknown>;
	const directMessage = extractNamedString(record.error, ["message"]);
	if (directMessage) {
		return directMessage;
	}

	return extractNamedString(value, ["message", "additionalDetails"]);
};

export const createScanJob = async (input: typeof apiCreateScanJob._type) => {
	const created = await db
		.insert(scanJobs)
		.values({
			applicationId: input.applicationId,
			composeId: input.composeId,
			scanType: input.scanType,
			title:
				input.title ||
				(input.scanType === "delta" ? "Delta Scan Job" : "Full Scan Job"),
			description: input.description || "",
			triggerSource: input.triggerSource || "manual",
			commitSha: input.commitSha,
			baseSha: input.baseSha,
			targetRef: input.targetRef,
			targetTag: input.targetTag,
			commitWindow: input.commitWindow || DEFAULT_DELTA_COMMIT_WINDOW,
			status: "queued",
		})
		.returning();

	if (!created[0]) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error creating scan job",
		});
	}

	return created[0];
};

export const findScanJobById = async (scanJobId: string) => {
	const scanJob = await db
		.select()
		.from(scanJobs)
		.where(eq(scanJobs.scanJobId, scanJobId))
		.limit(1)
		.then((rows) => rows[0]);

	if (!scanJob) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Scan job not found",
		});
	}

	return scanJob;
};

export const findAllScanJobsByApplicationId = async (applicationId: string) =>
	await db
		.select()
		.from(scanJobs)
		.where(eq(scanJobs.applicationId, applicationId))
		.orderBy(desc(scanJobs.createdAt));

export const findAllScanJobsByComposeId = async (composeId: string) =>
	await db
		.select()
		.from(scanJobs)
		.where(eq(scanJobs.composeId, composeId))
		.orderBy(desc(scanJobs.createdAt));

export const updateScanJobStatus = async (
	scanJobId: string,
	status: (typeof scanJobStatusEnum.enumValues)[number],
	errorMessage?: string,
) => {
	const patch: Partial<ScanJob> = {
		status,
	};

	if (status === "scanning") {
		patch.startedAt = new Date().toISOString();
	}

	if (status === "completed" || status === "failed") {
		patch.finishedAt = new Date().toISOString();
	}

	if (errorMessage) {
		patch.errorMessage = errorMessage;
	}

	const updated = await db
		.update(scanJobs)
		.set(patch)
		.where(eq(scanJobs.scanJobId, scanJobId))
		.returning();

	if (!updated[0]) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Scan job not found",
		});
	}

	return updated[0];
};

const updateScanJobScanningThreadId = async (
	scanJobId: string,
	scanningThreadId: string,
) => {
	const updated = await db
		.update(scanJobs)
		.set({
			scanningThreadId,
		})
		.where(eq(scanJobs.scanJobId, scanJobId))
		.returning();

	return updated[0] || null;
};

const updateScanJobTargetContext = async (
	scanJobId: string,
	input: {
		targetRef?: string | null;
		targetTag?: string | null;
		commitSha?: string | null;
		baseSha?: string | null;
		commitWindow?: number | null;
	},
) => {
	const patch: Partial<ScanJob> = {};

	if (input.targetRef !== undefined) {
		patch.targetRef = input.targetRef || null;
	}
	if (input.targetTag !== undefined) {
		patch.targetTag = input.targetTag || null;
	}
	if (input.commitSha !== undefined) {
		patch.commitSha = input.commitSha || null;
	}
	if (input.baseSha !== undefined) {
		patch.baseSha = input.baseSha || null;
	}
	if (typeof input.commitWindow === "number") {
		patch.commitWindow = input.commitWindow;
	}

	const updated = await db
		.update(scanJobs)
		.set(patch)
		.where(eq(scanJobs.scanJobId, scanJobId))
		.returning();

	return updated[0] || null;
};

export const createVulnerabilityCandidate = async (input: {
	scanJobId: string;
	title: string;
	description?: string;
	filePath?: string;
	line?: number;
	confidence?: number;
	status?: (typeof vulnerabilityCandidateStatusEnum.enumValues)[number];
	currentStage?: VulnerabilityCandidateStage;
}) => {
	const created = await db
		.insert(vulnerabilityCandidates)
		.values({
			scanJobId: input.scanJobId,
			title: input.title,
			description: input.description || "",
			filePath: input.filePath,
			line: input.line,
			confidence: input.confidence,
			status: input.status || "queued",
			currentStage: input.currentStage || "analyzing",
			updatedAt: new Date().toISOString(),
		})
		.returning();

	if (!created[0]) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error creating vulnerability candidate",
		});
	}

	return created[0];
};

export const findVulnerabilityCandidatesByScanJobId = async (scanJobId: string) =>
	await db
		.select()
		.from(vulnerabilityCandidates)
		.where(eq(vulnerabilityCandidates.scanJobId, scanJobId))
		.orderBy(desc(vulnerabilityCandidates.createdAt));

export const findVulnerabilityCandidatesWithLatestAnalysisResultByScanJobId = async (
	scanJobId: string,
) => {
	const [candidates, analysisResultsList] = await Promise.all([
		findVulnerabilityCandidatesByScanJobId(scanJobId),
		findAnalysisResultsByScanJobId(scanJobId),
	]);

	const latestAnalysisResultByCandidateId = new Map<string, AnalysisResult>();
	for (const analysisResult of analysisResultsList) {
		if (
			!latestAnalysisResultByCandidateId.has(
				analysisResult.vulnerabilityCandidateId,
			)
		) {
			latestAnalysisResultByCandidateId.set(
				analysisResult.vulnerabilityCandidateId,
				analysisResult as AnalysisResult,
			);
		}
	}

	return candidates.map((candidate) => {
		const latestAnalysisResult = latestAnalysisResultByCandidateId.get(
			candidate.vulnerabilityCandidateId,
		);

		return {
			...candidate,
			latestAnalysisResult: latestAnalysisResult
				? {
						analysisResultId: latestAnalysisResult.analysisResultId,
						result: latestAnalysisResult.result,
						reportPath: latestAnalysisResult.reportPath,
						runtimeSeconds: latestAnalysisResult.runtimeSeconds,
						threadId: latestAnalysisResult.threadId,
						summary: latestAnalysisResult.summary,
						createdAt: latestAnalysisResult.createdAt,
						updatedAt: latestAnalysisResult.updatedAt,
					}
				: null,
		};
	});
};

export const findVulnerabilityCandidateById = async (
	vulnerabilityCandidateId: string,
) => {
	const candidate = await db
		.select()
		.from(vulnerabilityCandidates)
		.where(
			eq(
				vulnerabilityCandidates.vulnerabilityCandidateId,
				vulnerabilityCandidateId,
			),
		)
		.limit(1)
		.then((rows) => rows[0]);

	if (!candidate) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Vulnerability candidate not found",
		});
	}

	return candidate;
};

const updateVulnerabilityCandidateCurrentStage = async (
	vulnerabilityCandidateId: string,
	currentStage: VulnerabilityCandidateStage,
) => {
	const updated = await db
		.update(vulnerabilityCandidates)
		.set({
			currentStage,
			updatedAt: new Date().toISOString(),
		})
		.where(
			eq(
				vulnerabilityCandidates.vulnerabilityCandidateId,
				vulnerabilityCandidateId,
			),
		)
		.returning();

	return updated[0] || null;
};

const updateVulnerabilityCandidateStatus = async (
	vulnerabilityCandidateId: string,
	status: (typeof vulnerabilityCandidateStatusEnum.enumValues)[number],
) => {
	const updated = await db
		.update(vulnerabilityCandidates)
		.set({
			status,
			updatedAt: new Date().toISOString(),
		})
		.where(
			eq(
				vulnerabilityCandidates.vulnerabilityCandidateId,
				vulnerabilityCandidateId,
			),
		)
		.returning();

	return updated[0] || null;
};

const updateVulnerabilityCandidateAnalysisThreadId = async (
	vulnerabilityCandidateId: string,
	threadId: string,
) => {
	const patch: Partial<VulnerabilityCandidate> = {};
	patch.analysisThreadId = threadId;
	patch.updatedAt = new Date().toISOString();

	const updated = await db
		.update(vulnerabilityCandidates)
		.set(patch)
		.where(
			eq(
				vulnerabilityCandidates.vulnerabilityCandidateId,
				vulnerabilityCandidateId,
			),
		)
		.returning();

	return updated[0] || null;
};

export const createAnalysisResult = async (input: {
	scanJobId: string;
	vulnerabilityCandidateId: string;
	result: string;
	reportPath?: string;
	runtimeSeconds?: number;
	threadId?: string;
	summary?: string;
}) => {
	const created = await db
		.insert(analysisResults)
		.values({
			scanJobId: input.scanJobId,
			vulnerabilityCandidateId: input.vulnerabilityCandidateId,
			result: input.result,
			reportPath: input.reportPath,
			runtimeSeconds: input.runtimeSeconds,
			threadId: input.threadId,
			summary: input.summary || "",
			updatedAt: new Date().toISOString(),
		})
		.returning();

	if (!created[0]) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error creating analysis result",
		});
	}

	return created[0];
};

export const findAnalysisResultsByScanJobId = async (scanJobId: string) =>
	await db
		.select({
			analysisResultId: analysisResults.analysisResultId,
			scanJobId: analysisResults.scanJobId,
			vulnerabilityCandidateId: analysisResults.vulnerabilityCandidateId,
			result: analysisResults.result,
			reportPath: analysisResults.reportPath,
			runtimeSeconds: analysisResults.runtimeSeconds,
			threadId: analysisResults.threadId,
			summary: analysisResults.summary,
			createdAt: analysisResults.createdAt,
			updatedAt: analysisResults.updatedAt,
		})
		.from(analysisResults)
		.innerJoin(
			vulnerabilityCandidates,
			eq(
				analysisResults.vulnerabilityCandidateId,
				vulnerabilityCandidates.vulnerabilityCandidateId,
			),
		)
		.where(eq(vulnerabilityCandidates.scanJobId, scanJobId))
		.orderBy(desc(analysisResults.createdAt));

const deleteAnalysisResultsByCandidateId = async (
	vulnerabilityCandidateId: string,
) => {
	await db
		.delete(analysisResults)
		.where(
			eq(
				analysisResults.vulnerabilityCandidateId,
				vulnerabilityCandidateId,
			),
		);
};

const toGitUrl = (
	provider: "github" | "gitlab" | "bitbucket" | "gitea",
	owner: string,
	repository: string,
	giteaHost?: string | null,
) => {
	const cleanedRepo = repository.replace(/\.git$/, "");
	if (cleanedRepo.includes("/")) {
		if (provider === "github") return `https://github.com/${cleanedRepo}.git`;
		if (provider === "gitlab") return `https://gitlab.com/${cleanedRepo}.git`;
		if (provider === "bitbucket")
			return `https://bitbucket.org/${cleanedRepo}.git`;
		return `https://${giteaHost || "gitea.local"}/${cleanedRepo}.git`;
	}
	if (provider === "github") return `https://github.com/${owner}/${cleanedRepo}.git`;
	if (provider === "gitlab") return `https://gitlab.com/${owner}/${cleanedRepo}.git`;
	if (provider === "bitbucket")
		return `https://bitbucket.org/${owner}/${cleanedRepo}.git`;
	return `https://${giteaHost || "gitea.local"}/${owner}/${cleanedRepo}.git`;
};

const isUrlLike = (value?: string | null) =>
	Boolean(value && /^(https?:\/\/|git@)/.test(value));

const buildScanDockerfileTemplate = () => `FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive
ARG GIT_URL="<GIT_URL>"
ARG GIT_BRANCH="<GIT_BRANCH>"
ARG ENABLE_SUBMODULES="false"
ARG CODEQL_VERSION="2.20.6"

RUN apt-get update && apt-get install -y --no-install-recommends \\
    ca-certificates curl wget git jq unzip zip tar xz-utils file gnupg \\
    openssh-client ripgrep vim nano less rsync tree \\
    build-essential cmake ninja-build make autoconf automake libtool pkg-config \\
    clang lldb lld gdb \\
    python3 python3-pip python3-venv \\
    software-properties-common \\
    && rm -rf /var/lib/apt/lists/*

# Node.js (LTS)
RUN curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - \\
    && apt-get update && apt-get install -y --no-install-recommends nodejs \\
    && rm -rf /var/lib/apt/lists/*

# LLM Agent CLIs
# Keep Claude non-fatal to avoid blocking build if registry/network fails.
RUN npm install -g @anthropic-ai/claude-code || true
# Codex CLI is required for scan agents.
RUN npm install -g @openai/codex \
    && codex --version

# CodeQL CLI
RUN mkdir -p /opt/codeql \\
    && curl -L "https://github.com/github/codeql-cli-binaries/releases/download/v\${CODEQL_VERSION}/codeql-linux64.zip" -o /tmp/codeql.zip \\
    && unzip -q /tmp/codeql.zip -d /opt \\
    && rm -f /tmp/codeql.zip \\
    && ln -sf /opt/codeql/codeql /usr/local/bin/codeql

WORKDIR /workspace

RUN if [ "\${ENABLE_SUBMODULES}" = "true" ]; then \\
      git clone --progress --recursive --branch "\${GIT_BRANCH}" "\${GIT_URL}" repo; \\
    else \\
      git clone --progress --branch "\${GIT_BRANCH}" "\${GIT_URL}" repo; \\
    fi

WORKDIR /workspace/repo
CMD ["/bin/bash"]
`;

type CheckoutStatus = "running" | "completed" | "failed";

type CheckoutTask = {
	checkoutId: string;
	status: CheckoutStatus;
	imageTag: string;
	gitUrl: string;
	gitBranch: string;
	enableSubmodules: boolean;
	dockerfileTemplate: string;
	stdout: string;
	stderr: string;
	errorMessage?: string;
	startedAt: string;
	finishedAt?: string;
	applicationId?: string;
	composeId?: string;
};

const checkoutTasks = new Map<string, CheckoutTask>();
const MAX_LOG_CHARS = 400_000;

const appendLog = (base: string, chunk: string) => {
	const combined = `${base}${chunk}`;
	if (combined.length <= MAX_LOG_CHARS) return combined;
	return combined.slice(combined.length - MAX_LOG_CHARS);
};

const sanitizeForImageTag = (value: string) =>
	value
		.toLowerCase()
		.replace(/[^a-z0-9_.-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40) || "scan";

const resolveCheckoutContext = async (
	input: typeof apiCheckoutScanEnvironment._type,
) => {
	const dockerfileTemplate = buildScanDockerfileTemplate();
	let gitUrl = "<GIT_URL>";
	let gitBranch = "<GIT_BRANCH>";
	let enableSubmodules = false;
	let imageNameSeed = "scan";

	if (input.applicationId) {
		const application = await findApplicationById(input.applicationId);
		imageNameSeed = application.appName || application.name || application.applicationId;
		enableSubmodules = application.enableSubmodules ?? false;
		switch (application.sourceType) {
			case "git":
				gitUrl = application.customGitUrl || "<GIT_URL>";
				gitBranch = application.customGitBranch || "main";
				break;
			case "github":
				gitUrl =
					(isUrlLike(application.repository) ? application.repository : undefined) ||
					(application.owner && application.repository
						? toGitUrl("github", application.owner, application.repository)
						: "<GIT_URL>");
				gitBranch = application.branch || "main";
				break;
			case "gitlab":
				gitUrl =
					(isUrlLike(application.gitlabRepository)
						? application.gitlabRepository
						: undefined) ||
					(application.gitlabOwner && application.gitlabRepository
						? toGitUrl(
								"gitlab",
								application.gitlabOwner,
								application.gitlabRepository,
							)
						: "<GIT_URL>");
				gitBranch = application.gitlabBranch || "main";
				break;
			case "bitbucket":
				gitUrl =
					(isUrlLike(application.bitbucketRepository)
						? application.bitbucketRepository
						: undefined) ||
					(application.bitbucketOwner && application.bitbucketRepository
						? toGitUrl(
								"bitbucket",
								application.bitbucketOwner,
								application.bitbucketRepository,
							)
						: "<GIT_URL>");
				gitBranch = application.bitbucketBranch || "main";
				break;
			case "gitea":
				gitUrl =
					(isUrlLike(application.giteaRepository)
						? application.giteaRepository
						: undefined) ||
					(application.giteaOwner && application.giteaRepository
						? toGitUrl(
								"gitea",
								application.giteaOwner,
								application.giteaRepository,
								application.gitea?.giteaUrl || null,
							)
						: "<GIT_URL>");
				gitBranch = application.giteaBranch || "main";
				break;
			default:
				gitUrl = "<GIT_URL>";
				gitBranch = "main";
		}
	}

	if (input.composeId) {
		const compose = await findComposeById(input.composeId);
		imageNameSeed = compose.appName || compose.name || compose.composeId;
		enableSubmodules = compose.enableSubmodules ?? false;
		switch (compose.sourceType) {
			case "git":
				gitUrl = compose.customGitUrl || "<GIT_URL>";
				gitBranch = compose.customGitBranch || "main";
				break;
			case "github":
				gitUrl =
					(isUrlLike(compose.repository) ? compose.repository : undefined) ||
					(compose.owner && compose.repository
						? toGitUrl("github", compose.owner, compose.repository)
						: "<GIT_URL>");
				gitBranch = compose.branch || "main";
				break;
			case "gitlab":
				gitUrl =
					(isUrlLike(compose.gitlabRepository) ? compose.gitlabRepository : undefined) ||
					(compose.gitlabOwner && compose.gitlabRepository
						? toGitUrl("gitlab", compose.gitlabOwner, compose.gitlabRepository)
						: "<GIT_URL>");
				gitBranch = compose.gitlabBranch || "main";
				break;
			case "bitbucket":
				gitUrl =
					(isUrlLike(compose.bitbucketRepository)
						? compose.bitbucketRepository
						: undefined) ||
					(compose.bitbucketOwner && compose.bitbucketRepository
						? toGitUrl(
								"bitbucket",
								compose.bitbucketOwner,
								compose.bitbucketRepository,
							)
						: "<GIT_URL>");
				gitBranch = compose.bitbucketBranch || "main";
				break;
			case "gitea":
				gitUrl =
					(isUrlLike(compose.giteaRepository) ? compose.giteaRepository : undefined) ||
					(compose.giteaOwner && compose.giteaRepository
						? toGitUrl(
								"gitea",
								compose.giteaOwner,
								compose.giteaRepository,
								compose.gitea?.giteaUrl || null,
							)
						: "<GIT_URL>");
				gitBranch = compose.giteaBranch || "main";
				break;
			default:
				gitUrl = "<GIT_URL>";
				gitBranch = "main";
		}
	}

	const imageTag = `vulseek-scan-${sanitizeForImageTag(imageNameSeed)}:latest`;
	return {
		imageTag,
		gitUrl,
		gitBranch,
		enableSubmodules,
		dockerfileTemplate,
	};
};

const runDockerBuildInBackground = async (task: CheckoutTask) => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dokploy-scan-checkout-"));
	const dockerfilePath = path.join(tempDir, "Dockerfile.scan");
	const args = [
		"build",
		"-f",
		dockerfilePath,
		"-t",
		task.imageTag,
		"--build-arg",
		`GIT_URL=${task.gitUrl}`,
		"--build-arg",
		`GIT_BRANCH=${task.gitBranch}`,
		"--build-arg",
		`ENABLE_SUBMODULES=${task.enableSubmodules ? "true" : "false"}`,
	];
	const containerBuildArgs = getGlobalContainerEnvironmentPairs();
	for (const pair of containerBuildArgs) {
		args.push("--build-arg", pair);
	}
	args.push(tempDir);

	try {
		await fs.writeFile(dockerfilePath, task.dockerfileTemplate, "utf-8");
		await new Promise<void>((resolve, reject) => {
			const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
			child.stdout.on("data", (chunk) => {
				const latest = checkoutTasks.get(task.checkoutId);
				if (!latest) return;
				latest.stdout = appendLog(latest.stdout, chunk.toString());
			});
			child.stderr.on("data", (chunk) => {
				const latest = checkoutTasks.get(task.checkoutId);
				if (!latest) return;
				latest.stderr = appendLog(latest.stderr, chunk.toString());
			});
			child.on("error", (error) => reject(error));
			child.on("close", (code) => {
				if (code === 0) {
					resolve();
					return;
				}
				reject(new Error(`docker build failed with code ${code}`));
			});
		});

		const latest = checkoutTasks.get(task.checkoutId);
		if (latest) {
			latest.status = "completed";
			latest.finishedAt = new Date().toISOString();
		}
	} catch (error) {
		const latest = checkoutTasks.get(task.checkoutId);
		if (latest) {
			latest.status = "failed";
			latest.errorMessage =
				error instanceof Error ? error.message : "Unknown checkout error";
			latest.finishedAt = new Date().toISOString();
		}
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
};

export const startCheckoutScanEnvironment = async (
	input: typeof apiCheckoutScanEnvironment._type,
) => {
	const context = await resolveCheckoutContext(input);
	const checkoutId = nanoid();
	const task: CheckoutTask = {
		checkoutId,
		status: "running",
		imageTag: context.imageTag,
		gitUrl: context.gitUrl,
		gitBranch: context.gitBranch,
		enableSubmodules: context.enableSubmodules,
		dockerfileTemplate: context.dockerfileTemplate,
		stdout: "",
		stderr: "",
		startedAt: new Date().toISOString(),
		applicationId: input.applicationId,
		composeId: input.composeId,
	};
	checkoutTasks.set(checkoutId, task);
	void runDockerBuildInBackground(task);
	return {
		checkoutId,
		status: task.status,
		imageTag: task.imageTag,
		gitUrl: task.gitUrl,
		gitBranch: task.gitBranch,
		enableSubmodules: task.enableSubmodules,
	};
};

export const findCheckoutStatus = async (checkoutId: string) => {
	const task = checkoutTasks.get(checkoutId);
	if (!task) {
		return null;
	}

	let dockerBuildProbe = "unknown";
	try {
		const probe = await new Promise<string>((resolve, reject) => {
			const child = spawn("docker", [
				"ps",
				"--format",
				"{{.Image}} {{.Names}}",
			]);
			let output = "";
			child.stdout.on("data", (chunk) => {
				output += chunk.toString();
			});
			child.on("error", (error) => reject(error));
			child.on("close", (code) => {
				if (code !== 0) {
					reject(new Error(`docker ps failed with code ${code}`));
					return;
				}
				resolve(output);
			});
		});
		dockerBuildProbe = /buildkit|buildx|moby\/buildkit/i.test(probe)
			? "buildkit-container-running"
			: "no-buildkit-container-detected";
	} catch {
		dockerBuildProbe = "docker-ps-probe-failed";
	}

	return {
		...task,
		dockerBuildProbe,
	};
};

export const findRunningCheckoutTask = async (input: {
	applicationId?: string;
	composeId?: string;
}) => {
	for (const task of checkoutTasks.values()) {
		if (task.status !== "running") continue;
		if (input.applicationId && task.applicationId === input.applicationId) {
			return task;
		}
		if (input.composeId && task.composeId === input.composeId) {
			return task;
		}
	}
	return null;
};

export const findCheckoutImageStatus = async (
	input: typeof apiCheckoutScanEnvironment._type,
) => {
	const context = await resolveCheckoutContext(input);
	try {
		await execAsync(`docker image inspect ${context.imageTag}`);
		return {
			exists: true,
			imageTag: context.imageTag,
		};
	} catch {
		return {
			exists: false,
			imageTag: context.imageTag,
		};
	}
};

const escapeSingleQuotes = (value: string) => value.replace(/'/g, `'\"'\"'`);
const sanitizeContainerNamePart = (value: string) =>
	value
		.toLowerCase()
		.replace(/[^a-z0-9_.-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "") || "x";

const toImageTagFromAppName = (appName: string) =>
	`vulseek-scan-${sanitizeForImageTag(appName)}:latest`;

const sanitizeProviderName = (value: string) =>
	value.toLowerCase().replace(/[^a-z0-9_-]/g, "-") || "provider";

const buildCodexConfigToml = (agentProfile: AgentProfileLike) => {
	const providerName = sanitizeProviderName(agentProfile.agentProfileId);

	return [
		`model = "${agentProfile.model}"`,
		`model_reasoning_effort = "${agentProfile.thinkingLevel}"`,
		`model_provider = "${providerName}"`,
		`preferred_auth_method = "apikey"`,
		"",
		`[model_providers.${providerName}]`,
		`name = "${providerName}"`,
		`base_url = "${agentProfile.baseUrl}"`,
		`wire_api = "responses"`,
		"",
	].join("\n");
};

const buildCodexAuthJson = (agentProfile: AgentProfileLike) =>
	JSON.stringify(
		{
			OPENAI_API_KEY: agentProfile.apiKey,
		},
		null,
		2,
	);

const isAnthropicHostedBaseUrl = (baseUrl: string) => {
	try {
		const url = new URL(baseUrl);
		return /(^|\.)anthropic\.com$/i.test(url.hostname);
	} catch {
		return false;
	}
};

const buildClaudeEnvPairs = (agentProfile: AgentProfileLike) => {
	const envPairs = [
		`ANTHROPIC_BASE_URL=${agentProfile.baseUrl}`,
		`CLAUDE_CODE_ENTRYPOINT=dokploy-vulseek`,
	];
	if (isAnthropicHostedBaseUrl(agentProfile.baseUrl)) {
		envPairs.push(`ANTHROPIC_API_KEY=${agentProfile.apiKey}`);
	} else {
		envPairs.push(`ANTHROPIC_AUTH_TOKEN=${agentProfile.apiKey}`);
	}
	return envPairs;
};

const buildShellExports = (pairs: string[]) =>
	pairs
		.map((pair) => {
			const index = pair.indexOf("=");
			const key = index === -1 ? pair : pair.slice(0, index);
			const value = index === -1 ? "" : pair.slice(index + 1);
			return `export ${key}='${escapeSingleQuotes(value)}'`;
		})
		.join(" && ");

const resolveAgentsDirectory = async () => {
	const candidates = [
		path.resolve(process.cwd(), "agents"),
		path.resolve(process.cwd(), "../../agents"),
		"/app/agents",
		"/data/exp/dkzou/dokploy/agents",
	];

	for (const candidate of candidates) {
		try {
			const stat = await fs.stat(candidate);
			if (stat.isDirectory()) {
				return candidate;
			}
		} catch {}
	}
	return null;
};

const writeContainerFile = async (
	containerName: string,
	filePath: string,
	content: string,
) => {
	const encoded = Buffer.from(content, "utf-8").toString("base64");
	await execAsync(
		`docker exec ${containerName} bash -lc "mkdir -p '${path.posix.dirname(
			filePath,
		)}' && echo '${encoded}' | base64 -d > '${filePath}'"`,
	);
};

const getCandidateAnalysisThreadId = (candidate: VulnerabilityCandidate) =>
	candidate.analysisThreadId || "";

const resolveScanExecutionContext = async (scanJob: ScanJob) => {
	const isApplicationJob = Boolean(scanJob.applicationId);
	const target = isApplicationJob
		? await findApplicationById(scanJob.applicationId as string)
		: await findComposeById(scanJob.composeId as string);

	const appName = target.appName;
	const imageTag = toImageTagFromAppName(appName);
	const contextVolumeName = target.environment.project.scanContextVolumeName;
	const projectName = target.environment.project.name;
	const serviceName = target.name || target.appName;

	if (!contextVolumeName) {
		throw new Error("Scan context volume is not configured for this project");
	}

	try {
		await execAsync(`docker image inspect ${imageTag}`);
	} catch {
		throw new Error(
			`Checkout image not found: ${imageTag}. Run Checkout before ${scanJob.scanType} scan.`,
		);
	}

	return {
		isApplicationJob,
		target,
		appName,
		imageTag,
		contextVolumeName,
		projectName,
		serviceName,
		agentProfile:
			isApplicationJob && "agentProfile" in target ? target.agentProfile : null,
	};
};

const copyCodexAssetsToContainerHome = async (
	containerName: string,
	codexHome: string,
	agentsDir: string | null,
	agentProfile?: AgentProfileLike | null,
) => {
	await execAsync(
		`docker exec ${containerName} bash -lc "mkdir -p '${codexHome}/skills'"`,
	);

	if (agentsDir) {
		await execAsync(
			`docker cp "${agentsDir}/." ${containerName}:"${codexHome}/skills/"`,
		);
	}

	if (agentProfile) {
		if (agentProfile.provider === "codex") {
			await writeContainerFile(
				containerName,
				`${codexHome}/config.toml`,
				buildCodexConfigToml(agentProfile),
			);
			await writeContainerFile(
				containerName,
				`${codexHome}/auth.json`,
				buildCodexAuthJson(agentProfile),
			);
		}
		return;
	}

	if (!agentsDir) {
		return;
	}

	const codexConfigPath = path.join(agentsDir, "codex-config.toml");
	try {
		await fs.stat(codexConfigPath);
		await execAsync(
			`docker cp "${codexConfigPath}" ${containerName}:"${codexHome}/config.toml"`,
		);
	} catch {}

	const codexAuthPath = path.join(agentsDir, "codex-auth.json");
	try {
		await fs.stat(codexAuthPath);
		await execAsync(
			`docker cp "${codexAuthPath}" ${containerName}:"${codexHome}/auth.json"`,
		);
	} catch {}
};

const resolveScanRuntimeBaseDir = () =>
	path.resolve(process.cwd(), ".scan-runtime");

const resolveScanRuntimeDir = (scanJobId: string) =>
	path.join(resolveScanRuntimeBaseDir(), scanJobId);

const resolveScanJobScanningRuntimeDir = (scanJobId: string) =>
	path.join(resolveScanRuntimeDir(scanJobId), "scanning");

const resolveCandidateRuntimeDir = (scanJobId: string, candidateId: string) =>
	path.join(resolveScanRuntimeDir(scanJobId), "candidates", candidateId);

export const getScanJobAppServerJsonlPath = (scanJobId: string) =>
	path.join(resolveScanJobScanningRuntimeDir(scanJobId), "app-server-messages.jsonl");

export const getScanJobAppServerTextPath = (scanJobId: string) =>
	path.join(resolveScanJobScanningRuntimeDir(scanJobId), "app-server-text.log");

export const getScanJobAppServerStderrPath = (scanJobId: string) =>
	path.join(resolveScanJobScanningRuntimeDir(scanJobId), "app-server-stderr.log");

export const getScanJobBridgeEventsPath = (scanJobId: string) =>
	path.join(resolveScanJobScanningRuntimeDir(scanJobId), "bridge-events.jsonl");

export const getCandidateAnalysisAppServerJsonlPath = (
	scanJobId: string,
	candidateId: string,
) =>
	path.join(resolveCandidateRuntimeDir(scanJobId, candidateId), "app-server-messages.jsonl");

export const getCandidateAnalysisAppServerTextPath = (
	scanJobId: string,
	candidateId: string,
) =>
	path.join(resolveCandidateRuntimeDir(scanJobId, candidateId), "app-server-text.log");

export const getCandidateAnalysisAppServerStderrPath = (
	scanJobId: string,
	candidateId: string,
) =>
	path.join(resolveCandidateRuntimeDir(scanJobId, candidateId), "app-server-stderr.log");

const resetScanRuntimeFiles = async (scanJobId: string) => {
	await fs.mkdir(resolveScanJobScanningRuntimeDir(scanJobId), { recursive: true });
	await Promise.all([
		fs.writeFile(getScanJobAppServerJsonlPath(scanJobId), "", "utf-8"),
		fs.writeFile(getScanJobAppServerTextPath(scanJobId), "", "utf-8"),
		fs.writeFile(getScanJobAppServerStderrPath(scanJobId), "", "utf-8"),
		fs.writeFile(getScanJobBridgeEventsPath(scanJobId), "", "utf-8"),
	]);
};

export const resetCandidateAnalysisRuntimeFiles = async (
	scanJobId: string,
	candidateId: string,
) => {
	const runtimeDir = resolveCandidateRuntimeDir(scanJobId, candidateId);
	await fs.mkdir(runtimeDir, { recursive: true });
	await Promise.all([
		fs.writeFile(
			getCandidateAnalysisAppServerJsonlPath(scanJobId, candidateId),
			"",
			"utf-8",
		),
		fs.writeFile(
			getCandidateAnalysisAppServerTextPath(scanJobId, candidateId),
			"",
			"utf-8",
		),
		fs.writeFile(
			getCandidateAnalysisAppServerStderrPath(scanJobId, candidateId),
			"",
			"utf-8",
		),
	]);
};

const appendScanRuntimeFile = async (filePath: string, chunk: string) => {
	if (!chunk) return;
	await fs.appendFile(filePath, chunk, "utf-8");
};

export const readScanJobAppServerMessages = async (
	scanJobId: string,
): Promise<JsonRpcMessage[]> => {
	try {
		const file = await fs.readFile(getScanJobAppServerJsonlPath(scanJobId), "utf-8");
		return file
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => JSON.parse(line) as JsonRpcMessage);
	} catch {
		return [];
	}
};

const readCandidateAnalysisAppServerMessages = async (
	scanJobId: string,
	candidateId: string,
): Promise<JsonRpcMessage[]> => {
	try {
		const file = await fs.readFile(
			getCandidateAnalysisAppServerJsonlPath(scanJobId, candidateId),
			"utf-8",
		);
		return file
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => JSON.parse(line) as JsonRpcMessage);
	} catch {
		return [];
	}
};

export const readScanJobAppServerText = async (scanJobId: string) => {
	try {
		return await fs.readFile(getScanJobAppServerTextPath(scanJobId), "utf-8");
	} catch {
		return "";
	}
};

export const readCandidateAnalysisAppServerText = async (
	scanJobId: string,
	candidateId: string,
) => {
	try {
		return await fs.readFile(
			getCandidateAnalysisAppServerTextPath(scanJobId, candidateId),
			"utf-8",
		);
	} catch {
		return "";
	}
};

const readScanJobBridgeEvents = async (
	scanJobId: string,
): Promise<ScanBridgeEventRecord[]> => {
	try {
		const file = await fs.readFile(getScanJobBridgeEventsPath(scanJobId), "utf-8");
		return file
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => JSON.parse(line) as ScanBridgeEventRecord);
	} catch {
		return [];
	}
};

const asRecord = (value: unknown) =>
	value && typeof value === "object"
		? (value as Record<string, unknown>)
		: undefined;

const asString = (value: unknown) =>
	typeof value === "string" && value ? value : undefined;

const asArray = (value: unknown) => (Array.isArray(value) ? value : []);

const formatActionText = (value: string | undefined, fallback = "-") => {
	if (!value) {
		return fallback;
	}

	const trimmed = value.trim();
	return trimmed || fallback;
};

const deriveActionFromItem = (
	item: Record<string, unknown>,
	itemTextById: Map<string, string>,
): ScanRuntimeLiveAction | null => {
	const itemId = asString(item.id);
	const itemType = asString(item.type);
	if (!itemId || !itemType) {
		return null;
	}

	if (itemType === "commandExecution") {
		const command = asString(item.command);
		const cwd = asString(item.cwd);
		return {
			itemId,
			itemType,
			actionType: "command executing",
			actionText: formatActionText(
				command ? `${command}${cwd ? ` [cwd: ${cwd}]` : ""}` : cwd,
			),
		};
	}

	if (itemType === "reasoning") {
		const content = itemTextById.get(itemId);
		return {
			itemId,
			itemType,
			actionType: "reasoning",
			actionText: formatActionText(content, "Reasoning"),
		};
	}

	if (itemType === "fileChange") {
		const content = itemTextById.get(itemId);
		return {
			itemId,
			itemType,
			actionType: "other",
			actionText: formatActionText(content, "Applying file changes"),
		};
	}

	if (itemType === "mcpToolCall") {
		const server = asString(item.server) || "mcp";
		const tool = asString(item.tool) || "tool";
		return {
			itemId,
			itemType,
			actionType: "other",
			actionText: `${server}:${tool}`,
		};
	}

	if (itemType === "dynamicToolCall") {
		const tool = asString(item.tool) || "tool";
		return {
			itemId,
			itemType,
			actionType: "other",
			actionText: tool,
		};
	}

	if (itemType === "collabAgentToolCall") {
		const tool = asString(item.tool) || "collab";
		const prompt = asString(item.prompt);
		return {
			itemId,
			itemType,
			actionType: "other",
			actionText: formatActionText(
				prompt ? `${tool}: ${prompt}` : tool,
				tool,
			),
		};
	}

	return null;
};

const deriveScanRuntimeLiveAction = async (
	scanJobId: string,
): Promise<ScanRuntimeLiveAction | null> => {
	const messages = await readScanJobAppServerMessages(scanJobId);
	if (messages.length === 0) {
		return null;
	}

	const activeItems = new Map<string, Record<string, unknown>>();
	const itemTextById = new Map<string, string>();

	for (const message of messages) {
		const params = asRecord(message.params) || {};

		if (message.method === "item/started" || message.method === "item/completed") {
			const item = asRecord(params.item);
			const itemId = asString(item?.id);
			if (!item || !itemId) {
				continue;
			}

			if (message.method === "item/started") {
				activeItems.set(itemId, item);
			} else {
				activeItems.delete(itemId);
			}
			continue;
		}

		if (message.method === "item/reasoning/textDelta") {
			const itemId = asString(params.itemId);
			const delta = asString(params.delta);
			if (itemId && delta) {
				itemTextById.set(itemId, `${itemTextById.get(itemId) || ""}${delta}`);
			}
			continue;
		}

		if (message.method === "item/commandExecution/outputDelta") {
			const itemId = asString(params.itemId);
			const delta = asString(params.delta);
			if (itemId && delta) {
				itemTextById.set(itemId, `${itemTextById.get(itemId) || ""}${delta}`);
			}
			continue;
		}

		if (message.method === "item/fileChange/outputDelta") {
			const itemId = asString(params.itemId);
			const delta = asString(params.delta);
			if (itemId && delta) {
				itemTextById.set(itemId, `${itemTextById.get(itemId) || ""}${delta}`);
			}
			continue;
		}

		if (message.method === "item/commandExecution/terminalInteraction") {
			const itemId = asString(params.itemId);
			const stdin = asString(params.stdin);
			if (itemId && stdin) {
				itemTextById.set(
					itemId,
					formatActionText(`terminal input: ${stdin}`, "terminal input"),
				);
			}
		}
	}

	const activeActions = Array.from(activeItems.values())
		.map((item) => deriveActionFromItem(item, itemTextById))
		.filter(Boolean) as ScanRuntimeLiveAction[];

	return activeActions.at(-1) || null;
};

const deriveCandidateAnalysisRuntimeLiveAction = async (
	scanJobId: string,
	candidateId: string,
): Promise<ScanRuntimeLiveAction | null> => {
	const messages = await readCandidateAnalysisAppServerMessages(scanJobId, candidateId);
	if (messages.length === 0) {
		return null;
	}

	const activeItems = new Map<string, Record<string, unknown>>();
	const itemTextById = new Map<string, string>();

	for (const message of messages) {
		const params = asRecord(message.params) || {};

		if (message.method === "item/started" || message.method === "item/completed") {
			const item = asRecord(params.item);
			const itemId = asString(item?.id);
			if (!item || !itemId) {
				continue;
			}

			if (message.method === "item/started") {
				activeItems.set(itemId, item);
			} else {
				activeItems.delete(itemId);
			}
			continue;
		}

		if (
			message.method === "item/reasoning/textDelta" ||
			message.method === "item/commandExecution/outputDelta" ||
			message.method === "item/fileChange/outputDelta"
		) {
			const itemId = asString(params.itemId);
			const delta = asString(params.delta);
			if (itemId && delta) {
				itemTextById.set(itemId, `${itemTextById.get(itemId) || ""}${delta}`);
			}
			continue;
		}

		if (message.method === "item/commandExecution/terminalInteraction") {
			const itemId = asString(params.itemId);
			const stdin = asString(params.stdin);
			if (itemId && stdin) {
				itemTextById.set(
					itemId,
					formatActionText(`terminal input: ${stdin}`, "terminal input"),
				);
			}
		}
	}

	const activeActions = Array.from(activeItems.values())
		.map((item) => deriveActionFromItem(item, itemTextById))
		.filter(Boolean) as ScanRuntimeLiveAction[];

	return activeActions.at(-1) || null;
};

const deriveLiveState = (event: ScanBridgeEventRecord) => {
	if (event.type === "next_stage") {
		const nextStage = asRecord(event.payload.nextStage) || {};
		const stage = asString(nextStage.stage);
		return {
			stage: stage === "fuzzing" ? "fuzzing" : "analyzing",
			actionType:
				asString(asRecord(nextStage.metadata)?.currentActionType) ||
				"orchestrating",
			actionText:
				asString(asRecord(nextStage.metadata)?.currentAction) ||
				asString(nextStage.reason) ||
				asString(nextStage.inputSummary) ||
				"-",
		};
	}

	return {
		stage: "analyzing",
		actionType: "other",
		actionText: "-",
	};
};

const resolveCandidateStageFromEvent = (
	event: VulseekBridgeEvent,
): VulnerabilityCandidateStage | null => {
	if (event.type === "next_stage") {
		const nextStage = asRecord(event.payload.nextStage) || {};
		const stage = asString(nextStage.stage);
		if (stage === "fuzzing") {
			return stage;
		}
		return "analyzing";
	}

	return null;
};

const resolveCandidateThreadIdFromEvent = (event: VulseekBridgeEvent) => {
	if (event.type === "next_stage") {
		const nextStage = asRecord(event.payload.nextStage) || {};
		return (
			asString(nextStage.threadId) ||
			asString(asRecord(nextStage.metadata)?.threadId) ||
			undefined
		);
	}

	return undefined;
};

export const findScanJobStatusView = async (scanJobId: string) => {
	const [candidates, analysisResultsList, bridgeEvents] = await Promise.all([
		findVulnerabilityCandidatesByScanJobId(scanJobId),
		findAnalysisResultsByScanJobId(scanJobId),
		readScanJobBridgeEvents(scanJobId),
	]);

	const issueCandidateIds = new Set(
		analysisResultsList
			.filter((analysisResult) => analysisResult.result !== "false_positive")
			.map((analysisResult) => analysisResult.vulnerabilityCandidateId),
	);
	const latestEventByCandidate = new Map<string, ScanBridgeEventRecord>();

	for (const event of bridgeEvents) {
		const candidateId = asString(event.payload.candidateId);
		if (candidateId) {
			latestEventByCandidate.set(candidateId, event);
		}
	}

	const completedCount = candidates.filter(
		(candidate) => candidate.status === "completed",
	).length;
	const issueCount = candidates.filter((candidate) =>
		issueCandidateIds.has(candidate.vulnerabilityCandidateId),
	).length;
	const excludedCount = candidates.filter(
		(candidate) =>
			candidate.status === "completed" &&
			!issueCandidateIds.has(candidate.vulnerabilityCandidateId),
	).length;

	const inProgressCandidates = await Promise.all(
		candidates
			.filter((candidate) => candidate.status === "running")
			.map(async (candidate) => {
			const latestEvent = latestEventByCandidate.get(
				candidate.vulnerabilityCandidateId,
			);
			const candidateStage = (candidate.currentStage ||
				"analyzing") as VulnerabilityCandidateStage;
			const candidateRuntimeLiveAction = await deriveCandidateAnalysisRuntimeLiveAction(
				scanJobId,
				candidate.vulnerabilityCandidateId,
			);
			const liveState = latestEvent
				? deriveLiveState(latestEvent)
				: {
						stage: "analyzing",
						actionType: "other",
						actionText: "-",
					};
			const resolvedStage = liveState.stage || "analyzing";
			const resolvedActionType =
				candidateRuntimeLiveAction?.actionType ||
				liveState.actionType;
			const resolvedActionText =
				candidateRuntimeLiveAction?.actionText &&
					candidateRuntimeLiveAction.actionText !== "-"
					? candidateRuntimeLiveAction.actionText
					: liveState.actionText;

			return {
				vulnerabilityCandidateId: candidate.vulnerabilityCandidateId,
				title: candidate.title,
				filePath: candidate.filePath,
				line: candidate.line,
				stage: candidate.currentStage || resolvedStage,
				actionType: resolvedActionType,
				actionText: resolvedActionText,
				updatedAt: candidate.updatedAt,
			};
		}),
	);

	const queuedCandidates = candidates
		.filter((candidate) => candidate.status === "queued")
		.slice(0, 10)
		.map((candidate) => ({
			vulnerabilityCandidateId: candidate.vulnerabilityCandidateId,
			title: candidate.title,
			filePath: candidate.filePath,
			line: candidate.line,
			confidence: candidate.confidence,
			createdAt: candidate.createdAt,
		}));

	return {
		summary: {
			totalCandidates: candidates.length,
			completedCandidates: completedCount,
			excludedCandidates: excludedCount,
			issueCandidates: issueCount,
		},
		inProgressCandidates,
		queuedCandidates,
		recentBridgeEvents: bridgeEvents
			.slice(-20)
			.reverse()
			.map((event) => ({
				recordedAt: event.recordedAt,
				type: event.type,
				candidateId: asString(event.payload.candidateId) || null,
				summary:
					asString(event.payload.summary) ||
					asString(event.payload.result) ||
					asString(event.payload.reportPath) ||
					asString(event.payload.nextActionHint) ||
					asString(asRecord(event.payload.nextStage)?.reason) ||
					"-",
			})),
	};
};

const extractTextValue = (value: unknown): string | null => {
	if (typeof value === "string") {
		return value;
	}

	if (!value || typeof value !== "object") {
		return null;
	}

	const record = value as Record<string, unknown>;
	const preferredKeys = [
		"delta",
		"text",
		"textDelta",
		"outputDelta",
		"stdout",
		"stderr",
		"content",
	];

	for (const key of preferredKeys) {
		const nested = extractTextValue(record[key]);
		if (nested) {
			return nested;
		}
	}

	for (const nested of Object.values(record)) {
		const extracted = extractTextValue(nested);
		if (extracted) {
			return extracted;
		}
	}

	return null;
};

const resolveCompletedAgentMessageText = (
	message: JsonRpcMessage,
	agentMessageBuffers: Map<string, string>,
) => {
	if (message.method === "item/agentMessage/delta") {
		const params = asRecord(message.params);
		const itemId = asString(params?.itemId);
		const delta = asString(params?.delta) || "";
		if (itemId && delta) {
			agentMessageBuffers.set(
				itemId,
				`${agentMessageBuffers.get(itemId) || ""}${delta}`,
			);
		}
		return "";
	}

	if (message.method !== "item/completed") {
		return "";
	}

	const item = asRecord(
		(message.params as Record<string, unknown> | undefined)?.item,
	);
	if (asString(item?.type) !== "agentMessage") {
		return "";
	}

	const itemId = asString(item?.id);
	const completedText = asString(item?.text) || "";
	const bufferedText = itemId ? agentMessageBuffers.get(itemId) || "" : "";

	if (itemId) {
		agentMessageBuffers.delete(itemId);
	}

	return completedText || bufferedText;
};

const renderJsonRpcMessage = (message: JsonRpcMessage) => {
	if (message.error?.message) {
		return `\n[jsonrpc error] ${message.error.message}\n`;
	}

	if (!message.method) {
		return "";
	}

	const text = extractTextValue(message.params);
	switch (message.method) {
		case "turn/started":
			return "\n[turn started]\n";
		case "turn/completed": {
			const status =
				extractTextValue((message.params as Record<string, unknown> | undefined)?.turn) ||
				extractTextValue(message.params) ||
				"completed";
			return `\n[turn ${status}]\n`;
		}
		case "item/agentMessage/delta":
		case "item/reasoning/textDelta":
		case "item/reasoning/summaryTextDelta":
		case "item/commandExecution/outputDelta":
			return text || "";
		case "item/plan/delta":
			return text ? `\n[plan] ${text}` : "";
		case "error": {
			const errorRecord = (message.params as Record<string, unknown> | undefined)
				?.error;
			const errorMessage = extractTurnErrorMessage(errorRecord) || text;
			return errorMessage ? `\n[error] ${errorMessage}\n` : "";
		}
		default:
			return "";
	}
};

const extractClaudeSessionId = (message: Record<string, unknown>) =>
	asString(message.session_id) ||
	asString(message.sessionId) ||
	asString(asRecord(message.result)?.session_id) ||
	asString(asRecord(message.result)?.sessionId) ||
	asString(asRecord(message.message)?.session_id) ||
	asString(asRecord(message.message)?.sessionId) ||
	asString(asRecord(message.data)?.session_id) ||
	asString(asRecord(message.data)?.sessionId) ||
	"";

const renderClaudeStreamJsonMessage = (message: Record<string, unknown>) => {
	const type = asString(message.type) || "";
	const subtype = asString(message.subtype) || "";
	const text =
		extractTextValue(message.delta) ||
		extractTextValue(message.message) ||
		extractTextValue(message.content) ||
		extractTextValue(message.result) ||
		extractTextValue(message);

	if (type === "system") {
		return text ? `\n[system] ${text}\n` : "";
	}

	if (type === "assistant" || type === "message") {
		return text || "";
	}

	if (type === "result") {
		const status = asString(message.stop_reason) || subtype || "completed";
		return `\n[turn ${status}]\n`;
	}

	if (type === "error") {
		const errorMessage =
			asString(asRecord(message.error)?.message) || text || "Claude turn failed";
		return `\n[error] ${errorMessage}\n`;
	}

	if (text) {
		return text;
	}

	return "";
};

type VulseekBridgeEvent = {
	type: "candidate" | "candidate_batch" | "next_stage" | "analysis_result";
	payload: Record<string, unknown>;
};

type BridgeParseError = {
	message: string;
	payloadSnippet: string;
};

type BridgePersistResult = {
	type: VulseekBridgeEvent["type"];
	receivedCandidates: number;
	createdCandidates: number;
	droppedCandidates: number;
};

const normalizeAnalysisResult = (value: string | undefined) => {
	const normalized = (value || "")
		.trim()
		.toLowerCase()
		.replace(/\s+/g, "_")
		.replace(/-/g, "_");

	switch (normalized) {
		case "real_vulnerability":
			return "real_vulnerability";
		case "likely_vulnerability":
			return "likely_vulnerability";
		case "plausible_but_unproven":
		case "weak_hypothesis":
			return "plausible_but_unproven";
		case "false_positive":
			return "false_positive";
		default:
			return normalized || "plausible_but_unproven";
	}
};

const extractVulseekBridgeEvents = (buffer: string) => {
	const events: VulseekBridgeEvent[] = [];
	const parseErrors: BridgeParseError[] = [];
	const pattern = /<VULSEEK_EVENT>\s*([\s\S]*?)\s*<\/VULSEEK_EVENT>/;
	let remaining = buffer;

	while (true) {
		const match = remaining.match(pattern);
		if (!match || match.index === undefined) {
			break;
		}

		const [fullMatch, jsonPayload] = match;
		const startIndex = match.index;
		const endIndex = startIndex + fullMatch.length;

		try {
			if (!jsonPayload) {
				remaining = remaining.slice(endIndex);
				continue;
			}

			const parsed = JSON.parse(jsonPayload) as VulseekBridgeEvent;
			if (
				parsed &&
				typeof parsed === "object" &&
				typeof parsed.type === "string" &&
				parsed.payload &&
				typeof parsed.payload === "object"
			) {
				events.push(parsed);
			} else {
				parseErrors.push({
					message: "Parsed VULSEEK_EVENT is missing type or payload",
					payloadSnippet: jsonPayload.slice(0, 400),
				});
			}
		} catch (error) {
			parseErrors.push({
				message:
					error instanceof Error ? error.message : "Invalid VULSEEK_EVENT JSON",
				payloadSnippet: (jsonPayload || "").slice(0, 400),
			});
		}

		remaining = remaining.slice(endIndex);
	}

	const danglingStart = remaining.lastIndexOf("<VULSEEK_EVENT>");
	if (danglingStart !== -1) {
		remaining = remaining.slice(danglingStart);
	} else {
		remaining = "";
	}

	return { events, parseErrors, remaining };
};

const normalizeCandidatePayload = (payload: Record<string, unknown>) => ({
	title: typeof payload.title === "string" ? payload.title : "",
	description:
		typeof payload.description === "string" ? payload.description : undefined,
	filePath: typeof payload.filePath === "string" ? payload.filePath : undefined,
	line: typeof payload.line === "number" ? payload.line : undefined,
	confidence:
		typeof payload.confidence === "number" ? payload.confidence : undefined,
});

const persistVulseekBridgeEvent = async (
	scanJobId: string,
	event: VulseekBridgeEvent,
	options?: {
		candidateId?: string;
		runtimeSeconds?: number;
		threadId?: string;
	},
): Promise<BridgePersistResult> => {
	const bridgeEventsPath = getScanJobBridgeEventsPath(scanJobId);
	const eventRecord = {
		recordedAt: new Date().toISOString(),
		type: event.type,
		payload: event.payload,
	};

	await appendScanRuntimeFile(
		bridgeEventsPath,
		`${JSON.stringify(eventRecord)}\n`,
	);

	if (event.type === "candidate") {
		const candidate = normalizeCandidatePayload(
			event.payload.candidate as Record<string, unknown>,
		);
		if (candidate.title) {
			await createVulnerabilityCandidate({
				scanJobId,
				...candidate,
			});
			await updateScanJobStatus(scanJobId, "analyzing").catch(() => {});
			return {
				type: event.type,
				receivedCandidates: 1,
				createdCandidates: 1,
				droppedCandidates: 0,
			};
		}
		return {
			type: event.type,
			receivedCandidates: 1,
			createdCandidates: 0,
			droppedCandidates: 1,
		};
	}

	if (event.type === "candidate_batch") {
		const candidates = Array.isArray(event.payload.candidates)
			? event.payload.candidates
			: [];
		let createdCandidates = 0;
		for (const candidateValue of candidates) {
			if (!candidateValue || typeof candidateValue !== "object") continue;
			const candidate = normalizeCandidatePayload(
				candidateValue as Record<string, unknown>,
			);
			if (!candidate.title) continue;
			await createVulnerabilityCandidate({
				scanJobId,
				...candidate,
			});
			createdCandidates += 1;
		}
		if (createdCandidates > 0) {
			await updateScanJobStatus(scanJobId, "analyzing").catch(() => {});
		}
		return {
			type: event.type,
			receivedCandidates: candidates.length,
			createdCandidates,
			droppedCandidates: Math.max(0, candidates.length - createdCandidates),
		};
	}

	if (event.type === "analysis_result") {
		const candidateId =
			asString(event.payload.candidateId) || options?.candidateId;
		if (!candidateId) {
			return {
				type: event.type,
				receivedCandidates: 0,
				createdCandidates: 0,
				droppedCandidates: 0,
			};
		}

		const candidate = await findVulnerabilityCandidateById(candidateId);
		const result = normalizeAnalysisResult(asString(event.payload.result));
		const summary = asString(event.payload.summary);
		const reportPath = asString(event.payload.reportPath);
		const runtimeSeconds =
			typeof event.payload.runtimeSeconds === "number"
				? event.payload.runtimeSeconds
				: options?.runtimeSeconds;
		const threadId = asString(event.payload.threadId) || options?.threadId;

		if (threadId) {
			await updateVulnerabilityCandidateAnalysisThreadId(candidateId, threadId);
		}

		await updateVulnerabilityCandidateCurrentStage(candidateId, "analyzing");
		await deleteAnalysisResultsByCandidateId(candidateId);
		await createAnalysisResult({
			scanJobId,
			vulnerabilityCandidateId: candidateId,
			result,
			reportPath,
			runtimeSeconds,
			threadId,
			summary:
				summary ||
				(result === "real_vulnerability"
					? `Real vulnerability: ${candidate.title}`
					: result === "likely_vulnerability"
						? `Likely vulnerability: ${candidate.title}`
						: result === "false_positive"
							? `False positive: ${candidate.title}`
							: `Plausible but unproven: ${candidate.title}`),
		});

		await updateVulnerabilityCandidateStatus(candidateId, "completed");
		return {
			type: event.type,
			receivedCandidates: 0,
			createdCandidates: 0,
			droppedCandidates: 0,
		};
	}

	const candidateId = asString(event.payload.candidateId);
	const currentStage = resolveCandidateStageFromEvent(event);
	const threadId = resolveCandidateThreadIdFromEvent(event);
	if (candidateId && currentStage) {
		await updateVulnerabilityCandidateCurrentStage(candidateId, currentStage);
		if (threadId) {
			await updateVulnerabilityCandidateAnalysisThreadId(candidateId, threadId);
		}
	}
	return {
		type: event.type,
		receivedCandidates: 0,
		createdCandidates: 0,
		droppedCandidates: 0,
	};
};

const copyScanRuntimeArtifactsToContainer = async (
	containerName: string,
	scanJobId: string,
	scanRootDir: string,
) => {
	const copyTargets = [
		{
			source: getScanJobAppServerJsonlPath(scanJobId),
			target: `${scanRootDir}/03_app_server_messages.jsonl`,
		},
		{
			source: getScanJobAppServerTextPath(scanJobId),
			target: `${scanRootDir}/03_app_server_text.log`,
		},
		{
			source: getScanJobAppServerStderrPath(scanJobId),
			target: `${scanRootDir}/03_app_server_stderr.log`,
		},
		{
			source: getScanJobBridgeEventsPath(scanJobId),
			target: `${scanRootDir}/03_bridge_events.jsonl`,
		},
	];

	for (const copyTarget of copyTargets) {
		try {
			await fs.stat(copyTarget.source);
			await execAsync(
				`docker cp "${copyTarget.source}" ${containerName}:"${copyTarget.target}"`,
			);
		} catch {}
	}
};

const DEFAULT_CODEX_TEST_PROMPT = "总结这个目录下的文件路径层级结构";

const captureContainerCodexState = async (
	containerName: string,
	scanRootDir: string,
	fileName: string,
) => {
	const shellScript = [
		`set -eu`,
		`mkdir -p '${scanRootDir}'`,
		`output='${scanRootDir}/${fileName}'`,
		`{`,
		`echo '# Codex Runtime State'`,
		`echo`,
		`echo '## config.toml'`,
		"echo '```toml'",
		`if [ -f /root/.codex/config.toml ]; then cat /root/.codex/config.toml; else echo '(missing)'; fi`,
		"echo '```'",
		`echo`,
		`echo '## auth.json'`,
		"echo '```json'",
		`if [ -f /root/.codex/auth.json ]; then cat /root/.codex/auth.json; else echo '(missing)'; fi`,
		"echo '```'",
		`echo`,
		`echo '## environment'`,
		"echo '```text'",
		`env | grep -iE 'OPENAI|proxy|BASE_URL|CODEX' | sort || true`,
		"echo '```'",
		`} > "$output"`,
	].join("\n");
	const encoded = Buffer.from(shellScript, "utf-8").toString("base64");

	await execAsync(
		`docker exec ${containerName} bash -lc "echo '${encoded}' | base64 -d | bash"`,
	);
};

type ScanBridgeDebugStats = {
	eventBlocks: number;
	candidateEvents: number;
	candidateRecordsReceived: number;
	candidateRecordsCreated: number;
	candidateRecordsDropped: number;
	parseErrors: number;
};

const createEmptyScanBridgeDebugStats = (): ScanBridgeDebugStats => ({
	eventBlocks: 0,
	candidateEvents: 0,
	candidateRecordsReceived: 0,
	candidateRecordsCreated: 0,
	candidateRecordsDropped: 0,
	parseErrors: 0,
});

type PreparedRepositoryState = {
	effectiveTargetMode: string;
	targetRef: string | null;
	targetTag: string | null;
	requestedCommitSha: string | null;
	requestedBaseSha: string | null;
	commitWindow: number;
	resolvedTargetSha: string;
	resolvedBaseSha: string | null;
	currentBranch: string | null;
	currentExactTag: string | null;
	markdown: string;
};

const prepareRepositoryForScanInContainer = async (input: {
	containerName: string;
	scanJob: ScanJob;
	scanRootDir: string;
}): Promise<PreparedRepositoryState> => {
	const forceLatestRef = input.scanJob.scanType === "delta";
	const targetRef = input.scanJob.targetRef?.trim() || "";
	const targetTag = input.scanJob.targetTag?.trim() || "";
	const requestedCommit = input.scanJob.commitSha?.trim() || "";
	const requestedBase = input.scanJob.baseSha?.trim() || "";
	const commitWindow = input.scanJob.commitWindow || DEFAULT_DELTA_COMMIT_WINDOW;

	const shellScript = [
		"set -euo pipefail",
		"cd /workspace/repo",
		`SCAN_ROOT='${escapeSingleQuotes(input.scanRootDir)}'`,
		"mkdir -p \"$SCAN_ROOT\"",
		"CURRENT_BRANCH=\"$(git symbolic-ref --quiet --short HEAD || true)\"",
		"git fetch --all --tags --prune",
		"if [ -n \"$CURRENT_BRANCH\" ]; then",
		"  git pull --ff-only origin \"$CURRENT_BRANCH\" || true",
		"fi",
		`TARGET_REF='${escapeSingleQuotes(targetRef)}'`,
		`TARGET_TAG='${escapeSingleQuotes(targetTag)}'`,
		`REQUESTED_COMMIT='${escapeSingleQuotes(requestedCommit)}'`,
		`REQUESTED_BASE='${escapeSingleQuotes(requestedBase)}'`,
		`COMMIT_WINDOW='${commitWindow}'`,
		`FORCE_LATEST_REF='${forceLatestRef ? "true" : "false"}'`,
		"RESOLVED_TARGET=\"\"",
		"EFFECTIVE_TARGET_MODE=\"explicit\"",
		"if [ \"$FORCE_LATEST_REF\" = \"true\" ]; then",
		"  EFFECTIVE_TARGET_MODE=\"latest-ref\"",
		"  if [ -n \"$CURRENT_BRANCH\" ]; then",
		"    RESOLVED_TARGET=\"$(git rev-parse HEAD)\"",
		"    TARGET_REF=\"$CURRENT_BRANCH\"",
		"    TARGET_TAG=\"\"",
		"    REQUESTED_COMMIT=\"\"",
		"  else",
		"    RESOLVED_TARGET=\"$(git rev-parse HEAD)\"",
		"    TARGET_REF=\"HEAD\"",
		"    TARGET_TAG=\"\"",
		"    REQUESTED_COMMIT=\"\"",
		"  fi",
		"elif [ -n \"$TARGET_TAG\" ]; then",
		"  git rev-parse --verify \"refs/tags/$TARGET_TAG^{commit}\" >/dev/null",
		"  git checkout -f \"refs/tags/$TARGET_TAG\"",
		"  RESOLVED_TARGET=\"$(git rev-parse HEAD)\"",
		"elif [ -n \"$TARGET_REF\" ]; then",
		"  if git rev-parse --verify \"$TARGET_REF^{commit}\" >/dev/null 2>&1; then",
		"    git checkout -f \"$TARGET_REF\"",
		"  elif git rev-parse --verify \"origin/$TARGET_REF^{commit}\" >/dev/null 2>&1; then",
		"    git checkout -f \"origin/$TARGET_REF\"",
		"  else",
		"    echo \"Unable to resolve targetRef: $TARGET_REF\" >&2",
		"    exit 1",
		"  fi",
		"  RESOLVED_TARGET=\"$(git rev-parse HEAD)\"",
		"elif [ -n \"$REQUESTED_COMMIT\" ]; then",
		"  if git rev-parse --verify \"$REQUESTED_COMMIT^{commit}\" >/dev/null 2>&1; then",
		"    git checkout -f \"$REQUESTED_COMMIT\"",
		"    RESOLVED_TARGET=\"$(git rev-parse HEAD)\"",
		"  else",
		"    echo \"Unable to resolve commitSha: $REQUESTED_COMMIT\" >&2",
		"    exit 1",
		"  fi",
		"else",
		"  RESOLVED_TARGET=\"$(git rev-parse HEAD)\"",
		"fi",
		"TARGET_SUBJECT=\"$(git log -1 --format=%s \"$RESOLVED_TARGET\")\"",
		"TARGET_SHORT=\"$(git rev-parse --short \"$RESOLVED_TARGET\")\"",
		"CURRENT_EXACT_TAG=\"$(git describe --tags --exact-match HEAD 2>/dev/null || true)\"",
		"if [ -n \"$REQUESTED_BASE\" ] && git rev-parse --verify \"$REQUESTED_BASE^{commit}\" >/dev/null 2>&1; then",
		"  RESOLVED_BASE=\"$REQUESTED_BASE\"",
		"else",
		"  RESOLVED_BASE=\"$(git rev-parse \"$RESOLVED_TARGET~$COMMIT_WINDOW\" 2>/dev/null || true)\"",
		"fi",
		"{",
		"  echo '# Repository State'",
		"  echo",
		"  echo \"- effective_target_mode: ${EFFECTIVE_TARGET_MODE}\"",
		"  echo \"- target_tag: ${TARGET_TAG:-<none>}\"",
		"  echo \"- target_ref: ${TARGET_REF:-<none>}\"",
		"  echo \"- requested_commit_sha: ${REQUESTED_COMMIT:-<none>}\"",
		"  echo \"- requested_base_sha: ${REQUESTED_BASE:-<none>}\"",
		"  echo \"- commit_window: ${COMMIT_WINDOW}\"",
		"  echo \"- resolved_target_sha: ${RESOLVED_TARGET}\"",
		"  echo \"- resolved_target_short: ${TARGET_SHORT}\"",
		"  echo \"- resolved_base_sha: ${RESOLVED_BASE:-<none>}\"",
		"  echo \"- target_subject: ${TARGET_SUBJECT}\"",
		"  echo",
		"  echo '## Recent Commits'",
		"  git log --oneline -n \"$((COMMIT_WINDOW + 1))\" \"$RESOLVED_TARGET\" || true",
		"} > \"$SCAN_ROOT/00_repository_state.md\"",
		"jq -n \\",
		"  --arg effectiveTargetMode \"$EFFECTIVE_TARGET_MODE\" \\",
		"  --arg targetRef \"$TARGET_REF\" \\",
		"  --arg targetTag \"$TARGET_TAG\" \\",
		"  --arg requestedCommitSha \"$REQUESTED_COMMIT\" \\",
		"  --arg requestedBaseSha \"$REQUESTED_BASE\" \\",
		"  --arg resolvedTargetSha \"$RESOLVED_TARGET\" \\",
		"  --arg resolvedBaseSha \"$RESOLVED_BASE\" \\",
		"  --arg currentBranch \"$CURRENT_BRANCH\" \\",
		"  --arg currentExactTag \"$CURRENT_EXACT_TAG\" \\",
		"  --argjson commitWindow \"$COMMIT_WINDOW\" \\",
		"  '{",
		"    effectiveTargetMode: $effectiveTargetMode,",
		"    targetRef: (if $targetRef == \"\" then null else $targetRef end),",
		"    targetTag: (if $targetTag == \"\" then null else $targetTag end),",
		"    requestedCommitSha: (if $requestedCommitSha == \"\" then null else $requestedCommitSha end),",
		"    requestedBaseSha: (if $requestedBaseSha == \"\" then null else $requestedBaseSha end),",
		"    commitWindow: $commitWindow,",
		"    resolvedTargetSha: $resolvedTargetSha,",
		"    resolvedBaseSha: (if $resolvedBaseSha == \"\" then null else $resolvedBaseSha end),",
		"    currentBranch: (if $currentBranch == \"\" then null else $currentBranch end),",
		"    currentExactTag: (if $currentExactTag == \"\" then null else $currentExactTag end)",
		"  }' > \"$SCAN_ROOT/00_repository_state.json\"",
	].join("\n");
	const encoded = Buffer.from(shellScript, "utf-8").toString("base64");

	await execAsync(
		`docker exec ${input.containerName} bash -lc "echo '${encoded}' | base64 -d | bash"`,
	);

	const repositoryState = await execAsync(
		`docker exec ${input.containerName} bash -lc "cat '${input.scanRootDir}/00_repository_state.md'"`,
	);
	const repositoryStateJson = await execAsync(
		`docker exec ${input.containerName} bash -lc "cat '${input.scanRootDir}/00_repository_state.json'"`,
	);

	const parsed = JSON.parse(
		repositoryStateJson.stdout,
	) as Omit<PreparedRepositoryState, "markdown">;

	return {
		...parsed,
		markdown: repositoryState.stdout.trim(),
	};
};

const runClaudeHeadlessTurnInContainer = async (input: {
	containerName: string;
	cwd: string;
	prompt: string;
	model: string;
	thinkingLevel: string;
	envPairs: string[];
	sessionId?: string;
	jsonlPath: string;
	textPath: string;
	stderrPath: string;
	onSessionId?: (sessionId: string) => Promise<void>;
	onBridgeEvent?: (event: VulseekBridgeEvent) => Promise<void>;
	onBridgeParseError?: (error: BridgeParseError) => Promise<void>;
}) => {
	const promptFilePath = `/tmp/dokploy-claude-prompt-${nanoid()}.txt`;
	await writeContainerFile(input.containerName, promptFilePath, input.prompt);

	const exportLines = buildShellExports([
		`HOME=/root`,
		`VULSEEK_THINKING_LEVEL=${input.thinkingLevel}`,
		...input.envPairs,
	]);
	const claudeCommand = [
		`cd '${escapeSingleQuotes(input.cwd)}'`,
		exportLines,
		`claude -p \"$(cat '${promptFilePath}')\" --output-format stream-json --model '${escapeSingleQuotes(input.model)}'${input.sessionId ? ` --resume '${escapeSingleQuotes(input.sessionId)}'` : ""}`,
	].join(" && ");

	const child = spawn(
		"docker",
		["exec", "-i", input.containerName, "bash", "-lc", claudeCommand],
		{
			env: {
				...process.env,
				HOME: "/root",
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);

	let resolvedSessionId = input.sessionId || "";
	let bridgeEventBuffer = "";

	const stdoutLines = createInterface({ input: child.stdout });
	stdoutLines.on("line", async (line) => {
		try {
			await appendScanRuntimeFile(input.jsonlPath, `${line}\n`);
			const parsed = JSON.parse(line) as Record<string, unknown>;
			const rendered = renderClaudeStreamJsonMessage(parsed);
			if (rendered) {
				await appendScanRuntimeFile(input.textPath, rendered);
				bridgeEventBuffer += rendered;
				const { events, parseErrors, remaining } =
					extractVulseekBridgeEvents(bridgeEventBuffer);
				bridgeEventBuffer = remaining;
				for (const parseError of parseErrors) {
					await input.onBridgeParseError?.(parseError);
				}
				for (const event of events) {
					await input.onBridgeEvent?.(event);
				}
			}

			const nextSessionId = extractClaudeSessionId(parsed);
			if (nextSessionId && nextSessionId !== resolvedSessionId) {
				resolvedSessionId = nextSessionId;
				await input.onSessionId?.(resolvedSessionId);
			}
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Failed to parse Claude stream-json";
			await appendScanRuntimeFile(input.stderrPath, `[parse-error] ${message}\n`);
		}
	});

	child.stderr.on("data", (chunk) => {
		void appendScanRuntimeFile(input.stderrPath, chunk.toString());
	});

	const exitCode = await new Promise<number>((resolve, reject) => {
		child.on("error", (error) => reject(error));
		child.on("close", (code) => resolve(code ?? 0));
	});

	await execAsync(
		`docker exec ${input.containerName} bash -lc "rm -f '${promptFilePath}'"`,
	).catch(() => {});

	if (exitCode !== 0) {
		throw new Error(`claude headless exited with code ${exitCode}`);
	}

	return {
		sessionId: resolvedSessionId,
	};
};

export const runScanJobInContainer = async (scanJobId: string) => {
	const scanJob = await findScanJobById(scanJobId);
	const {
		isApplicationJob,
		appName,
		imageTag,
		contextVolumeName,
		projectName,
		serviceName,
		agentProfile,
	} = await resolveScanExecutionContext(scanJob);

	const containerName = [
		sanitizeContainerNamePart(projectName),
		sanitizeContainerNamePart(serviceName),
		scanJob.scanType,
		"scan",
		sanitizeContainerNamePart(scanJob.scanJobId),
	].join("-");
	const scanRootDir = `/scan-context/jobs/${scanJob.scanJobId}/scanning`;
	const startedAt = new Date().toISOString();
	const agentsDir = await resolveAgentsDirectory();
	const appServerJsonlPath = getScanJobAppServerJsonlPath(scanJob.scanJobId);
	const appServerTextPath = getScanJobAppServerTextPath(scanJob.scanJobId);
	const appServerStderrPath = getScanJobAppServerStderrPath(scanJob.scanJobId);
	const agentProvider = agentProfile?.provider || "codex";
	const containerEnvPairs = getGlobalContainerEnvironmentPairs();
	const containerEnvArgs = containerEnvPairs
		.map((pair) => `-e '${escapeSingleQuotes(pair)}'`)
		.join(" ");

	const stageSummary: string[] = [];
	let repositoryState: PreparedRepositoryState | null = null;
	const bridgeDebugStats = createEmptyScanBridgeDebugStats();
	let result:
		| {
				appName: string;
				imageTag: string;
				contextVolumeName: string;
				scanRootDir: string;
				codexStdoutSnippet: string;
				codexStderrSnippet: string;
		  }
		| undefined;
	await execAsync(
		`docker run -d --name ${containerName} -v ${contextVolumeName}:/scan-context ${containerEnvArgs} ${imageTag} bash -lc "sleep infinity"`,
	);

		stageSummary.push(`- container: ${containerName}`);
		stageSummary.push(`- image: ${imageTag}`);
		stageSummary.push(`- context_volume: ${contextVolumeName}`);
		stageSummary.push(`- scan_type: ${scanJob.scanType}`);
		stageSummary.push(`- container_env_count: ${containerEnvPairs.length}`);
		stageSummary.push(
			`- agent_transport: ${agentProvider === "claude_code" ? "claude-stream-json-stdio" : "codex-app-server-jsonrpc-stdio"}`,
		);
		stageSummary.push(
			`- agent_profile: ${agentProfile?.name || agentProfile?.agentProfileId || "default"}`,
		);
		stageSummary.push(`- agent_provider: ${agentProvider}`);
		stageSummary.push(`- agent_model: ${agentProfile?.model || "gpt-5.3-codex"}`);
		stageSummary.push(`- started_at: ${startedAt}`);

		await execAsync(
			`docker exec ${containerName} bash -lc "mkdir -p '${scanRootDir}' '/root/.codex/skills'"`,
		);

		await writeContainerFile(
			containerName,
			`${scanRootDir}/01_setup.md`,
			[
				"# Setup",
				"",
				`- scan_job_id: ${scanJob.scanJobId}`,
				`- scan_type: ${scanJob.scanType}`,
				`- target: ${isApplicationJob ? "application" : "compose"}`,
				`- app_name: ${appName}`,
				`- image_tag: ${imageTag}`,
				`- context_volume: ${contextVolumeName}`,
				`- target_ref: ${scanJob.targetRef || "<none>"}`,
				`- target_tag: ${scanJob.targetTag || "<none>"}`,
				`- commit_sha: ${scanJob.commitSha || "<none>"}`,
				`- base_sha: ${scanJob.baseSha || "<none>"}`,
				`- commit_window: ${scanJob.commitWindow}`,
				`- started_at: ${startedAt}`,
			].join("\n"),
		);

		if (agentsDir) {
			await execAsync(`docker cp "${agentsDir}/." ${containerName}:/root/.codex/skills/`);
			stageSummary.push(`- copied_skills_from: ${agentsDir}`);

			if (agentProfile) {
				await copyCodexAssetsToContainerHome(
					containerName,
					"/root/.codex",
					agentsDir,
					agentProfile,
				);
				stageSummary.push(
					agentProvider === "codex"
						? "- generated_codex_config_from_agent_profile: true"
						: "- using_agent_profile_runtime_env: true",
				);
			} else {
				const codexConfigPath = path.join(agentsDir, "codex-config.toml");
				try {
					await fs.stat(codexConfigPath);
					await execAsync(`docker cp "${codexConfigPath}" ${containerName}:/root/.codex/config.toml`);
					stageSummary.push("- copied_codex_config: true");
				} catch {
					stageSummary.push("- copied_codex_config: false");
				}

				const codexAuthPath = path.join(agentsDir, "codex-auth.json");
				try {
					await fs.stat(codexAuthPath);
					await execAsync(
						`docker cp "${codexAuthPath}" ${containerName}:/root/.codex/auth.json`,
					);
					stageSummary.push("- copied_codex_auth: true");
				} catch {
					stageSummary.push("- copied_codex_auth: false");
				}
			}
		} else {
			stageSummary.push("- copied_skills_from: none");
		}

		await writeContainerFile(
			containerName,
			`${scanRootDir}/02_skills.md`,
			["# Skills Copy", "", ...stageSummary].join("\n"),
		);
		await captureContainerCodexState(
			containerName,
			scanRootDir,
			"02_codex_runtime_before.md",
		);
		repositoryState = await prepareRepositoryForScanInContainer({
			containerName,
			scanJob,
			scanRootDir,
		});
		await updateScanJobTargetContext(scanJob.scanJobId, {
			targetRef: repositoryState.currentBranch || repositoryState.targetRef,
			targetTag: repositoryState.currentExactTag || repositoryState.targetTag,
			commitSha: repositoryState.resolvedTargetSha,
			baseSha: repositoryState.resolvedBaseSha,
			commitWindow: repositoryState.commitWindow,
		});

		try {
			const testPrompt = DEFAULT_CODEX_TEST_PROMPT;
			const codexPrompt = [
				`Run a ${scanJob.scanType} vulnerability scan for this repository.`,
				scanJob.scanType === "delta"
					? "For delta scan, always use the latest fetched ref/HEAD in the repository as the scan target."
					: "For full scan, use the explicitly prepared repository target revision.",
				`Target ref: ${repositoryState?.currentBranch || repositoryState?.targetRef || "<none>"}.`,
				`Target tag: ${repositoryState?.currentExactTag || repositoryState?.targetTag || "<none>"}.`,
				`Target commit: ${repositoryState?.resolvedTargetSha || "<none>"}.`,
				`Base commit: ${repositoryState?.resolvedBaseSha || "<none>"}.`,
				`Commit window k: ${repositoryState?.commitWindow || scanJob.commitWindow}.`,
				`Use ${agentProvider} as the runtime agent and keep reasoning effort around ${agentProfile?.thinkingLevel || "medium"}.`,
				`Before analyzing, use the repository state already prepared in ${scanRootDir}/00_repository_state.md and work from the checked out target revision in /workspace/repo.`,
				"Event emission is a hard requirement: if you identify candidates, print the literal <VULSEEK_EVENT>...</VULSEEK_EVENT> block to stdout before any prose claiming success.",
				"Do not say that you emitted candidate events unless the literal block was actually printed in this turn.",
				"If no candidates were found, say explicitly that no candidate event was emitted.",
				"Before finishing, print exactly one self-check line: VULSEEK_EVENT_SELF_CHECK candidate=<N> candidate_batch=<N> next_stage=<N>.",
				"Focus on security-relevant code paths and produce concise actionable findings.",
				`Write a markdown report to ${scanRootDir}/03_codex_report.md.`,
				repositoryState?.markdown
					? `Repository state:\n${repositoryState.markdown}`
					: "",
			].join("\n");

			await resetScanRuntimeFiles(scanJob.scanJobId);

			if (agentProvider === "claude_code") {
				if (!agentProfile) {
					throw new Error("Claude Code scan runtime requires an agent profile");
				}

				const claudeEnvPairs = buildClaudeEnvPairs(agentProfile);
				let sessionId = scanJob.scanningThreadId || "";
				await runClaudeHeadlessTurnInContainer({
					containerName,
					cwd: "/workspace/repo",
					prompt: testPrompt,
					model: agentProfile.model,
					thinkingLevel: agentProfile.thinkingLevel,
					envPairs: claudeEnvPairs,
					sessionId,
					jsonlPath: appServerJsonlPath,
					textPath: appServerTextPath,
					stderrPath: appServerStderrPath,
					onBridgeParseError: async (parseError) => {
						bridgeDebugStats.parseErrors += 1;
						await appendScanRuntimeFile(
							appServerStderrPath,
							`[bridge-debug] invalid VULSEEK_EVENT: ${parseError.message}; payload=${parseError.payloadSnippet}\n`,
						);
					},
					onSessionId: async (nextSessionId) => {
						sessionId = nextSessionId;
						await updateScanJobScanningThreadId(scanJob.scanJobId, nextSessionId);
					},
					onBridgeEvent: async (event) => {
						bridgeDebugStats.eventBlocks += 1;
						const persistResult = await persistVulseekBridgeEvent(
							scanJob.scanJobId,
							event,
						);
						if (
							persistResult.type === "candidate" ||
							persistResult.type === "candidate_batch"
						) {
							bridgeDebugStats.candidateEvents += 1;
							bridgeDebugStats.candidateRecordsReceived +=
								persistResult.receivedCandidates;
							bridgeDebugStats.candidateRecordsCreated +=
								persistResult.createdCandidates;
							bridgeDebugStats.candidateRecordsDropped +=
								persistResult.droppedCandidates;
						}
					},
				});
				await runClaudeHeadlessTurnInContainer({
					containerName,
					cwd: "/workspace/repo",
					prompt: codexPrompt,
					model: agentProfile.model,
					thinkingLevel: agentProfile.thinkingLevel,
					envPairs: claudeEnvPairs,
					sessionId,
					jsonlPath: appServerJsonlPath,
					textPath: appServerTextPath,
					stderrPath: appServerStderrPath,
					onBridgeParseError: async (parseError) => {
						bridgeDebugStats.parseErrors += 1;
						await appendScanRuntimeFile(
							appServerStderrPath,
							`[bridge-debug] invalid VULSEEK_EVENT: ${parseError.message}; payload=${parseError.payloadSnippet}\n`,
						);
					},
					onSessionId: async (nextSessionId) => {
						sessionId = nextSessionId;
						await updateScanJobScanningThreadId(scanJob.scanJobId, nextSessionId);
					},
					onBridgeEvent: async (event) => {
						bridgeDebugStats.eventBlocks += 1;
						const persistResult = await persistVulseekBridgeEvent(
							scanJob.scanJobId,
							event,
						);
						if (
							persistResult.type === "candidate" ||
							persistResult.type === "candidate_batch"
						) {
							bridgeDebugStats.candidateEvents += 1;
							bridgeDebugStats.candidateRecordsReceived +=
								persistResult.receivedCandidates;
							bridgeDebugStats.candidateRecordsCreated +=
								persistResult.createdCandidates;
							bridgeDebugStats.candidateRecordsDropped +=
								persistResult.droppedCandidates;
						}
					},
				});
			} else {

			const rpcChild = spawn(
				"docker",
				[
					"exec",
					"-i",
					containerName,
					"bash",
					"-lc",
					"cd /workspace/repo && codex app-server",
				],
				{
					env: {
						...process.env,
						HOME: "/root",
					},
					stdio: ["pipe", "pipe", "pipe"],
				},
			);

			let nextRequestId = 1;
			let threadId = "";
			let turnCompletionStatus = "";
			let turnCompletionError = "";
			let childExitCode: number | null = null;
			const pendingRequests = new Map<
				number,
				{
					resolve: (value: JsonRpcMessage) => void;
					reject: (error: Error) => void;
				}
			>();

			const sendJsonRpcMessage = (message: JsonRpcMessage) => {
				rpcChild.stdin.write(
					`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`,
				);
			};

			const sendJsonRpcRequest = (
				method: string,
				params?: Record<string, unknown>,
			) => {
				const id = nextRequestId++;
				const payload: JsonRpcMessage = {
					id,
					method,
					params,
				};

				return new Promise<JsonRpcMessage>((resolve, reject) => {
					pendingRequests.set(id, { resolve, reject });
					sendJsonRpcMessage(payload);
				});
			};

			let resolveTurnCompleted: (() => void) | undefined;
			let rejectTurnCompleted: ((error: Error) => void) | undefined;
			let bridgeEventBuffer = "";
			let turnCompleted = new Promise<void>((resolve, reject) => {
				resolveTurnCompleted = resolve;
				rejectTurnCompleted = reject;
			});

			const resetTurnCompletion = () => {
				turnCompletionStatus = "";
				turnCompletionError = "";
				turnCompleted = new Promise<void>((resolve, reject) => {
					resolveTurnCompleted = resolve;
					rejectTurnCompleted = reject;
				});
			};

			const stdoutLines = createInterface({ input: rpcChild.stdout });
			let stdoutLineProcessing = Promise.resolve();
			const agentMessageBuffers = new Map<string, string>();
			stdoutLines.on("line", (line) => {
				stdoutLineProcessing = stdoutLineProcessing.then(async () => {
					try {
						await appendScanRuntimeFile(appServerJsonlPath, `${line}\n`);
						const message = JSON.parse(line) as JsonRpcMessage;
						const rendered = renderJsonRpcMessage(message);
						if (rendered) {
							await appendScanRuntimeFile(appServerTextPath, rendered);
						}
						const bridgeText = resolveCompletedAgentMessageText(
							message,
							agentMessageBuffers,
						);
						if (bridgeText) {
							bridgeEventBuffer += bridgeText;
							const { events, parseErrors, remaining } =
								extractVulseekBridgeEvents(bridgeEventBuffer);
							bridgeEventBuffer = remaining;
							for (const parseError of parseErrors) {
								bridgeDebugStats.parseErrors += 1;
								await appendScanRuntimeFile(
									appServerStderrPath,
									`[bridge-debug] invalid VULSEEK_EVENT: ${parseError.message}; payload=${parseError.payloadSnippet}\n`,
								);
							}
							for (const event of events) {
								bridgeDebugStats.eventBlocks += 1;
								const persistResult = await persistVulseekBridgeEvent(
									scanJob.scanJobId,
									event,
								);
								if (
									persistResult.type === "candidate" ||
									persistResult.type === "candidate_batch"
								) {
									bridgeDebugStats.candidateEvents += 1;
									bridgeDebugStats.candidateRecordsReceived +=
										persistResult.receivedCandidates;
									bridgeDebugStats.candidateRecordsCreated +=
										persistResult.createdCandidates;
									bridgeDebugStats.candidateRecordsDropped +=
										persistResult.droppedCandidates;
								}
							}
						}

						if (typeof message.id === "number" && pendingRequests.has(message.id)) {
							const pendingRequest = pendingRequests.get(message.id);
							pendingRequests.delete(message.id);
							if (message.error?.message) {
								pendingRequest?.reject(new Error(message.error.message));
							} else {
								pendingRequest?.resolve(message);
							}
							return;
						}

						if (message.method === "thread/started") {
							threadId =
								extractNamedString(
									(message.params as Record<string, unknown> | undefined)?.thread,
									["threadId", "id"],
								) ||
								extractNamedString(message.params, ["threadId"]) ||
								threadId;
							if (threadId) {
								await updateScanJobScanningThreadId(scanJob.scanJobId, threadId);
							}
						}

						if (message.method === "turn/completed") {
							const turnRecord = (message.params as Record<string, unknown> | undefined)
								?.turn as Record<string, unknown> | undefined;
							turnCompletionStatus =
								extractNamedString(turnRecord, ["status"]) ||
								extractNamedString(message.params, ["status"]) ||
								"completed";
							turnCompletionError =
								extractTurnErrorMessage(turnRecord) ||
								message.error?.message ||
								(turnCompletionStatus === "failed"
									? "Codex turn completed with failed status"
									: "");
							resolveTurnCompleted?.();
						}
					} catch (error) {
						const message =
							error instanceof Error ? error.message : "Failed to parse JSON-RPC";
						await appendScanRuntimeFile(
							appServerStderrPath,
							`[parse-error] ${message}\n`,
						);
					}
				});
			});

			const runTurn = async (prompt: string) => {
				resetTurnCompletion();
				await sendJsonRpcRequest("turn/start", {
					threadId,
					input: [{ type: "text", text: prompt, text_elements: [] }],
					cwd: "/workspace/repo",
					approvalPolicy: "never",
					sandboxPolicy: {
						type: "externalSandbox",
						networkAccess: "enabled",
					},
				});
				await turnCompleted;
				if (turnCompletionStatus === "failed") {
					throw new Error(turnCompletionError || "Codex turn failed");
				}
			};

			rpcChild.stderr.on("data", (chunk) => {
				void appendScanRuntimeFile(appServerStderrPath, chunk.toString());
			});

			const childExited = new Promise<void>((resolve, reject) => {
				rpcChild.on("error", (error) => {
					for (const pendingRequest of pendingRequests.values()) {
						pendingRequest.reject(error);
					}
					pendingRequests.clear();
					reject(error);
				});

				rpcChild.on("close", (code) => {
					childExitCode = code;
					for (const pendingRequest of pendingRequests.values()) {
						pendingRequest.reject(
							new Error(`codex app-server exited before response (code ${code})`),
						);
					}
					pendingRequests.clear();
					if (!turnCompletionStatus) {
						rejectTurnCompleted?.(
							new Error(
								`codex app-server exited before turn completion (code ${code})`,
							),
						);
					}
					resolve();
				});
			});

			await sendJsonRpcRequest("initialize", {
				clientInfo: {
					name: "dokploy",
					version: "vulseek",
				},
				capabilities: {
					experimentalApi: true,
				},
			});
			sendJsonRpcMessage({ method: "initialized" });

			const threadStarted = await sendJsonRpcRequest("thread/start", {
				cwd: "/workspace/repo",
				approvalPolicy: "never",
				serviceName: "dokploy_scan",
				experimentalRawEvents: false,
				persistExtendedHistory: false,
			});
			threadId =
				extractNamedString(
					(threadStarted.result as Record<string, unknown> | undefined)?.thread,
					["threadId", "id"],
				) ||
				extractNamedString(threadStarted.result, ["threadId"]) ||
				extractNamedString(
					(threadStarted.params as Record<string, unknown> | undefined)?.thread,
					["threadId", "id"],
				) ||
				threadId;

			if (!threadId) {
				throw new Error("Codex app-server did not return a thread id");
			}
			await updateScanJobScanningThreadId(scanJob.scanJobId, threadId);

			stageSummary.push(`- codex_test_prompt: ${testPrompt}`);
			await runTurn(testPrompt);
			await runTurn(codexPrompt);
			try {
				rpcChild.stdin.end();
			} catch {}
			await childExited;
			await stdoutLineProcessing;

			if (childExitCode !== null && childExitCode !== 0) {
				throw new Error(`codex app-server exited with code ${childExitCode}`);
			}
			}
			await appendScanRuntimeFile(
				appServerStderrPath,
				[
					`[bridge-debug] event_blocks=${bridgeDebugStats.eventBlocks}`,
					`candidate_events=${bridgeDebugStats.candidateEvents}`,
					`candidate_records_received=${bridgeDebugStats.candidateRecordsReceived}`,
					`candidate_records_created=${bridgeDebugStats.candidateRecordsCreated}`,
					`candidate_records_dropped=${bridgeDebugStats.candidateRecordsDropped}`,
					`parse_errors=${bridgeDebugStats.parseErrors}`,
				].join(" ") + "\n",
			);
			if (bridgeDebugStats.candidateEvents === 0) {
				await appendScanRuntimeFile(
					appServerStderrPath,
					"[bridge-debug] scan agent did not emit any candidate or candidate_batch event\n",
				);
			} else if (bridgeDebugStats.candidateRecordsCreated === 0) {
				await appendScanRuntimeFile(
					appServerStderrPath,
					"[bridge-debug] candidate events were received but no candidate row was created; check payload title/shape\n",
				);
			}
		} catch (error) {
			await captureContainerCodexState(
				containerName,
				scanRootDir,
				"05_codex_runtime_after_failure.md",
			).catch(() => {});
			await copyScanRuntimeArtifactsToContainer(
				containerName,
				scanJob.scanJobId,
				scanRootDir,
			);

			const failedStdoutSnippet = (
				await readScanJobAppServerText(scanJob.scanJobId)
			).slice(-8_000);
			const failedStderrSnippet = await fs
				.readFile(appServerStderrPath, "utf-8")
				.catch(() => "");
			await writeContainerFile(
				containerName,
				`${scanRootDir}/04_summary.md`,
				[
					"# Scan Summary",
					"",
					`- completed_at: ${new Date().toISOString()}`,
					`- status: failed`,
					`- error: ${error instanceof Error ? error.message : "Unknown error"}`,
					`- app_name: ${appName}`,
					`- image_tag: ${imageTag}`,
					`- app_server_jsonl: ${scanRootDir}/03_app_server_messages.jsonl`,
					`- app_server_text: ${scanRootDir}/03_app_server_text.log`,
					"",
					"## App Server Text (tail)",
					"```text",
					failedStdoutSnippet || "(empty)",
					"```",
					"",
					"## App Server Stderr (tail)",
					"```text",
					failedStderrSnippet || "(empty)",
					"```",
				].join("\n"),
			);
			throw error;
		}

		await copyScanRuntimeArtifactsToContainer(
			containerName,
			scanJob.scanJobId,
			scanRootDir,
		);
		await captureContainerCodexState(
			containerName,
			scanRootDir,
			"05_codex_runtime_after_success.md",
		).catch(() => {});

		const codexStdoutSnippet = (await readScanJobAppServerText(scanJob.scanJobId)).slice(
			-8_000,
		);
		const codexStderrSnippet = await fs
			.readFile(appServerStderrPath, "utf-8")
			.catch(() => "");

		await writeContainerFile(
			containerName,
			`${scanRootDir}/04_summary.md`,
			[
				"# Scan Summary",
				"",
				`- completed_at: ${new Date().toISOString()}`,
				`- status: completed`,
				`- app_name: ${appName}`,
				`- image_tag: ${imageTag}`,
				`- app_server_jsonl: ${scanRootDir}/03_app_server_messages.jsonl`,
				`- app_server_text: ${scanRootDir}/03_app_server_text.log`,
				"",
				"## App Server Text (tail)",
				"```text",
				codexStdoutSnippet || "(empty)",
				"```",
				"",
				"## App Server Stderr (tail)",
				"```text",
				codexStderrSnippet || "(empty)",
				"```",
			].join("\n"),
		);

	result = {
		appName,
		imageTag,
		contextVolumeName,
		scanRootDir,
		codexStdoutSnippet,
		codexStderrSnippet,
	};

	return result as NonNullable<typeof result>;
};

export const runCandidateAnalysisAgentInContainer = async (input: {
	vulnerabilityCandidateId: string;
	stage: VulnerabilityCandidateStage;
	prompt: string;
}) => {
	const candidate = await findVulnerabilityCandidateById(
		input.vulnerabilityCandidateId,
	);
	const scanJob = await findScanJobById(candidate.scanJobId);
	const {
		appName,
		imageTag,
		contextVolumeName,
		projectName,
		serviceName,
		agentProfile,
	} = await resolveScanExecutionContext(scanJob);

	const stage = input.stage;
	const candidateRuntimeDir = resolveCandidateRuntimeDir(
		scanJob.scanJobId,
		candidate.vulnerabilityCandidateId,
	);
	const candidateRuntimeRootInContainer = `/scan-context/jobs/${scanJob.scanJobId}/candidates/${candidate.vulnerabilityCandidateId}`;
	const codexHome = `${candidateRuntimeRootInContainer}/.codex`;
	const appServerJsonlPath = getCandidateAnalysisAppServerJsonlPath(
		scanJob.scanJobId,
		candidate.vulnerabilityCandidateId,
	);
	const appServerTextPath = getCandidateAnalysisAppServerTextPath(
		scanJob.scanJobId,
		candidate.vulnerabilityCandidateId,
	);
	const appServerStderrPath = getCandidateAnalysisAppServerStderrPath(
		scanJob.scanJobId,
		candidate.vulnerabilityCandidateId,
	);
	const agentProvider = agentProfile?.provider || "codex";
	const containerEnvPairs = getGlobalContainerEnvironmentPairs();
	const containerEnvArgs = containerEnvPairs
		.map((pair) => `-e '${escapeSingleQuotes(pair)}'`)
		.join(" ");
	const containerName = [
		sanitizeContainerNamePart(projectName),
		sanitizeContainerNamePart(serviceName),
		sanitizeContainerNamePart(candidate.vulnerabilityCandidateId.slice(0, 8)),
		stage,
		String(Date.now()),
	].join("-");
	const agentsDir = await resolveAgentsDirectory();

	await fs.mkdir(candidateRuntimeDir, { recursive: true });
		await Promise.all([
			fs.writeFile(appServerJsonlPath, "", { flag: "a" }),
			fs.writeFile(appServerTextPath, "", { flag: "a" }),
			fs.writeFile(appServerStderrPath, "", { flag: "a" }),
		]);
		await updateVulnerabilityCandidateCurrentStage(
			candidate.vulnerabilityCandidateId,
			stage,
		);

	await execAsync(
		`docker run -d --rm --name ${containerName} -v ${contextVolumeName}:/scan-context ${containerEnvArgs} ${imageTag} bash -lc "mkdir -p '${candidateRuntimeRootInContainer}' '${codexHome}/skills' && sleep infinity"`,
	);

	try {
		await copyCodexAssetsToContainerHome(
			containerName,
			codexHome,
			agentsDir,
			agentProfile,
		);
		await writeContainerFile(
			containerName,
			`${candidateRuntimeRootInContainer}/01_setup.md`,
			[
				"# Candidate Stage Setup",
				"",
				`- scan_job_id: ${scanJob.scanJobId}`,
				`- candidate_id: ${candidate.vulnerabilityCandidateId}`,
				`- stage: ${stage}`,
				`- agent: analysis`,
				`- agent_profile: ${agentProfile?.name || agentProfile?.agentProfileId || "default"}`,
				`- agent_provider: ${agentProvider}`,
				`- agent_model: ${agentProfile?.model || "gpt-5.3-codex"}`,
				`- app_name: ${appName}`,
				`- image_tag: ${imageTag}`,
				`- context_volume: ${contextVolumeName}`,
			].join("\n"),
		);

		if (agentProvider === "claude_code") {
			if (!agentProfile) {
				throw new Error("Claude Code analysis runtime requires an agent profile");
			}

			let sessionId = getCandidateAnalysisThreadId(candidate);
			const startedAt = Date.now();
			await runClaudeHeadlessTurnInContainer({
				containerName,
				cwd: "/workspace/repo",
				prompt: [
					`Current analysis stage: ${stage}.`,
					`Use reasoning effort around ${agentProfile.thinkingLevel}.`,
					input.prompt,
				].join("\n\n"),
				model: agentProfile.model,
				thinkingLevel: agentProfile.thinkingLevel,
				envPairs: buildClaudeEnvPairs(agentProfile),
				sessionId,
				jsonlPath: appServerJsonlPath,
				textPath: appServerTextPath,
				stderrPath: appServerStderrPath,
				onBridgeEvent: async (event) => {
					await persistVulseekBridgeEvent(scanJob.scanJobId, event, {
						candidateId: candidate.vulnerabilityCandidateId,
						runtimeSeconds: (Date.now() - startedAt) / 1000,
						threadId: sessionId || candidate.analysisThreadId || undefined,
					});
				},
				onSessionId: async (nextSessionId) => {
					sessionId = nextSessionId;
					await updateVulnerabilityCandidateAnalysisThreadId(
						candidate.vulnerabilityCandidateId,
						nextSessionId,
					);
				},
			});

			return {
				scanJobId: scanJob.scanJobId,
				vulnerabilityCandidateId: candidate.vulnerabilityCandidateId,
				stage,
				threadId: sessionId,
				runtimeDir: candidateRuntimeDir,
				codexStdoutSnippet: (
					await readCandidateAnalysisAppServerText(
						scanJob.scanJobId,
						candidate.vulnerabilityCandidateId,
					)
				).slice(-8_000),
				codexStderrSnippet: await fs
					.readFile(appServerStderrPath, "utf-8")
					.catch(() => ""),
			};
		}

		const rpcChild = spawn(
			"docker",
			[
				"exec",
				"-i",
				containerName,
				"bash",
				"-lc",
				`cd /workspace/repo && export CODEX_HOME='${escapeSingleQuotes(
					codexHome,
				)}' && codex app-server`,
			],
			{
				env: {
					...process.env,
					HOME: "/root",
				},
				stdio: ["pipe", "pipe", "pipe"],
			},
		);

		let nextRequestId = 1;
		let threadId = getCandidateAnalysisThreadId(candidate);
		let turnCompletionStatus = "";
		let turnCompletionError = "";
		let childExitCode: number | null = null;
		const startedAt = Date.now();
		const pendingRequests = new Map<
			number,
			{
				resolve: (value: JsonRpcMessage) => void;
				reject: (error: Error) => void;
			}
		>();

		const sendJsonRpcMessage = (message: JsonRpcMessage) => {
			rpcChild.stdin.write(
				`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`,
			);
		};

		const sendJsonRpcRequest = (
			method: string,
			params?: Record<string, unknown>,
		) => {
			const id = nextRequestId++;
			const payload: JsonRpcMessage = { id, method, params };
			return new Promise<JsonRpcMessage>((resolve, reject) => {
				pendingRequests.set(id, { resolve, reject });
				sendJsonRpcMessage(payload);
			});
		};

		let resolveTurnCompleted: (() => void) | undefined;
		let rejectTurnCompleted: ((error: Error) => void) | undefined;
		let turnCompleted = new Promise<void>((resolve, reject) => {
			resolveTurnCompleted = resolve;
			rejectTurnCompleted = reject;
		});

		const resetTurnCompletion = () => {
			turnCompletionStatus = "";
			turnCompletionError = "";
			turnCompleted = new Promise<void>((resolve, reject) => {
				resolveTurnCompleted = resolve;
				rejectTurnCompleted = reject;
			});
		};

		const stdoutLines = createInterface({ input: rpcChild.stdout });
		let bridgeEventBuffer = "";
		const agentMessageBuffers = new Map<string, string>();
		stdoutLines.on("line", async (line) => {
			try {
				await appendScanRuntimeFile(appServerJsonlPath, `${line}\n`);
				const message = JSON.parse(line) as JsonRpcMessage;
				const rendered = renderJsonRpcMessage(message);
				if (rendered) {
					await appendScanRuntimeFile(appServerTextPath, rendered);
				}
				const bridgeText = resolveCompletedAgentMessageText(
					message,
					agentMessageBuffers,
				);
				if (bridgeText) {
					bridgeEventBuffer += bridgeText;
					const { events, parseErrors, remaining } =
						extractVulseekBridgeEvents(bridgeEventBuffer);
					bridgeEventBuffer = remaining;
					for (const parseError of parseErrors) {
						await appendScanRuntimeFile(
							appServerStderrPath,
							`[bridge-debug] invalid VULSEEK_EVENT: ${parseError.message}; payload=${parseError.payloadSnippet}\n`,
						);
					}
					for (const event of events) {
						try {
							await persistVulseekBridgeEvent(scanJob.scanJobId, event, {
								candidateId: candidate.vulnerabilityCandidateId,
								runtimeSeconds: (Date.now() - startedAt) / 1000,
								threadId: threadId || candidate.analysisThreadId || undefined,
							});
						} catch (error) {
							await appendScanRuntimeFile(
								appServerStderrPath,
								`[bridge-debug] failed to persist VULSEEK_EVENT type=${event.type}: ${
									error instanceof Error ? error.message : "unknown error"
								}\n`,
							);
							throw error;
						}
					}
				}

				if (typeof message.id === "number" && pendingRequests.has(message.id)) {
					const pendingRequest = pendingRequests.get(message.id);
					pendingRequests.delete(message.id);
					if (message.error?.message) {
						pendingRequest?.reject(new Error(message.error.message));
					} else {
						pendingRequest?.resolve(message);
					}
					return;
				}

				if (message.method === "thread/started") {
					threadId =
						extractNamedString(
							(message.params as Record<string, unknown> | undefined)?.thread,
							["threadId", "id"],
						) ||
						extractNamedString(message.params, ["threadId"]) ||
						threadId;
					if (threadId) {
						await updateVulnerabilityCandidateAnalysisThreadId(
							candidate.vulnerabilityCandidateId,
							threadId,
						);
					}
				}

				if (message.method === "turn/completed") {
					const turnRecord = (message.params as Record<string, unknown> | undefined)
						?.turn as Record<string, unknown> | undefined;
					turnCompletionStatus =
						extractNamedString(turnRecord, ["status"]) ||
						extractNamedString(message.params, ["status"]) ||
						"completed";
					turnCompletionError =
						extractTurnErrorMessage(turnRecord) ||
						message.error?.message ||
						(turnCompletionStatus === "failed"
							? "Codex turn completed with failed status"
							: "");
					resolveTurnCompleted?.();
				}
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Failed to parse JSON-RPC";
				await appendScanRuntimeFile(appServerStderrPath, `[parse-error] ${message}\n`);
			}
		});

		rpcChild.stderr.on("data", (chunk) => {
			void appendScanRuntimeFile(appServerStderrPath, chunk.toString());
		});

		const childExited = new Promise<void>((resolve, reject) => {
			rpcChild.on("error", (error) => {
				for (const pendingRequest of pendingRequests.values()) {
					pendingRequest.reject(error);
				}
				pendingRequests.clear();
				reject(error);
			});

			rpcChild.on("close", (code) => {
				childExitCode = code;
				for (const pendingRequest of pendingRequests.values()) {
					pendingRequest.reject(
						new Error(`codex app-server exited before response (code ${code})`),
					);
				}
				pendingRequests.clear();
				if (!turnCompletionStatus) {
					rejectTurnCompleted?.(
						new Error(
							`codex app-server exited before turn completion (code ${code})`,
						),
					);
				}
				resolve();
			});
		});

		await sendJsonRpcRequest("initialize", {
			clientInfo: {
				name: "dokploy",
				version: "vulseek",
			},
			capabilities: {
				experimentalApi: true,
			},
		});
		sendJsonRpcMessage({ method: "initialized" });

		if (threadId) {
			try {
				await sendJsonRpcRequest("thread/resume", {
					threadId,
					cwd: "/workspace/repo",
					approvalPolicy: "never",
					persistExtendedHistory: true,
				});
			} catch {
				threadId = "";
			}
		}

		if (!threadId) {
			const threadStarted = await sendJsonRpcRequest("thread/start", {
				cwd: "/workspace/repo",
				approvalPolicy: "never",
				serviceName: "dokploy_candidate_analysis",
				experimentalRawEvents: false,
				persistExtendedHistory: true,
			});
			threadId =
				extractNamedString(
					(threadStarted.result as Record<string, unknown> | undefined)?.thread,
					["threadId", "id"],
				) ||
				extractNamedString(threadStarted.result, ["threadId"]) ||
				threadId;
			if (!threadId) {
				throw new Error("Codex app-server did not return a thread id");
			}
			await updateVulnerabilityCandidateAnalysisThreadId(
				candidate.vulnerabilityCandidateId,
				threadId,
			);
		}

		resetTurnCompletion();
		await sendJsonRpcRequest("turn/start", {
			threadId,
			input: [{ type: "text", text: input.prompt, text_elements: [] }],
			cwd: "/workspace/repo",
			approvalPolicy: "never",
			sandboxPolicy: {
				type: "externalSandbox",
				networkAccess: "enabled",
			},
		});
		await turnCompleted;
		if (turnCompletionStatus === "failed") {
			throw new Error(turnCompletionError || "Codex turn failed");
		}

		try {
			rpcChild.stdin.end();
		} catch {}
		await childExited;
		if (childExitCode !== null && childExitCode !== 0) {
			throw new Error(`codex app-server exited with code ${childExitCode}`);
		}

		return {
			scanJobId: scanJob.scanJobId,
			vulnerabilityCandidateId: candidate.vulnerabilityCandidateId,
			stage,
			threadId,
			runtimeDir: candidateRuntimeDir,
			codexStdoutSnippet: (
				await readCandidateAnalysisAppServerText(
					scanJob.scanJobId,
					candidate.vulnerabilityCandidateId,
				)
			).slice(-8_000),
			codexStderrSnippet: await fs
				.readFile(appServerStderrPath, "utf-8")
				.catch(() => ""),
		};
	} finally {
		await execAsync(`docker rm -f ${containerName}`).catch(() => {});
	}
};

const buildCandidateAnalysisPrompt = async (input: {
	scanJob: ScanJob;
	candidate: VulnerabilityCandidate;
}) => {
	const reportPath = `/scan-context/jobs/${input.scanJob.scanJobId}/candidates/${input.candidate.vulnerabilityCandidateId}/analysis/01_report.md`;

	return [
		"You are the analysis agent for one vulnerability candidate.",
		"Work only on this candidate and decide whether it is a real issue.",
		`scan_job_id: ${input.scanJob.scanJobId}`,
		`candidate_id: ${input.candidate.vulnerabilityCandidateId}`,
		`candidate_title: ${input.candidate.title}`,
		`candidate_description: ${input.candidate.description || "-"}`,
		`candidate_file: ${input.candidate.filePath || "-"}`,
		`candidate_line: ${
			typeof input.candidate.line === "number" ? input.candidate.line : "-"
		}`,
		`write_report_to: ${reportPath}`,
		"",
		"Use the installed skill named deep-analysis as your working method.",
		"Event emission is mandatory.",
		'After writing the report, print exactly one literal <VULSEEK_EVENT>...</VULSEEK_EVENT> block with {"type":"analysis_result","payload":{...}}.',
		"Use payload fields: result, reportPath, summary.",
		"Do not use deep_analysis_result. Use analysis_result only.",
		"Do not include scanJobId or candidateId in the event payload; Dokploy will attach them.",
		"Dokploy will supplement runtimeSeconds and threadId if needed.",
		"",
		"Recommended result enum values:",
		"- real_vulnerability",
		"- likely_vulnerability",
		"- plausible_but_unproven",
		"- false_positive",
	].join("\n");
};

export const runScanJobAnalysisPipeline = async (scanJobId: string) => {
	const scanJob = await findScanJobById(scanJobId);
	const candidates = await findVulnerabilityCandidatesByScanJobId(scanJobId);
	if (candidates.length === 0) {
		return { total: 0, failed: 0 };
	}

	await updateScanJobStatus(scanJobId, "analyzing").catch(() => {});

	let failed = 0;
	let cursor = 0;
	const runNext = async () => {
		while (cursor < candidates.length) {
			const candidate = candidates[cursor++];
			if (!candidate) {
				break;
			}
			await updateVulnerabilityCandidateStatus(
				candidate.vulnerabilityCandidateId,
				"running",
			);
			await updateVulnerabilityCandidateCurrentStage(
				candidate.vulnerabilityCandidateId,
				"analyzing",
			);

			try {
				const prompt = await buildCandidateAnalysisPrompt({
					scanJob,
					candidate,
				});
				await runCandidateAnalysisAgentInContainer({
					vulnerabilityCandidateId: candidate.vulnerabilityCandidateId,
					stage: "analyzing",
					prompt,
				});

				const refreshed = await findVulnerabilityCandidateById(
					candidate.vulnerabilityCandidateId,
				);
				if (refreshed.status === "running") {
					await updateVulnerabilityCandidateStatus(
						candidate.vulnerabilityCandidateId,
						"completed",
					);
				}
			} catch (error) {
				failed += 1;
				await updateVulnerabilityCandidateStatus(
					candidate.vulnerabilityCandidateId,
					"failed",
				).catch(() => {});
			}
		}
	};

	const workers = Array.from({
		length: Math.min(ANALYSIS_CONCURRENCY, candidates.length),
	}).map(() => runNext());
	await Promise.all(workers);

	return {
		total: candidates.length,
		failed,
	};
};
