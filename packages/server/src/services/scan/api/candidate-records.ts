import {
	findVulnerabilityCandidateByIdRepo,
	findVulnerabilityCandidatesByScanJobIdRepo,
} from "../persistence/candidate.repo";
import {
	listAnalysisResultsByScanJobIdRepo,
	listTasksByScanJobIdRepo,
	listVerificationResultsByScanJobIdRepo,
} from "../persistence/task.repo";
import { readCandidateIdFromTaskInputArtifact } from "../persistence/task-artifact-resolver";
import { buildCandidatesWithLatestResults } from "../state/candidate-aggregates";
import type { Task } from "../types";

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

export const findVulnerabilityCandidateById = async (
	vulnerabilityCandidateId: string,
) => await findVulnerabilityCandidateByIdRepo(vulnerabilityCandidateId);

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

export const findCandidateTaskLineage = async (
	vulnerabilityCandidateId: string,
) => {
	const candidate = await findVulnerabilityCandidateByIdRepo(
		vulnerabilityCandidateId,
	);
	const tasks = await listTasksByScanJobIdRepo(candidate.scanJobId);
	const tasksById = new Map(tasks.map((task) => [task.taskId, task]));
	const upstreamTasks: CandidateTaskLineageItem[] = [];
	const seenTaskIds = new Set<string>();
	const visitedUpstreamTaskIds = new Set<string>();

	let currentTask = candidate.scanFunctionTaskId
		? tasksById.get(candidate.scanFunctionTaskId) || null
		: null;
	while (currentTask) {
		if (visitedUpstreamTaskIds.has(currentTask.taskId)) {
			break;
		}
		visitedUpstreamTaskIds.add(currentTask.taskId);
		const relation = resolveUpstreamRelation(currentTask);
		if (relation && !seenTaskIds.has(currentTask.taskId)) {
			upstreamTasks.push(toLineageItem(currentTask, relation));
			seenTaskIds.add(currentTask.taskId);
		}
		currentTask = currentTask.parentTaskId
			? tasksById.get(currentTask.parentTaskId) || null
			: null;
	}
	upstreamTasks.reverse();

	const downstreamTasks: CandidateTaskLineageItem[] = [];
	for (const task of tasks) {
		if (seenTaskIds.has(task.taskId)) {
			continue;
		}
		const taskCandidateId = await readCandidateIdFromTaskInputArtifact(task);
		if (taskCandidateId !== vulnerabilityCandidateId) {
			continue;
		}
		downstreamTasks.push(toLineageItem(task, "candidate"));
		seenTaskIds.add(task.taskId);
	}
	downstreamTasks.sort((left, right) =>
		left.createdAt.localeCompare(right.createdAt),
	);

	return {
		vulnerabilityCandidateId,
		scanJobId: candidate.scanJobId,
		tasks: [...upstreamTasks, ...downstreamTasks],
	};
};
