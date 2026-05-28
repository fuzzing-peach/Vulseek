import { db } from "@dokploy/server/db";
import {
	applications,
	compose,
	environments,
	projects,
	scanJobs,
	tasks,
} from "@dokploy/server/db/schema";
import { eq } from "drizzle-orm";
import { candidateSchema } from "../artifacts/contracts/domain-object.contract";
import { readTaskJsonArtifact } from "../artifacts/task-artifact-paths";
import { resolveTaskRuntimeDirForTask } from "../stages/full-scan-stage.runtime";

type TaskRecord = typeof tasks.$inferSelect;

const asRecord = (value: unknown): Record<string, unknown> | null =>
	value && typeof value === "object" ? (value as Record<string, unknown>) : null;

const readString = (
	record: Record<string, unknown> | null,
	key: string,
): string | null => {
	const value = record?.[key];
	return typeof value === "string" && value.length > 0 ? value : null;
};

const scanJobRuntimeContextCache = new Map<
	string,
	Promise<{ projectName: string; serviceName: string }>
>();

const resolveScanJobRuntimeContext = async (scanJobId: string) => {
	const cached = scanJobRuntimeContextCache.get(scanJobId);
	if (cached) {
		return cached;
	}

	const resolved = (async () => {
		const applicationTarget = await db
			.select({
				projectName: projects.name,
				serviceName: applications.name,
				appName: applications.appName,
			})
			.from(scanJobs)
			.innerJoin(
				applications,
				eq(scanJobs.applicationId, applications.applicationId),
			)
			.innerJoin(
				environments,
				eq(applications.environmentId, environments.environmentId),
			)
			.innerJoin(projects, eq(environments.projectId, projects.projectId))
			.where(eq(scanJobs.scanJobId, scanJobId))
			.limit(1)
			.then((rows) => rows[0] || null);

		if (applicationTarget) {
			return {
				projectName: applicationTarget.projectName,
				serviceName:
					applicationTarget.serviceName || applicationTarget.appName,
			};
		}

		const composeTarget = await db
			.select({
				projectName: projects.name,
				serviceName: compose.name,
				appName: compose.appName,
			})
			.from(scanJobs)
			.innerJoin(compose, eq(scanJobs.composeId, compose.composeId))
			.innerJoin(environments, eq(compose.environmentId, environments.environmentId))
			.innerJoin(projects, eq(environments.projectId, projects.projectId))
			.where(eq(scanJobs.scanJobId, scanJobId))
			.limit(1)
			.then((rows) => rows[0] || null);

		if (composeTarget) {
			return {
				projectName: composeTarget.projectName,
				serviceName: composeTarget.serviceName || composeTarget.appName,
			};
		}

		throw new Error(`Invalid scan job target for ${scanJobId}`);
	})();

	scanJobRuntimeContextCache.set(scanJobId, resolved);
	return resolved;
};

export const resolveTaskArtifactRuntimeDirForTask = async (
	task: Pick<TaskRecord, "scanJobId" | "stageName" | "name" | "taskId">,
) => {
	const context = await resolveScanJobRuntimeContext(task.scanJobId);
	return await resolveTaskRuntimeDirForTask({
		scanJobId: task.scanJobId,
		projectName: context.projectName,
		serviceName: context.serviceName,
		stageName: task.stageName,
		taskName: task.name,
		taskId: task.taskId,
	});
};

export const readTaskJsonArtifactForTask = async <T = unknown>(
	task: Pick<TaskRecord, "scanJobId" | "stageName" | "name" | "taskId">,
	containerPath: string,
): Promise<T> => {
	const taskDir = await resolveTaskArtifactRuntimeDirForTask(task);
	return await readTaskJsonArtifact<T>({
		taskDir,
		containerPath,
	});
};

export const readCandidateIdFromTaskInputArtifact = async (
	task: TaskRecord,
) => {
	const input = asRecord(task.input);
	const directCandidate = asRecord(input?.candidate);
	const directCandidateId = readString(directCandidate, "id");
	if (directCandidateId) {
		return directCandidateId;
	}

	const legacyCandidate = asRecord(input?.legacyCandidate);
	const legacyCandidateId = readString(legacyCandidate, "id");
	if (legacyCandidateId) {
		return legacyCandidateId;
	}

	const analysisResult = asRecord(input?.analysisResult);
	const nestedCandidate = asRecord(analysisResult?.candidate);
	const nestedCandidateId = readString(nestedCandidate, "id");
	if (nestedCandidateId) {
		return nestedCandidateId;
	}

	const candidatePath = readString(input, "candidatePath");
	if (!candidatePath) {
		return null;
	}

	try {
		const candidate = await readTaskJsonArtifactForTask(task, candidatePath);
		const parsed = candidateSchema.safeParse(candidate);
		return parsed.success ? parsed.data.id : null;
	} catch {
		return null;
	}
};
