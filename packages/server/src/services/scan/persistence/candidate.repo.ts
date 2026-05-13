import { TRPCError } from "@trpc/server";
import { desc, eq, or } from "drizzle-orm";
import { db } from "@dokploy/server/db";
import {
	taskStatusEnum,
	tasks,
} from "@dokploy/server/db/schema";
import {
	analysisSchema,
	candidateSchema,
	verificationSchema,
} from "../artifacts/contracts/domain-object.contract";
import { listTasksByScanJobAndStageRepo } from "./task.repo";

type DerivedCandidateRecord = {
	vulnerabilityCandidateId: string;
	scanJobId: string;
	scanFunctionTaskId: string | null;
	title: string;
	description: string | null;
	filePath: string | null;
	line: number | null;
	vulnerabilityType: string | null;
	status: (typeof taskStatusEnum.enumValues)[number];
	currentStage: "analyzing" | "fuzzing" | "verifying";
	confidence: number | null;
	score: number | null;
	createdAt: string;
	updatedAt: string;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
	value && typeof value === "object" ? (value as Record<string, unknown>) : null;

const readString = (
	record: Record<string, unknown> | null,
	key: string,
): string | null => {
	const value = record?.[key];
	return typeof value === "string" && value.length > 0 ? value : null;
};

const readNumber = (
	record: Record<string, unknown> | null,
	key: string,
): number | null => {
	const value = record?.[key];
	return typeof value === "number" ? value : null;
};

const shouldVerifyFromAnalysisResult = (
	result: string | null | undefined,
) =>
	result === "real_vulnerability" || result === "likely_vulnerability";

const readCandidateIdFromTaskInput = (
	task: typeof tasks.$inferSelect,
): string | null => {
	const input = asRecord(task.input);
	const directCandidate = asRecord(input?.candidate);
	if (directCandidate) {
		return readString(directCandidate, "id");
	}
	const analysisResult = asRecord(input?.analysisResult);
	const nestedCandidate = asRecord(analysisResult?.candidate);
	return readString(nestedCandidate, "id");
};

const parseFunctionTaskCandidates = (task: typeof tasks.$inferSelect) => {
	const output = asRecord(task.output);
	const rawCandidates = output?.candidates;
	if (!Array.isArray(rawCandidates)) {
		return [];
	}

	const parsedCandidates: Array<(typeof candidateSchema)["_type"]> = [];
	for (const rawCandidate of rawCandidates) {
		const parsed = candidateSchema.safeParse(rawCandidate);
		if (parsed.success) {
			parsedCandidates.push(parsed.data);
		}
	}
	return parsedCandidates;
};

const maxTimestamp = (...values: Array<string | null | undefined>) =>
	values
		.filter((value): value is string => typeof value === "string" && value.length > 0)
		.sort()
		.at(-1) || new Date(0).toISOString();

const buildDerivedCandidatesFromTasks = (input: {
	functionTasks: typeof tasks.$inferSelect[];
	analysisTasks: typeof tasks.$inferSelect[];
	verificationTasks: typeof tasks.$inferSelect[];
}) => {
	const latestAnalysisTaskByCandidateId = new Map<string, typeof tasks.$inferSelect>();
	for (const task of input.analysisTasks) {
		const candidateId = readCandidateIdFromTaskInput(task);
		if (candidateId && !latestAnalysisTaskByCandidateId.has(candidateId)) {
			latestAnalysisTaskByCandidateId.set(candidateId, task);
		}
	}

	const latestVerificationTaskByCandidateId = new Map<
		string,
		typeof tasks.$inferSelect
	>();
	for (const task of input.verificationTasks) {
		const candidateId = readCandidateIdFromTaskInput(task);
		if (candidateId && !latestVerificationTaskByCandidateId.has(candidateId)) {
			latestVerificationTaskByCandidateId.set(candidateId, task);
		}
	}

	const candidates: DerivedCandidateRecord[] = [];
	for (const functionTask of input.functionTasks) {
		const functionCandidates = parseFunctionTaskCandidates(functionTask);
		for (const candidate of functionCandidates) {
			const analysisTask = latestAnalysisTaskByCandidateId.get(candidate.id);
			const verificationTask = latestVerificationTaskByCandidateId.get(candidate.id);
			const analysisOutput = analysisTask
				? analysisSchema.safeParse(analysisTask.output)
				: null;
			const verificationOutput = verificationTask
				? verificationSchema.safeParse(verificationTask.output)
				: null;

			let status: DerivedCandidateRecord["status"] =
				candidate.status || "pending";
			let currentStage: DerivedCandidateRecord["currentStage"] =
				candidate.currentStage || "analyzing";

			if (verificationTask) {
				status = verificationTask.status;
				currentStage = "verifying";
			} else if (analysisTask) {
				if (
					analysisTask.status === "completed" &&
					analysisOutput?.success &&
					shouldVerifyFromAnalysisResult(analysisOutput.data.result)
				) {
					status = "pending";
					currentStage = "verifying";
				} else {
					status = analysisTask.status;
					currentStage = "analyzing";
				}
			}

			candidates.push({
				vulnerabilityCandidateId: candidate.id,
				scanJobId: functionTask.scanJobId,
				scanFunctionTaskId: functionTask.taskId,
				title: candidate.title,
				description: candidate.description || "",
				filePath: candidate.filePath || null,
				line: candidate.line ?? null,
				vulnerabilityType: candidate.vulnerabilityType || null,
				status,
				currentStage,
				confidence:
					verificationOutput?.success &&
					typeof verificationOutput.data.confidence === "number"
						? verificationOutput.data.confidence
						: analysisOutput?.success &&
							  typeof analysisOutput.data.confidence === "number"
							? analysisOutput.data.confidence
							: candidate.confidence ?? null,
				score:
					verificationOutput?.success &&
					typeof verificationOutput.data.score === "number"
						? verificationOutput.data.score
						: analysisOutput?.success &&
							  typeof analysisOutput.data.score === "number"
							? analysisOutput.data.score
							: candidate.score ?? null,
				createdAt: functionTask.createdAt,
				updatedAt: maxTimestamp(
					functionTask.updatedAt,
					analysisTask?.updatedAt,
					verificationTask?.updatedAt,
				),
			});
		}
	}

	return candidates.sort((left, right) =>
		right.createdAt.localeCompare(left.createdAt),
	);
};

const listDerivedCandidatesByScanJobId = async (
	scanJobId: string,
): Promise<DerivedCandidateRecord[] | null> => {
	const [functionTasks, analysisTasks, verificationTasks] = await Promise.all([
		listTasksByScanJobAndStageRepo({
			scanJobId,
			stageName: "FunctionScanningStage",
		}),
		listTasksByScanJobAndStageRepo({
			scanJobId,
			stageName: "AnalysisStage",
		}),
		listTasksByScanJobAndStageRepo({
			scanJobId,
			stageName: "VerifyingStage",
		}),
	]);

	const hasUnifiedTaskPipeline =
		functionTasks.length > 0 || analysisTasks.length > 0 || verificationTasks.length > 0;
	if (!hasUnifiedTaskPipeline) {
		return null;
	}

	return buildDerivedCandidatesFromTasks({
		functionTasks,
		analysisTasks,
		verificationTasks,
	});
};

const findDerivedCandidateById = async (
	vulnerabilityCandidateId: string,
): Promise<DerivedCandidateRecord | null> => {
	const stageTasks = await db
		.select()
		.from(tasks)
		.where(
			or(
				eq(tasks.stageName, "FunctionScanningStage"),
				eq(tasks.stageName, "AnalysisStage"),
				eq(tasks.stageName, "VerifyingStage"),
			),
		)
		.orderBy(desc(tasks.createdAt));

	const functionTasks = stageTasks.filter(
		(task) => task.stageName === "FunctionScanningStage",
	);
	const analysisTasks = stageTasks.filter((task) => task.stageName === "AnalysisStage");
	const verificationTasks = stageTasks.filter(
		(task) => task.stageName === "VerifyingStage",
	);

	return (
		buildDerivedCandidatesFromTasks({
			functionTasks,
			analysisTasks,
			verificationTasks,
		}).find(
			(candidate) =>
				candidate.vulnerabilityCandidateId === vulnerabilityCandidateId,
		) || null
	);
};

export const findVulnerabilityCandidatesByScanJobIdRepo = async (scanJobId: string) => {
	return (await listDerivedCandidatesByScanJobId(scanJobId)) || [];
};

export const findVulnerabilityCandidateByIdRepo = async (
	vulnerabilityCandidateId: string,
) => {
	const derivedCandidate = await findDerivedCandidateById(vulnerabilityCandidateId);
	if (derivedCandidate) {
		return derivedCandidate;
	}
	throw new TRPCError({
		code: "NOT_FOUND",
		message: "Vulnerability candidate not found",
	});
};
