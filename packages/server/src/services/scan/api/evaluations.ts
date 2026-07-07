import { promises as fs } from "node:fs";
import path from "node:path";
import { db } from "@vulseek/server/db";
import {
	EvaluateConfigSchema,
	scanEvaluateResults,
} from "@vulseek/server/db/schema";
import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { execAsync } from "../../../utils/process/execAsync";
import { getAgentProfileById } from "../../ai";
import { findApplicationById } from "../../application";
import { findScanJobByIdRepo } from "../persistence/scan-job.repo";
import {
	runSingleTurnAgentInContainer,
	startContainer,
} from "../runtime/run-single-turn-agent";
import type { AgentProfileLike, ScanJob } from "../types";
import { findVulnerabilityCandidatesWithLatestAnalysisResultByScanJobId } from "./candidate-records";

const CONTAINER_SCAN_CONTEXT_ROOT = "/scan-context";
const EVALUATION_OUTPUT_FILE_NAME = "output.json";
const EVALUATION_TIMEOUT_MS = 30 * 60 * 1000;

export const scanEvaluationConfigSchema = z
	.strictObject({
		agentProfileId: z.string().trim().min(1, {
			message: "agentProfileId is required",
		}),
		groundTruthPath: z
			.string()
			.trim()
			.min(1)
			.refine((value) => path.posix.isAbsolute(value), {
				message: "groundTruthPath must be an absolute container path",
			}),
	})
	.pipe(EvaluateConfigSchema);

export const scanEvaluationMatchSchema = z.object({
	candidateId: z.string().optional(),
	groundTruthId: z.string().optional(),
	title: z.string().optional(),
	reason: z.string().optional(),
});

export const scanEvaluationResultSchema = z.object({
	truePositive: z.number().int().nonnegative(),
	falsePositive: z.number().int().nonnegative(),
	falseNegative: z.number().int().nonnegative(),
	precision: z.number().min(0).max(1),
	recall: z.number().min(0).max(1),
	f1: z.number().min(0).max(1),
	matches: z.array(scanEvaluationMatchSchema.passthrough()),
	summary: z.string(),
});

