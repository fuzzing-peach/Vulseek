import path from "node:path";
import { findApplicationById } from "../../application";
import { findComposeById } from "../../compose";
import {
	findVulnerabilityCandidateByIdAndScanJobIdRepo,
	findVulnerabilityCandidateByIdRepo,
	findVulnerabilityCandidatesByScanJobIdRepo,
	listCandidateTagsRepo,
	updateVulnerabilityCandidateMetadataRepo,
} from "../persistence/candidate.repo";
import { findScanJobByIdRepo } from "../persistence/scan-job.repo";
import {
	findLatestAnalysisResultByCandidateIdRepo,
	findLatestTriageResultByCandidateIdRepo,
	findLatestVerificationResultByCandidateIdRepo,
	findTaskByIdRepo,
	listAnalysisResultsByScanJobIdRepo,
	listCandidateDescendantTasksByFunctionTaskIdRepo,
	listTaskRuntimeIntervalsByScanJobIdRepo,
	listTriageResultsByScanJobIdRepo,
	listVerificationResultsByScanJobIdRepo,
} from "../persistence/task.repo";
import { buildCandidatesWithLatestResults } from "../state/candidate-aggregates";
import type { Task } from "../types";
import { resolveTaskRootSegment } from "../stages/full-scan-stage.runtime";

export type CandidateListSortKey =
	| "latestResultUpdatedAt"
	| "createdAt"
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
	process.env.VULSEEK_SCAN_CONTEXT_HOST_PATH?.trim() || "";

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

const isPositiveAnalysisResult = (result: string | null | undefined) =>
	result === "real_vulnerability" || result === "likely_vulnerability";

const isPositiveVerificationResult = (result: string | null | undefined) =>
	result === "true" || result === "likely";

const isPositiveTriageResult = (
	result: string | null | undefined,
	isSecurityIssue?: boolean | null,
) => isSecurityIssue === true || result === "security_issue";

const incrementCount = <TKey extends string>(
	counts: Record<TKey, number>,
	key: TKey,
	amount = 1,
) => {
	counts[key] += amount;
};

const ACTIVE_TASK_STATUSES = new Set([
	"launching",
	"launched",
	"starting",
	"running",
]);

const parseTimestampMs = (value: string | null | undefined) => {
	if (!value) {
		return null;
	}
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : null;
};

const findScanJobTaskTimeline = async (scanJobId: string) => {
	const nowMs = Date.now();
	const intervals = await listTaskRuntimeIntervalsByScanJobIdRepo(scanJobId);
	const normalizedIntervals: Array<{ startMs: number; endMs: number }> = [];
	let activeTaskCount = 0;

	for (const task of intervals) {
		const startMs = parseTimestampMs(task.startedAt) ?? parseTimestampMs(task.createdAt);
		if (startMs === null) {
			continue;
		}

		const isActive = ACTIVE_TASK_STATUSES.has(task.status);
		const endMs = isActive
			? nowMs
			: (parseTimestampMs(task.completedAt) ??
				parseTimestampMs(task.updatedAt) ??
				startMs);
		if (isActive) {
			activeTaskCount += 1;
		}
		normalizedIntervals.push({
			startMs,
			endMs: Math.max(startMs, endMs),
		});
	}

	if (normalizedIntervals.length === 0) {
		return {
			taskCount: 0,
			activeTaskCount: 0,
			startedAt: null,
			finishedAt: null,
			spanSeconds: 0,
			coveredSeconds: 0,
		};
	}

	normalizedIntervals.sort((left, right) => left.startMs - right.startMs);
	let coveredMs = 0;
	let spanStartMs = normalizedIntervals[0]?.startMs ?? nowMs;
	let spanEndMs = spanStartMs;
	let currentStartMs = spanStartMs;
	let currentEndMs = normalizedIntervals[0]?.endMs ?? spanStartMs;

	for (const interval of normalizedIntervals) {
		spanStartMs = Math.min(spanStartMs, interval.startMs);
		spanEndMs = Math.max(spanEndMs, interval.endMs);
		if (interval.startMs <= currentEndMs) {
			currentEndMs = Math.max(currentEndMs, interval.endMs);
			continue;
		}
		coveredMs += currentEndMs - currentStartMs;
		currentStartMs = interval.startMs;
		currentEndMs = interval.endMs;
	}
	coveredMs += currentEndMs - currentStartMs;

	return {
		taskCount: normalizedIntervals.length,
		activeTaskCount,
		startedAt: new Date(spanStartMs).toISOString(),
		finishedAt: activeTaskCount > 0 ? null : new Date(spanEndMs).toISOString(),
		spanSeconds: Math.max(0, Math.floor((spanEndMs - spanStartMs) / 1000)),
		coveredSeconds: Math.max(0, Math.floor(coveredMs / 1000)),
	};
};

