import {
	findVulnerabilityCandidateByIdAndScanJobIdRepo,
	findVulnerabilityCandidateByIdRepo,
	findVulnerabilityCandidatesByScanJobIdRepo,
} from "../persistence/candidate.repo";
import {
	findLatestAnalysisResultByCandidateIdRepo,
	findLatestVerificationResultByCandidateIdRepo,
	findTaskByIdRepo,
	listAnalysisResultsByScanJobIdRepo,
	listCandidateDescendantTasksByFunctionTaskIdRepo,
	listVerificationResultsByScanJobIdRepo,
} from "../persistence/task.repo";
import { buildCandidatesWithLatestResults } from "../state/candidate-aggregates";
import type { Task } from "../types";

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

const buildCandidateAnalysisReportPath = () => null;

const buildCandidateVerificationArtifactPaths = () => {
	const verifyRoot = null;
	return {
		verifyRoot,
		reportPath: null,
		issueDraftPath: null,
		pocPath: null,
		dockerfilePath: null,
		runScriptPath: null,
	};
};

export const findVulnerabilityCandidatesByScanJobId = async (
	scanJobId: string,
) => await findVulnerabilityCandidatesByScanJobIdRepo(scanJobId);

export const findVulnerabilityCandidatesWithLatestAnalysisResultByScanJobId =
	async (scanJobId: string) => {
		const [candidates, analysisResultsList, verificationResultsList] =
			await Promise.all([
				findVulnerabilityCandidatesByScanJobIdRepo(scanJobId),
				listAnalysisResultsByScanJobIdRepo(scanJobId),
				listVerificationResultsByScanJobIdRepo(scanJobId),
			]);

		return buildCandidatesWithLatestResults({
			candidates,
			analysisResults: analysisResultsList,
			verificationResults: verificationResultsList,
			buildAnalysisReportPath: buildCandidateAnalysisReportPath,
			buildVerificationArtifactPaths: buildCandidateVerificationArtifactPaths,
		});
	};

const RESULT_SORT_RANK: Record<string, number> = {
	real_vulnerability: 4,
	likely_vulnerability: 3,
	plausible_but_unproven: 2,
	api_misuse: 1,
	false_positive: 0,
};

export const findVulnerabilityCandidatesPageWithLatestAnalysisResultByScanJobId =
	async (input: {
		scanJobId: string;
		page: number;
		pageSize: number;
		query?: string;
		analysisResults?: string[];
		verifyResults?: string[];
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

		const filteredCandidates = candidates.filter((candidate) => {
			const latestAnalysisResult = candidate.latestAnalysisResult?.result || "";
			const latestVerifyResult =
				candidate.latestVerificationResult?.result || "";
			if (
				analysisResults.size > 0 &&
				!analysisResults.has(latestAnalysisResult)
			) {
				return false;
			}
			if (verifyResults.size > 0 && !verifyResults.has(latestVerifyResult)) {
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
				typeof candidate.latestVerificationResult?.isBug === "boolean"
					? String(candidate.latestVerificationResult.isBug)
					: "",
				typeof candidate.latestVerificationResult?.isSecurity === "boolean"
					? String(candidate.latestVerificationResult.isSecurity)
					: "",
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
				candidate.latestVerificationResult?.issueDraftPath || "",
				candidate.latestVerificationResult?.threadId || "",
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
			items: filteredCandidates.slice(startIndex, startIndex + pageSize),
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

		const [enrichedCandidate] = buildCandidatesWithLatestResults({
			candidates: [candidate],
			analysisResults: analysisResult ? [analysisResult] : [],
			verificationResults: verificationResult ? [verificationResult] : [],
			buildAnalysisReportPath: buildCandidateAnalysisReportPath,
			buildVerificationArtifactPaths: buildCandidateVerificationArtifactPaths,
		});
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