const sanitizeContextPathPart = (value: string) =>
	value
		.trim()
		.replace(/[\\/]/g, "-")
		.replace(/\s+/g, "-")
		.replace(/[^a-zA-Z0-9._-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "") || "default";

const buildProjectProfileContextRoot = () => CONTAINER_SCAN_CONTEXT_ROOT;

const buildMountedProjectProfileContextRoot = (
	projectName: string,
	profileName: string,
) =>
	path.join(
		buildProjectProfileContextRoot(),
		"projects",
		sanitizeContextPathPart(projectName),
		"profiles",
		sanitizeContextPathPart(profileName),
	);

const buildHostProjectProfileContextRoot = (
	hostRoot: string,
	projectName: string,
	profileName: string,
) =>
	path.join(
		hostRoot,
		"projects",
		sanitizeContextPathPart(projectName),
		"profiles",
		sanitizeContextPathPart(profileName),
	);

const resolveProjectProfileHostContextRoot = async (scanJob: ScanJob) => {
	if (!scanJob.applicationId) {
		throw new Error("Evaluate only supports application scan jobs");
	}
	const application = await findApplicationById(scanJob.applicationId);
	const projectName = application.environment.project.name;
	const profileName = application.name || application.appName;
	const mountedProfileDir = buildMountedProjectProfileContextRoot(
		projectName,
		profileName,
	);

	try {
		await fs.access(mountedProfileDir);
		return mountedProfileDir;
	} catch {}

	const configuredHostRoot =
		process.env.VULSEEK_SCAN_CONTEXT_HOST_PATH?.trim() || "";
	if (!configuredHostRoot) {
		throw new Error(
			"Scan context host path is not configured in process env VULSEEK_SCAN_CONTEXT_HOST_PATH",
		);
	}

	const hostProfileDir = buildHostProjectProfileContextRoot(
		configuredHostRoot,
		projectName,
		profileName,
	);
	await fs.mkdir(hostProfileDir, { recursive: true });
	return hostProfileDir;
};

const csvEscape = (value: unknown) => {
	const text =
		value === null || value === undefined
			? ""
			: typeof value === "string"
				? value
				: String(value);
	return `"${text.replace(/"/g, '""')}"`;
};

const buildRealVulnCsv = async (scanJobId: string) => {
	const candidates =
		await findVulnerabilityCandidatesWithLatestAnalysisResultByScanJobId(
			scanJobId,
		);
	const positiveCandidates = candidates.filter((candidate) => {
		const triage = candidate.latestTriageResult;
		return (
			triage?.isSecurityIssue === true || triage?.result === "security_issue"
		);
	});
	const headers = [
		"candidateId",
		"title",
		"description",
		"filePath",
		"line",
		"vulnerabilityType",
		"triageResult",
		"triageSummary",
		"cvssScore",
		"cvssSeverity",
	];
	const rows = positiveCandidates.map((candidate) => [
		candidate.vulnerabilityCandidateId,
		candidate.title,
		candidate.description,
		candidate.filePath,
		candidate.line,
		candidate.vulnerabilityType,
		candidate.latestTriageResult?.result,
		candidate.latestTriageResult?.summary,
		candidate.latestTriageResult?.cvssScore,
		candidate.latestTriageResult?.cvssSeverity,
	]);

	return [
		headers.map(csvEscape).join(","),
		...rows.map((row) => row.map(csvEscape).join(",")),
	].join("\n");
};

const buildEvaluationPrompt = (input: {
	groundTruthPath: string;
	realVulnCsvPath: string;
}) => `
You are evaluating scanner results against a ground-truth vulnerability file.

Inputs:
- Scanner real-vulnerability CSV: ${input.realVulnCsvPath}
- Ground truth absolute path in this container: ${input.groundTruthPath}

Read both inputs from disk. Match scanner candidates to ground-truth entries by vulnerability identity, affected file/function/line, and vulnerability type. Be conservative: only count a true positive when the scanner finding corresponds to a real ground-truth vulnerability. Count scanner findings without a ground-truth match as false positives, and ground-truth vulnerabilities without a scanner match as false negatives.

Return only the structured JSON result required by the output schema. Use numeric precision, recall, and f1 in the range 0..1. Include a short summary.
`.trim();

const resolveEvaluationAgentProfile = async (
	agentProfileId: string,
): Promise<AgentProfileLike> => {
	const agentProfile = await getAgentProfileById(agentProfileId).catch(
		() => null,
	);
	if (!agentProfile) {
		throw new Error("Evaluate agent profile not found");
	}
	if (!agentProfile.isEnabled) {
		throw new Error("Evaluate agent profile is disabled");
	}
	return agentProfile;
};

const readEvaluationOutput = async (evaluationDir: string) => {
	const outputPath = path.join(evaluationDir, EVALUATION_OUTPUT_FILE_NAME);
	const content = await fs.readFile(outputPath, "utf-8");
	const parsed: unknown = JSON.parse(content);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Evaluate output.json must be an object");
	}
	const envelope = parsed as { output?: unknown };
	return scanEvaluationResultSchema.parse(envelope.output);
};

const waitForEvaluationOutput = async (input: {
	evaluationDir: string;
	timeoutMs: number;
}) => {
	const outputPath = path.join(input.evaluationDir, EVALUATION_OUTPUT_FILE_NAME);
	const deadline = Date.now() + input.timeoutMs;
	let lastError: unknown = null;
	while (Date.now() < deadline) {
		try {
			const content = await fs.readFile(outputPath, "utf-8");
			if (content.trim()) {
				return;
			}
		} catch (error) {
			lastError = error;
		}
		await new Promise((resolve) => setTimeout(resolve, 2000));
	}
	throw new Error(
		`Evaluation timed out waiting for output.json after ${Math.floor(
			input.timeoutMs / 1000,
		)}s${
			lastError instanceof Error ? `: ${lastError.message}` : ""
		}`,
	);
};

export const createScanEvaluationResult = async (input: {
	scanJobId: string;
	configSnapshot: z.input<typeof scanEvaluationConfigSchema>;
}) => {
	const configSnapshot = scanEvaluationConfigSchema.parse(input.configSnapshot);
	const scanJob = await findScanJobByIdRepo(input.scanJobId);
	if (!scanJob.applicationId || scanJob.composeId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Evaluate only supports application scan jobs",
		});
	}

	return await db
		.insert(scanEvaluateResults)
		.values({
			scanJobId: scanJob.scanJobId,
			applicationId: scanJob.applicationId,
			status: "pending",
			configSnapshot,
		})
		.returning()
		.then((rows) => rows[0]);
};

export const findLatestScanEvaluationResult = async (scanJobId: string) =>
	await db.query.scanEvaluateResults.findFirst({
		where: eq(scanEvaluateResults.scanJobId, scanJobId),
		orderBy: [desc(scanEvaluateResults.createdAt)],
	});

export const listScanEvaluationResults = async (scanJobId: string) =>
	await db.query.scanEvaluateResults.findMany({
		where: eq(scanEvaluateResults.scanJobId, scanJobId),
		orderBy: [desc(scanEvaluateResults.createdAt)],
	});