export const findScanJobResultSummary = async (scanJobId: string) => {
	const [candidates, taskTimeline] = await Promise.all([
		findVulnerabilityCandidatesWithLatestAnalysisResultByScanJobId(scanJobId),
		findScanJobTaskTimeline(scanJobId),
	]);
	const counts = {
		candidatesTotal: candidates.length,
		analysisPositive: 0,
		analysisReal: 0,
		analysisLikely: 0,
		verificationTrue: 0,
		verificationLikely: 0,
		verificationPositive: 0,
		triageSecurityIssue: 0,
	};
	const analysisFlowBySource: Record<
		"analysis_real" | "analysis_likely",
		{
			verify_true: number;
			verify_likely: number;
			verify_false: number;
			verify_missing: number;
		}
	> = {
		analysis_real: {
			verify_true: 0,
			verify_likely: 0,
			verify_false: 0,
			verify_missing: 0,
		},
		analysis_likely: {
			verify_true: 0,
			verify_likely: 0,
			verify_false: 0,
			verify_missing: 0,
		},
	};
	const transitionLinks: Array<{
		source: string;
		target: string;
		count: number;
	}> = [];
	const verifyBucketCounts = {
		verify_true: 0,
		verify_likely: 0,
		verify_false: 0,
		verify_missing: 0,
	};
	const triageByVerifyBucket: Record<
		keyof typeof verifyBucketCounts,
		{
			triage_security_issue: number;
			triage_not_security: number;
			triage_missing: number;
		}
	> = {
		verify_true: {
			triage_security_issue: 0,
			triage_not_security: 0,
			triage_missing: 0,
		},
		verify_likely: {
			triage_security_issue: 0,
			triage_not_security: 0,
			triage_missing: 0,
		},
		verify_false: {
			triage_security_issue: 0,
			triage_not_security: 0,
			triage_missing: 0,
		},
		verify_missing: {
			triage_security_issue: 0,
			triage_not_security: 0,
			triage_missing: 0,
		},
	};

	for (const candidate of candidates) {
		const analysisResult = candidate.latestAnalysisResult?.result;
		const verificationResult = candidate.latestVerificationResult?.result;
		const triageResult = candidate.latestTriageResult?.result;
		const triageIsSecurityIssue =
			candidate.latestTriageResult?.isSecurityIssue ?? null;
		let verifyBucket: keyof typeof verifyBucketCounts = "verify_missing";
		if (verificationResult === "true") {
			verifyBucket = "verify_true";
		} else if (verificationResult === "likely") {
			verifyBucket = "verify_likely";
		} else if (verificationResult === "false") {
			verifyBucket = "verify_false";
		}
		incrementCount(verifyBucketCounts, verifyBucket);

		const triageBucket = candidate.latestTriageResult
			? isPositiveTriageResult(triageResult, triageIsSecurityIssue)
				? "triage_security_issue"
				: "triage_not_security"
			: "triage_missing";
		triageByVerifyBucket[verifyBucket][triageBucket] += 1;

		if (isPositiveAnalysisResult(analysisResult)) {
			counts.analysisPositive += 1;
			if (analysisResult === "real_vulnerability") {
				counts.analysisReal += 1;
			}
			if (analysisResult === "likely_vulnerability") {
				counts.analysisLikely += 1;
			}
			const analysisBucket =
				analysisResult === "real_vulnerability"
					? "analysis_real"
					: "analysis_likely";
			analysisFlowBySource[analysisBucket][verifyBucket] += 1;
		}

		if (verificationResult === "true") {
			counts.verificationTrue += 1;
		}
		if (verificationResult === "likely") {
			counts.verificationLikely += 1;
		}
		if (isPositiveVerificationResult(verificationResult)) {
			counts.verificationPositive += 1;
		}
		if (isPositiveTriageResult(triageResult, triageIsSecurityIssue)) {
			counts.triageSecurityIssue += 1;
		}
	}

	for (const [source, targets] of Object.entries(analysisFlowBySource)) {
		for (const [target, count] of Object.entries(targets)) {
			if (count > 0) {
				transitionLinks.push({
					source,
					target,
					count,
				});
			}
		}
	}
	for (const [source, targets] of Object.entries(triageByVerifyBucket)) {
		for (const [target, count] of Object.entries(targets)) {
			if (count > 0) {
				transitionLinks.push({ source, target, count });
			}
		}
	}

	return {
		counts,
		taskTimeline,
		flow: {
			nodes: [
				{
					id: "analysis_real",
					label: "Analysis Real",
					stage: "analysis",
					count: counts.analysisReal,
				},
				{
					id: "analysis_likely",
					label: "Analysis Likely",
					stage: "analysis",
					count: counts.analysisLikely,
				},
				{
					id: "verify_true",
					label: "Verify True",
					stage: "verify",
					count: verifyBucketCounts.verify_true,
				},
				{
					id: "verify_likely",
					label: "Verify Likely",
					stage: "verify",
					count: verifyBucketCounts.verify_likely,
				},
				{
					id: "verify_false",
					label: "Verify False",
					stage: "verify",
					count: verifyBucketCounts.verify_false,
				},
				{
					id: "verify_missing",
					label: "Verify Missing",
					stage: "verify",
					count: verifyBucketCounts.verify_missing,
				},
				{
					id: "triage_security_issue",
					label: "Triage True",
					stage: "triage",
					count:
						triageByVerifyBucket.verify_true.triage_security_issue +
						triageByVerifyBucket.verify_likely.triage_security_issue +
						triageByVerifyBucket.verify_false.triage_security_issue +
						triageByVerifyBucket.verify_missing.triage_security_issue,
				},
				{
					id: "triage_not_security",
					label: "Triage False",
					stage: "triage",
					count:
						triageByVerifyBucket.verify_true.triage_not_security +
						triageByVerifyBucket.verify_likely.triage_not_security +
						triageByVerifyBucket.verify_false.triage_not_security +
						triageByVerifyBucket.verify_missing.triage_not_security,
				},
				{
					id: "triage_missing",
					label: "Triage Missing",
					stage: "triage",
					count:
						triageByVerifyBucket.verify_true.triage_missing +
						triageByVerifyBucket.verify_likely.triage_missing +
						triageByVerifyBucket.verify_false.triage_missing +
						triageByVerifyBucket.verify_missing.triage_missing,
				},
			],
			links: transitionLinks,
		},
	};
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

const resolveCandidateLatestResultUpdatedAtMs = (candidate: {
	createdAt: string;
	latestAnalysisResult?: { updatedAt?: string | null } | null;
	latestVerificationResult?: { updatedAt?: string | null } | null;
	latestTriageResult?: { updatedAt?: string | null } | null;
}) => {
	const timestamps = [
		candidate.latestAnalysisResult?.updatedAt,
		candidate.latestVerificationResult?.updatedAt,
		candidate.latestTriageResult?.updatedAt,
	]
		.map((value) => (value ? Date.parse(value) : Number.NaN))
		.filter(Number.isFinite);
	if (timestamps.length > 0) {
		return Math.max(...timestamps);
	}
	const createdAtMs = Date.parse(candidate.createdAt);
	return Number.isFinite(createdAtMs) ? createdAtMs : 0;
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
				candidate.note || "",
				...(candidate.tags || []),
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
				candidate.latestTriageResult?.disqualifier || "",
				candidate.latestTriageResult?.disqualifierReason || "",
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
			if (input.sortKey === "latestResultUpdatedAt") {
				const leftUpdatedAtMs = resolveCandidateLatestResultUpdatedAtMs(left);
				const rightUpdatedAtMs = resolveCandidateLatestResultUpdatedAtMs(right);
				if (leftUpdatedAtMs !== rightUpdatedAtMs) {
					return direction * (leftUpdatedAtMs - rightUpdatedAtMs);
				}
				return left.title.localeCompare(right.title);
			}

			if (input.sortKey === "createdAt") {
				const createdAtCompare = left.createdAt.localeCompare(right.createdAt);
				if (createdAtCompare !== 0) {
					return direction * createdAtCompare;
				}
				return left.title.localeCompare(right.title);
			}

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
	scanFunctionTaskId?: string;
}) => await findVulnerabilityCandidateByIdAndScanJobIdRepo(input);

export const listCandidateTags = async () => await listCandidateTagsRepo();

export const updateVulnerabilityCandidateMetadata = async (input: {
	vulnerabilityCandidateId: string;
	scanJobId: string;
	note: string;
	tags: string[];
}) => await updateVulnerabilityCandidateMetadataRepo(input);

export const findVulnerabilityCandidateWithLatestAnalysisResultById =
	async (input: {
		vulnerabilityCandidateId: string;
		scanJobId?: string;
		scanFunctionTaskId?: string;
	}) => {
		const candidate = input.scanJobId
			? await findVulnerabilityCandidateByIdAndScanJobIdRepo({
					vulnerabilityCandidateId: input.vulnerabilityCandidateId,
					scanJobId: input.scanJobId,
					scanFunctionTaskId: input.scanFunctionTaskId,
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
	if (task.stageName === "repository-scan" || task.stageName === "delta-scope") {
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
	scanFunctionTaskId?: string;
}) => {
	const candidate = input.scanJobId
		? await findVulnerabilityCandidateByIdAndScanJobIdRepo({
				vulnerabilityCandidateId: input.vulnerabilityCandidateId,
				scanJobId: input.scanJobId,
				scanFunctionTaskId: input.scanFunctionTaskId,
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
