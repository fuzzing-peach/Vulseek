import path from "node:path";
import { findApplicationById } from "../../application";
import { findComposeById } from "../../compose";
import {
	findVulnerabilityCandidateByIdAndScanJobIdRepo,
	findVulnerabilityCandidateByIdRepo,
	findVulnerabilityCandidatesByScanJobIdRepo,
} from "../persistence/candidate.repo";
import { findScanJobByIdRepo } from "../persistence/scan-job.repo";
import {
	findLatestAnalysisResultByCandidateIdRepo,
	findLatestTriageResultByCandidateIdRepo,
	findLatestVerificationResultByCandidateIdRepo,
	findTaskByIdRepo,
	listAnalysisResultsByScanJobIdRepo,
	listCandidateDescendantTasksByFunctionTaskIdRepo,
	listTriageResultsByScanJobIdRepo,
	listVerificationResultsByScanJobIdRepo,
} from "../persistence/task.repo";
import { buildCandidatesWithLatestResults } from "../state/candidate-aggregates";
import type { Task } from "../types";
import { resolveTaskRootSegment } from "../stages/full-scan-stage.runtime";

export type CandidateListSortKey =
	| "candidate"
	| "analysis"
	| "verify"
	| "score";
export type CandidateListSortDirection = "asc" | "desc";

export type CandidateTaskLineageRelation =
	| "repository"
	| "module"
	| "function"
	| "candidate";

export type CandidateTaskLineageItem = {
	taskId: string;
	scanJobId: string;
	parentTaskId: string | null;
	stageName: string;
	status: Task["status"];
	name: string;
	attempt: number;
	runtimeMode: Task["runtimeMode"];
	createdAt: string;
	startedAt: string | null;
	completedAt: string | null;
	relation: CandidateTaskLineageRelation;
};

const CONTAINER_SCAN_CONTEXT_ROOT = "/scan-context";
const CONTAINER_TASK_RUNTIME_ROOT = "/task";