export const runScanEvaluation = async (evaluateResultId: string) => {
	const evaluation = await db.query.scanEvaluateResults.findFirst({
		where: eq(scanEvaluateResults.evaluateResultId, evaluateResultId),
	});
	if (!evaluation) {
		throw new Error("Evaluate result not found");
	}
	const startedAt = new Date().toISOString();
	await db
		.update(scanEvaluateResults)
		.set({ status: "running", startedAt, updatedAt: startedAt })
		.where(eq(scanEvaluateResults.evaluateResultId, evaluateResultId));

	try {
		const config = scanEvaluationConfigSchema.parse(evaluation.configSnapshot);
		const scanJob = await findScanJobByIdRepo(evaluation.scanJobId);
		if (
			!scanJob.applicationId ||
			scanJob.applicationId !== evaluation.applicationId
		) {
			throw new Error("Evaluate only supports application scan jobs");
		}

		const profileRoot = await resolveProjectProfileHostContextRoot(scanJob);
		const evaluationRelativePath = path.join(
			"jobs",
			scanJob.scanJobId,
			"evaluations",
			evaluateResultId,
		);
		const evaluationDir = path.join(profileRoot, evaluationRelativePath);
		await fs.mkdir(evaluationDir, { recursive: true });
		const realVulnCsvPath = path.join(evaluationDir, "real-vulns.csv");
		await fs.writeFile(
			realVulnCsvPath,
			await buildRealVulnCsv(scanJob.scanJobId),
			"utf-8",
		);

		const evaluationDirInContainer = path.posix.join(
			CONTAINER_SCAN_CONTEXT_ROOT,
			...evaluationRelativePath.split(path.sep),
		);
		const realVulnCsvPathInContainer = path.posix.join(
			evaluationDirInContainer,
			"real-vulns.csv",
		);
		await db
			.update(scanEvaluateResults)
			.set({
				realVulnCsvPath: realVulnCsvPathInContainer,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(scanEvaluateResults.evaluateResultId, evaluateResultId));
		const agentProfile = await resolveEvaluationAgentProfile(
			config.agentProfileId,
		);
		const containerName = `vulseek-evaluate-${sanitizeContextPathPart(
			scanJob.scanJobId,
		).slice(0, 24)}-${sanitizeContextPathPart(evaluateResultId).slice(0, 12)}`;

		await startContainer({
			scanJob,
			agentProfile,
			containerName,
			codexHome: path.posix.join(
				evaluationDirInContainer,
				".codex-evaluate",
			),
			stageDirPath: evaluationDir,
			stageRootInContainer: evaluationDirInContainer,
			taskRealRootInContainer: evaluationDirInContainer,
			persistent: false,
			reuseContainer: false,
		});

		try {
			await runSingleTurnAgentInContainer({
				scanJob,
				agentProfile,
				containerName,
				codexHome: path.posix.join(
					evaluationDirInContainer,
					".codex-evaluate",
				),
				stageDirPath: evaluationDir,
				stageRootInContainer: evaluationDirInContainer,
				taskStageDirPath: evaluationDir,
				taskStageRootInContainer: evaluationDirInContainer,
				taskRealRootInContainer: evaluationDirInContainer,
				persistent: false,
				reuseContainer: true,
				cwd: "/workspace/repo",
				prompt: buildEvaluationPrompt({
					groundTruthPath: config.groundTruthPath,
					realVulnCsvPath: realVulnCsvPathInContainer,
				}),
				outputSchema: scanEvaluationResultSchema,
			});
			await waitForEvaluationOutput({
				evaluationDir,
				timeoutMs: EVALUATION_TIMEOUT_MS,
			});
		} finally {
			await execAsync(`docker rm -f ${containerName}`).catch(() => {});
		}

		const result = await readEvaluationOutput(evaluationDir);
		const finishedAt = new Date().toISOString();
		await db
			.update(scanEvaluateResults)
			.set({
				status: "completed",
				realVulnCsvPath: realVulnCsvPathInContainer,
				result,
				errorMessage: null,
				finishedAt,
				updatedAt: finishedAt,
			})
			.where(eq(scanEvaluateResults.evaluateResultId, evaluateResultId));
		return result;
	} catch (error) {
		const finishedAt = new Date().toISOString();
		const errorMessage = error instanceof Error ? error.message : String(error);
		await db
			.update(scanEvaluateResults)
			.set({
				status: "failed",
				errorMessage,
				finishedAt,
				updatedAt: finishedAt,
			})
			.where(eq(scanEvaluateResults.evaluateResultId, evaluateResultId));
		throw error;
	}
};
