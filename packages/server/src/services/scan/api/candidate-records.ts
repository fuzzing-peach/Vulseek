import path from "node:path";
import { findApplicationById } from "../../application";
import { findComposeById } from "../../compose";
import {
	findVulnerabilityCandidateByIdAndScanJobIdRepo,
	findVulnerabilityCandidateByIdRepo,
	findVulnerabilityCandidatesByScanJobIdRepo,
	backfillVulnerabilityCandidatesFromTasks,
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
	listCandidateDescendantTasksByProducerTaskIdRepo,
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

export const backfillVulnerabilityCandidates = async (input?: {
	scanJobId?: string;
}) => await backfillVulnerabilityCandidatesFromTasks(input);

export const findVulnerabilityCandidatesWithLatestAnalysisResultByScanJobId =
	async (scanJobId: string) => {
		const [
			candidates,
			analysisResultsList,
			verificationResultsList,
			triageResultsList,
		] = await Promise.all([
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

	const analysisNodeIds = ["analysis_real_vulnerability", "analysis_likely_vulnerability", "analysis_plausible_but_unproven", "analysis_false_positive"];
	const verifyNodeIds = ["verify_true", "verify_likely", "verify_false"];
	const triageNodeIds = ["triage_security_issue", "triage_non_security", "triage_hardening", "triage_needs_review"];

	const a2v: Record<string, Record<string, number>> = {};
	for (const a of analysisNodeIds) { a2v[a] = {}; for (const v of verifyNodeIds) { a2v[a][v] = 0; } }
	const v2t: Record<string, Record<string, number>> = {};
	for (const v of verifyNodeIds) { v2t[v] = {}; for (const t of triageNodeIds) { v2t[v][t] = 0; } }

	const analysisTotals: Record<string, number> = {};
	for (const id of analysisNodeIds) { analysisTotals[id] = 0; }
	const verifyTotals: Record<string, number> = {};
	for (const id of verifyNodeIds) { verifyTotals[id] = 0; }

	for (const candidate of candidates) {
		const ar = candidate.latestAnalysisResult?.result;
		const vr = candidate.latestVerificationResult?.result;
		const tr = candidate.latestTriageResult;

		const aid = ar ? `analysis_${ar}` : null;
		const vid = (!vr || vr === "true" || vr === "likely") ? `verify_${vr || "missing"}` : vr === "false" ? "verify_false" : "verify_missing";
		const tid = tr ? (tr.result === "security_issue" ? "triage_security_issue" : tr.result === "hardening" ? "triage_hardening" : tr.result === "needs_review" ? "triage_needs_review" : "triage_non_security") : "triage_missing";

		if (aid && analysisTotals[aid] !== undefined) { analysisTotals[aid] += 1; }
		if (verifyTotals[vid] !== undefined) { verifyTotals[vid] += 1; }
			if (aid && a2v[aid]) {
				const row = a2v[aid];
				if (row && row[vid] !== undefined) row[vid] += 1;
			}
			const vRow = v2t[vid];
			if (vRow && vRow[tid] !== undefined) { vRow[tid] += 1; }
	}

	const links: Array<{ source: string; target: string; count: number }> = [];
	for (const [source, targets] of Object.entries(a2v)) {
		for (const [target, count] of Object.entries(targets)) {
			if (count > 0) links.push({ source, target, count });
		}
	}
	for (const [source, targets] of Object.entries(v2t)) {
		for (const [target, count] of Object.entries(targets)) {
			if (count > 0) links.push({ source, target, count });
		}
	}

	const nodeCount = (id: string, stage: string) => {
		if (stage === "analysis") return analysisTotals[id] || 0;
		if (stage === "verify") return verifyTotals[id] || 0;
		let c = 0; for (const v of verifyNodeIds) { c += (v2t[v]?.[id] || 0); } return c;
	};

	const titleCase = (s: string) => s.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
	const makeNode = (id: string, stage: string) => ({
		id, stage: stage as "analysis"|"verify"|"triage",
		label: titleCase(stage === "analysis" ? id.replace("analysis_", "") : stage === "verify" ? id.replace("verify_", "") : id.replace("triage_", "")),
		count: nodeCount(id, stage),
	});

	return {
		counts: {
			candidatesTotal: candidates.length,
			analysisPositive: nodeCount("analysis_real_vulnerability", "analysis") + nodeCount("analysis_likely_vulnerability", "analysis"),
			analysisReal: nodeCount("analysis_real_vulnerability", "analysis"),
			analysisLikely: nodeCount("analysis_likely_vulnerability", "analysis"),
			verificationTrue: nodeCount("verify_true", "verify"),
			verificationLikely: nodeCount("verify_likely", "verify"),
			verificationPositive: nodeCount("verify_true", "verify") + nodeCount("verify_likely", "verify"),
			triageSecurityIssue: nodeCount("triage_security_issue", "triage"),
		},
		taskTimeline,
		flow: {
			nodes: [
				...analysisNodeIds.map(id => makeNode(id, "analysis")),
				...verifyNodeIds.map(id => makeNode(id, "verify")),
				...triageNodeIds.map(id => makeNode(id, "triage")),
			],
			links,
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
	producerTaskId?: string;
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
		producerTaskId?: string;
	}) => {
		const candidate = input.scanJobId
			? await findVulnerabilityCandidateByIdAndScanJobIdRepo({
					vulnerabilityCandidateId: input.vulnerabilityCandidateId,
					scanJobId: input.scanJobId,
					producerTaskId: input.producerTaskId,
				})
				: await findVulnerabilityCandidateByIdRepo(
					input.vulnerabilityCandidateId,
				);
		const [analysisResult, verificationResult] = await Promise.all([
			findLatestAnalysisResultByCandidateIdRepo({
				scanJobId: candidate.scanJobId,
				vulnerabilityCandidateId: candidate.vulnerabilityCandidateId,
				producerTaskId: candidate.producerTaskId,
			}),
			findLatestVerificationResultByCandidateIdRepo({
				scanJobId: candidate.scanJobId,
				vulnerabilityCandidateId: candidate.vulnerabilityCandidateId,
				producerTaskId: candidate.producerTaskId,
			}),
		]);
		const triageResult = await findLatestTriageResultByCandidateIdRepo({
			scanJobId: candidate.scanJobId,
			vulnerabilityCandidateId: candidate.vulnerabilityCandidateId,
			producerTaskId: candidate.producerTaskId,
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
	if (
		task.stageName === "repository-profile" ||
		task.stageName === "repository-scan" ||
		task.stageName === "delta-scope"
	) {
		return "repository";
	}
	if (task.stageName === "identify-target" || task.stageName === "module-scan") {
		return "module";
	}
	if (task.stageName === "scan-target" || task.stageName === "function-scan") {
		return "function";
	}
	return null;
};

export const findCandidateTaskLineage = async (input: {
	vulnerabilityCandidateId: string;
	scanJobId?: string;
	producerTaskId?: string;
}) => {
	const candidate = input.scanJobId
		? await findVulnerabilityCandidateByIdAndScanJobIdRepo({
				vulnerabilityCandidateId: input.vulnerabilityCandidateId,
				scanJobId: input.scanJobId,
				producerTaskId: input.producerTaskId,
			})
		: await findVulnerabilityCandidateByIdRepo(input.vulnerabilityCandidateId);
	const upstreamTasks: CandidateTaskLineageItem[] = [];
	const seenTaskIds = new Set<string>();
	const visitedUpstreamTaskIds = new Set<string>();

	let currentTask = candidate.producerTaskId
		? await findTaskByIdRepo(candidate.producerTaskId).catch(() => null)
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
	const candidateTasks = candidate.producerTaskId
		? await listCandidateDescendantTasksByProducerTaskIdRepo({
				producerTaskId: candidate.producerTaskId,
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