const sanitizePathPart = (value: string) =>
	value
		.trim()
		.replace(/[\\/]/g, "-")
		.replace(/\s+/g, "-")
		.replace(/[^a-zA-Z0-9._-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "") || "default";

const isWithinPosixRoot = (filePath: string, rootPath: string) =>
	filePath === rootPath || filePath.startsWith(`${rootPath}/`);

const isWithinHostRoot = (filePath: string, rootPath: string) => {
	const resolvedFilePath = path.resolve(filePath);
	const resolvedRootPath = path.resolve(rootPath);
	return (
		resolvedFilePath === resolvedRootPath ||
		resolvedFilePath.startsWith(`${resolvedRootPath}${path.sep}`)
	);
};

const resolveConfiguredScanContextHostPath = () =>
	process.env.DOKPLOY_SCAN_CONTEXT_HOST_PATH?.trim() || "";

const resolveScanJobTargetIdentity = async (scanJob: {
	applicationId: string | null;
	composeId: string | null;
}) => {
	if (scanJob.applicationId) {
		const application = await findApplicationById(scanJob.applicationId);
		return {
			projectName: application.environment.project.name,
			profileName: application.name || application.appName,
		};
	}

	if (scanJob.composeId) {
		const compose = await findComposeById(scanJob.composeId);
		return {
			projectName: compose.environment.project.name,
			profileName: compose.name || compose.appName,
		};
	}

	throw new Error("Invalid scan job target");
};

const resolveProjectProfileHostContextRoot = async (scanJobId: string) => {
	const scanJob = await findScanJobByIdRepo(scanJobId);
	const { projectName, profileName } =
		await resolveScanJobTargetIdentity(scanJob);
	const configuredHostRoot = resolveConfiguredScanContextHostPath();
	if (!configuredHostRoot) {
		return null;
	}

	return path.join(
		configuredHostRoot,
		"projects",
		sanitizePathPart(projectName),
		"profiles",
		sanitizePathPart(profileName),
	);
};

const resolveScanContextHostPath = (
	projectProfileHostContextRoot: string,
	containerPath: string,
) => {
	const relativePath = path.posix.relative(
		CONTAINER_SCAN_CONTEXT_ROOT,
		containerPath,
	);
	if (
		!relativePath ||
		relativePath === ".." ||
		relativePath.startsWith("../")
	) {
		return null;
	}
	return path.join(
		projectProfileHostContextRoot,
		relativePath.split("/").join(path.sep),
	);
};

const resolveTaskHostRoot = async (input: {
	scanJobId: string;
	taskId: string;
	projectProfileHostContextRoot: string;
}) => {
	const task = await findTaskByIdRepo(input.taskId);
	if (task.scanJobId !== input.scanJobId) {
		return null;
	}

	const jobRootPath = path.join(
		input.projectProfileHostContextRoot,
		"jobs",
		input.scanJobId,
	);
	return path.join(
		jobRootPath,
		resolveTaskRootSegment(task.stageName, task.name, task.taskId),
	);
};

const resolveTaskArtifactHostPath = async (input: {
	scanJobId: string;
	taskId: string | null | undefined;
	containerPath: string;
	projectProfileHostContextRoot: string;
}) => {
	if (!input.taskId) {
		return null;
	}
	const taskRoot = await resolveTaskHostRoot({
		scanJobId: input.scanJobId,
		taskId: input.taskId,
		projectProfileHostContextRoot: input.projectProfileHostContextRoot,
	});
	if (!taskRoot) {
		return null;
	}

	const relativePath = path.posix.relative(
		CONTAINER_TASK_RUNTIME_ROOT,
		input.containerPath,
	);
	if (!relativePath || relativePath === "." || relativePath.startsWith("../")) {
		return null;
	}

	const hostPath = path.resolve(
		taskRoot,
		relativePath.split("/").join(path.sep),
	);
	return isWithinHostRoot(hostPath, taskRoot) ? hostPath : null;
};

const resolveHostPathForContainerPath = async (input: {
	scanJobId: string;
	taskId?: string | null;
	containerPath: string | null | undefined;
	projectProfileHostContextRoot: string | null;
}) => {
	const containerPath = input.containerPath?.trim();
	if (
		!containerPath ||
		!path.posix.isAbsolute(containerPath) ||
		!input.projectProfileHostContextRoot
	) {
		return null;
	}

	if (isWithinPosixRoot(containerPath, CONTAINER_SCAN_CONTEXT_ROOT)) {
		return resolveScanContextHostPath(
			input.projectProfileHostContextRoot,
			containerPath,
		);
	}

	if (isWithinPosixRoot(containerPath, CONTAINER_TASK_RUNTIME_ROOT)) {
		return await resolveTaskArtifactHostPath({
			scanJobId: input.scanJobId,
			taskId: input.taskId,
			containerPath,
			projectProfileHostContextRoot: input.projectProfileHostContextRoot,
		});
	}

	return null;
};

const enrichCandidateHostPaths = async <T extends { scanJobId: string }>(
	candidates: T[],
) => {
	const profileRootByScanJobId = new Map<string, string | null>();
	const getProfileRoot = async (scanJobId: string) => {
		if (!profileRootByScanJobId.has(scanJobId)) {
			profileRootByScanJobId.set(
				scanJobId,
				await resolveProjectProfileHostContextRoot(scanJobId).catch(() => null),
			);
		}
		return profileRootByScanJobId.get(scanJobId) ?? null;
	};

	return await Promise.all(
		candidates.map(async (candidate) => {
			const projectProfileHostContextRoot = await getProfileRoot(
				candidate.scanJobId,
			);
			const candidateRecord = candidate as T & {
				filePath?: string | null;
				latestAnalysisResult?: {
					taskId?: string | null;
					reportPath?: string | null;
				} | null;
				latestVerificationResult?: {
					taskId?: string | null;
					reportPath?: string | null;
				} | null;
				latestTriageResult?: {
					taskId?: string | null;
					reportPath?: string | null;
				} | null;
			};
			const [
				fileHostPath,
				analysisReportHostPath,
				verificationReportHostPath,
				triageReportHostPath,
			] = await Promise.all([
				resolveHostPathForContainerPath({
					scanJobId: candidate.scanJobId,
					containerPath: candidateRecord.filePath,
					projectProfileHostContextRoot,
				}),
				resolveHostPathForContainerPath({
					scanJobId: candidate.scanJobId,
					taskId: candidateRecord.latestAnalysisResult?.taskId,
					containerPath: candidateRecord.latestAnalysisResult?.reportPath,
					projectProfileHostContextRoot,
				}),
				resolveHostPathForContainerPath({
					scanJobId: candidate.scanJobId,
					taskId: candidateRecord.latestVerificationResult?.taskId,
					containerPath: candidateRecord.latestVerificationResult?.reportPath,
					projectProfileHostContextRoot,
				}),
				resolveHostPathForContainerPath({
					scanJobId: candidate.scanJobId,
					taskId: candidateRecord.latestTriageResult?.taskId,
					containerPath: candidateRecord.latestTriageResult?.reportPath,
					projectProfileHostContextRoot,
				}),
			]);

			return {
				...candidate,
				fileHostPath,
				latestAnalysisResult: candidateRecord.latestAnalysisResult
					? {
							...candidateRecord.latestAnalysisResult,
							reportHostPath: analysisReportHostPath,
						}
					: null,
				latestVerificationResult: candidateRecord.latestVerificationResult
					? {
							...candidateRecord.latestVerificationResult,
							reportHostPath: verificationReportHostPath,
						}
					: null,
				latestTriageResult: candidateRecord.latestTriageResult
					? {
							...candidateRecord.latestTriageResult,
							reportHostPath: triageReportHostPath,
						}
					: null,
			};
		}),
	);
};

const buildCandidateAnalysisReportPath = () => null;

const buildCandidateVerificationArtifactPaths = () => {
	const verifyRoot = null;
	return {
		verifyRoot,
		reportPath: null,
	};
};

export const findVulnerabilityCandidatesByScanJobId = async (
	scanJobId: string,
) => await findVulnerabilityCandidatesByScanJobIdRepo(scanJobId);

export const findVulnerabilityCandidatesWithLatestAnalysisResultByScanJobId =
	async (scanJobId: string) => {
		const [
			candidates,
			analysisResultsList,
			verificationResultsList,
			triageResultsList,
		] =
			await Promise.all([
				findVulnerabilityCandidatesByScanJobIdRepo(scanJobId),
				listAnalysisResultsByScanJobIdRepo(scanJobId),
				listVerificationResultsByScanJobIdRepo(scanJobId),
				listTriageResultsByScanJobIdRepo(scanJobId),
			]);

		return buildCandidatesWithLatestResults({
			candidates,
			analysisResults: analysisResultsList,
			verificationResults: verificationResultsList,
			triageResults: triageResultsList,
			buildAnalysisReportPath: buildCandidateAnalysisReportPath,
			buildVerificationArtifactPaths: buildCandidateVerificationArtifactPaths,
		});
	};

const RESULT_SORT_RANK: Record<string, number> = {
	real_vulnerability: 4,
	true: 4,
	likely_vulnerability: 3,
	likely: 3,
	plausible_but_unproven: 2,
	api_misuse: 1,
	false_positive: 0,
	false: 0,
};

export const findVulnerabilityCandidatesPageWithLatestAnalysisResultByScanJobId =
	async (input: {
		scanJobId: string;
		page: number;
		pageSize: number;
		query?: string;
		analysisResults?: string[];
		verifyResults?: string[];
		triageResults?: string[];
		sortKey: CandidateListSortKey;
		sortDirection: CandidateListSortDirection;
	}) => {
		const candidates =
			await findVulnerabilityCandidatesWithLatestAnalysisResultByScanJobId(
				input.scanJobId,
			);
		const query = (input.query || "").trim().toLowerCase();
		const analysisResults = new Set(input.analysisResults || []);
		const verifyResults = new Set(input.verifyResults || []);
		const triageResults = new Set(input.triageResults || []);

		const filteredCandidates = candidates.filter((candidate) => {
			const latestAnalysisResult = candidate.latestAnalysisResult?.result || "";
			const latestVerifyResult =
				candidate.latestVerificationResult?.result || "";
			const latestTriageResult = candidate.latestTriageResult?.result || "";
			if (
				analysisResults.size > 0 &&
				!analysisResults.has(latestAnalysisResult)
			) {
				return false;
			}
			if (verifyResults.size > 0 && !verifyResults.has(latestVerifyResult)) {
				return false;
			}
			if (triageResults.size > 0 && !triageResults.has(latestTriageResult)) {
				return false;
			}
			if (!query) {
				return true;
			}

			const haystack = [
				candidate.title,
				candidate.description || "",
				candidate.filePath || "",
				candidate.status,
				typeof candidate.line === "number" ? String(candidate.line) : "",
				candidate.latestAnalysisResult?.result || "",
				candidate.latestAnalysisResult?.reportPath || "",
				candidate.latestAnalysisResult?.threadId || "",
				candidate.latestVerificationResult?.result || "",
				typeof candidate.latestVerificationResult?.confidence === "number"
					? String(candidate.latestVerificationResult.confidence)
					: "",
				typeof candidate.latestVerificationResult?.score === "number"
					? String(candidate.latestVerificationResult.score)
					: "",
				typeof candidate.latestAnalysisResult?.score === "number"
					? String(candidate.latestAnalysisResult.score)
					: "",
				typeof candidate.score === "number" ? String(candidate.score) : "",
				candidate.latestVerificationResult?.reportPath || "",
				candidate.latestVerificationResult?.threadId || "",
				candidate.latestTriageResult?.result || "",
				candidate.latestTriageResult?.securityClassification || "",
				candidate.latestTriageResult?.impactType || "",
				candidate.latestTriageResult?.cvssSeverity || "",
				typeof candidate.latestTriageResult?.cvssScore === "number"
					? String(candidate.latestTriageResult.cvssScore)
					: "",
				typeof candidate.latestTriageResult?.epssProbability30d === "number"
					? String(candidate.latestTriageResult.epssProbability30d)
					: "",
				candidate.latestTriageResult?.reportPath || "",
			]
				.join("\n")
				.toLowerCase();
			return haystack.includes(query);
		});

		const direction = input.sortDirection === "asc" ? 1 : -1;
		filteredCandidates.sort((left, right) => {
			if (input.sortKey === "candidate") {
				return direction * left.title.localeCompare(right.title);
			}

			if (input.sortKey === "analysis") {
				const leftRank =
					RESULT_SORT_RANK[left.latestAnalysisResult?.result || ""] ?? -1;
				const rightRank =
					RESULT_SORT_RANK[right.latestAnalysisResult?.result || ""] ?? -1;
				if (leftRank !== rightRank) {
					return direction * (leftRank - rightRank);
				}
				return direction * left.title.localeCompare(right.title);
			}

			if (input.sortKey === "verify") {
				const leftRank =
					RESULT_SORT_RANK[left.latestVerificationResult?.result || ""] ?? -1;
				const rightRank =
					RESULT_SORT_RANK[right.latestVerificationResult?.result || ""] ?? -1;
				if (leftRank !== rightRank) {
					return direction * (leftRank - rightRank);
				}
				return direction * left.title.localeCompare(right.title);
			}

			const leftScore = typeof left.score === "number" ? left.score : -1;
			const rightScore = typeof right.score === "number" ? right.score : -1;
			if (leftScore !== rightScore) {
				return direction * (leftScore - rightScore);
			}
			return direction * left.title.localeCompare(right.title);
		});

		const pageSize = Math.max(1, Math.min(100, input.pageSize));
		const total = filteredCandidates.length;
		const totalPages = Math.max(1, Math.ceil(total / pageSize));
		const page = Math.min(Math.max(1, input.page), totalPages);
		const startIndex = (page - 1) * pageSize;

		return {
			items: await enrichCandidateHostPaths(
				filteredCandidates.slice(startIndex, startIndex + pageSize),
			),
			total,
			page,
			pageSize,
			totalPages,
		};
	};

export const findVulnerabilityCandidateById = async (
	vulnerabilityCandidateId: string,
) => await findVulnerabilityCandidateByIdRepo(vulnerabilityCandidateId);

export const findVulnerabilityCandidateByIdForScanJob = async (input: {
	vulnerabilityCandidateId: string;
	scanJobId: string;
}) => await findVulnerabilityCandidateByIdAndScanJobIdRepo(input);

export const findVulnerabilityCandidateWithLatestAnalysisResultById =
	async (input: { vulnerabilityCandidateId: string; scanJobId?: string }) => {
		const candidate = input.scanJobId
			? await findVulnerabilityCandidateByIdAndScanJobIdRepo({
					vulnerabilityCandidateId: input.vulnerabilityCandidateId,
					scanJobId: input.scanJobId,
				})
			: await findVulnerabilityCandidateByIdRepo(
					input.vulnerabilityCandidateId,
				);
		const [analysisResult, verificationResult] = await Promise.all([
			findLatestAnalysisResultByCandidateIdRepo({
				scanJobId: candidate.scanJobId,
				vulnerabilityCandidateId: candidate.vulnerabilityCandidateId,
				scanFunctionTaskId: candidate.scanFunctionTaskId,
			}),
			findLatestVerificationResultByCandidateIdRepo({
				scanJobId: candidate.scanJobId,
				vulnerabilityCandidateId: candidate.vulnerabilityCandidateId,
				scanFunctionTaskId: candidate.scanFunctionTaskId,
			}),
		]);
		const triageResult = await findLatestTriageResultByCandidateIdRepo({
			scanJobId: candidate.scanJobId,
			vulnerabilityCandidateId: candidate.vulnerabilityCandidateId,
			scanFunctionTaskId: candidate.scanFunctionTaskId,
		});

		const [enrichedCandidate] = await enrichCandidateHostPaths(
			buildCandidatesWithLatestResults({
				candidates: [candidate],
				analysisResults: analysisResult ? [analysisResult] : [],
				verificationResults: verificationResult ? [verificationResult] : [],
				triageResults: triageResult ? [triageResult] : [],
				buildAnalysisReportPath: buildCandidateAnalysisReportPath,
				buildVerificationArtifactPaths: buildCandidateVerificationArtifactPaths,
			}),
		);
		if (!enrichedCandidate) {
			throw new Error("Unable to build candidate detail");
		}
		return enrichedCandidate;
	};

const toLineageItem = (
	task: Task,
	relation: CandidateTaskLineageRelation,
): CandidateTaskLineageItem => ({
	taskId: task.taskId,
	scanJobId: task.scanJobId,
	parentTaskId: task.parentTaskId,
	stageName: task.stageName,
	status: task.status,
	name: task.name,
	attempt: task.attempt,
	runtimeMode: task.runtimeMode,
	createdAt: task.createdAt,
	startedAt: task.startedAt,
	completedAt: task.completedAt,
	relation,
});

const resolveUpstreamRelation = (
	task: Task,
): CandidateTaskLineageRelation | null => {
	if (task.stageName === "repository-scan") {
		return "repository";
	}
	if (task.stageName === "module-scan") {
		return "module";
	}
	if (task.stageName === "function-scan") {
		return "function";
	}
	return null;
};

export const findCandidateTaskLineage = async (input: {
	vulnerabilityCandidateId: string;
	scanJobId?: string;
}) => {
	const candidate = input.scanJobId
		? await findVulnerabilityCandidateByIdAndScanJobIdRepo({
				vulnerabilityCandidateId: input.vulnerabilityCandidateId,
				scanJobId: input.scanJobId,
			})
		: await findVulnerabilityCandidateByIdRepo(input.vulnerabilityCandidateId);
	const upstreamTasks: CandidateTaskLineageItem[] = [];
	const seenTaskIds = new Set<string>();
	const visitedUpstreamTaskIds = new Set<string>();

	let currentTask = candidate.scanFunctionTaskId
		? await findTaskByIdRepo(candidate.scanFunctionTaskId).catch(() => null)
		: null;
	while (currentTask) {
		if (visitedUpstreamTaskIds.has(currentTask.taskId)) {
			break;
		}
		if (currentTask.scanJobId !== candidate.scanJobId) {
			break;
		}
		visitedUpstreamTaskIds.add(currentTask.taskId);
		const relation = resolveUpstreamRelation(currentTask);
		if (relation && !seenTaskIds.has(currentTask.taskId)) {
			upstreamTasks.push(toLineageItem(currentTask, relation));
			seenTaskIds.add(currentTask.taskId);
		}
		currentTask = currentTask.parentTaskId
			? await findTaskByIdRepo(currentTask.parentTaskId).catch(() => null)
			: null;
	}
	upstreamTasks.reverse();

	const downstreamTasks: CandidateTaskLineageItem[] = [];
	const candidateTasks = candidate.scanFunctionTaskId
		? await listCandidateDescendantTasksByFunctionTaskIdRepo({
				scanFunctionTaskId: candidate.scanFunctionTaskId,
				vulnerabilityCandidateId: candidate.vulnerabilityCandidateId,
			})
		: [];
	for (const task of candidateTasks) {
		if (seenTaskIds.has(task.taskId)) {
			continue;
		}
		downstreamTasks.push(toLineageItem(task, "candidate"));
		seenTaskIds.add(task.taskId);
	}
	downstreamTasks.sort((left, right) =>
		left.createdAt.localeCompare(right.createdAt),
	);

	return {
		vulnerabilityCandidateId: candidate.vulnerabilityCandidateId,
		scanJobId: candidate.scanJobId,
		tasks: [...upstreamTasks, ...downstreamTasks],
	};
};
