import { db } from "@vulseek/server/db";
import {
	candidateMetadata,
	candidateTags,
	type taskStatusEnum,
	tasks,
} from "@vulseek/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, or } from "drizzle-orm";
import {
	analysisSchema,
	candidateSchema,
	triageSchema,
	verificationSchema,
} from "../artifacts/contracts/domain-object.contract";
import {
	findTaskByIdRepo,
	listCandidateDescendantTasksByFunctionTaskIdRepo,
	listTasksByScanJobAndStageRepo,
} from "./task.repo";
import {
	readCandidateIdFromTaskInputArtifact,
	readTaskJsonArtifactForTask,
} from "./task-artifact-resolver";

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
	note: string;
	tags: string[];
	createdAt: string;
	updatedAt: string;
};

const CANDIDATE_PRODUCER_STAGE_NAMES = [
	"scan-target",
	"function-scan",
	"sink-pre-analyze",
];

const asRecord = (value: unknown): Record<string, unknown> | null =>
	value && typeof value === "object"
		? (value as Record<string, unknown>)
		: null;

const shouldVerifyFromAnalysisResult = (result: string | null | undefined) =>
	result === "real_vulnerability" || result === "likely_vulnerability";

const parseFunctionTaskCandidates = async (task: typeof tasks.$inferSelect) => {
	const output = asRecord(task.output);
	const rawCandidates = output?.candidates;
	if (!Array.isArray(rawCandidates)) {
		return [];
	}

	const parsedCandidates: Array<(typeof candidateSchema)["_type"]> = [];
	for (const rawCandidate of rawCandidates) {
		const candidate =
			typeof rawCandidate === "string"
				? await readTaskJsonArtifactForTask(task, rawCandidate).catch(
						() => null,
					)
				: rawCandidate;
		const parsed = candidateSchema.safeParse(candidate);
		if (parsed.success) {
			parsedCandidates.push(parsed.data);
		}
	}
	return parsedCandidates;
};

const maxTimestamp = (...values: Array<string | null | undefined>) =>
	values
		.filter(
			(value): value is string => typeof value === "string" && value.length > 0,
		)
		.sort()
		.at(-1) || new Date(0).toISOString();

const normalizeCandidateTags = (tags: string[]) =>
	[
		...new Set(
			tags
				.map((tag) => tag.trim())
				.filter(Boolean)
				.map((tag) => tag.slice(0, 64)),
		),
	].slice(0, 50);

const normalizeCandidateNote = (note: string | null | undefined) =>
	(note || "").slice(0, 10000);

const candidateMetadataKey = (
	scanJobId: string,
	vulnerabilityCandidateId: string,
) => `${scanJobId}\n${vulnerabilityCandidateId}`;

const listCandidateMetadataByIds = async (
	candidates: Array<{ scanJobId: string; vulnerabilityCandidateId: string }>,
) => {
	const ids = [
		...new Set(
			candidates
				.map((candidate) => candidate.vulnerabilityCandidateId)
				.filter(Boolean),
		),
	];
	const scanJobIds = [
		...new Set(
			candidates.map((candidate) => candidate.scanJobId).filter(Boolean),
		),
	];
	if (ids.length === 0) {
		return new Map<string, typeof candidateMetadata.$inferSelect>();
	}

	const rows = await db
		.select()
		.from(candidateMetadata)
		.where(
			and(
				inArray(candidateMetadata.vulnerabilityCandidateId, ids),
				inArray(candidateMetadata.scanJobId, scanJobIds),
			),
		);

	return new Map(
		rows.map((row) => [
			candidateMetadataKey(row.scanJobId, row.vulnerabilityCandidateId),
			row,
		]),
	);
};

const withCandidateMetadata = async <
	TCandidate extends {
		scanJobId: string;
		vulnerabilityCandidateId: string;
		note?: string;
		tags?: string[];
	},
>(
	candidates: TCandidate[],
) => {
	const metadataById = await listCandidateMetadataByIds(candidates);
	return candidates.map((candidate) => {
		const metadata = metadataById.get(
			candidateMetadataKey(
				candidate.scanJobId,
				candidate.vulnerabilityCandidateId,
			),
		);
		return {
			...candidate,
			note: metadata?.note ?? candidate.note ?? "",
			tags: Array.isArray(metadata?.tags)
				? metadata.tags
				: Array.isArray(candidate.tags)
					? candidate.tags
					: [],
		};
	});
};

const buildDerivedCandidatesFromTasks = async (input: {
	functionTasks: (typeof tasks.$inferSelect)[];
	analysisTasks: (typeof tasks.$inferSelect)[];
	verificationTasks: (typeof tasks.$inferSelect)[];
	triageTasks: (typeof tasks.$inferSelect)[];
}) => {
	const latestAnalysisTaskByCandidateId = new Map<
		string,
		typeof tasks.$inferSelect
	>();
	for (const task of input.analysisTasks) {
		const candidateId = await readCandidateIdFromTaskInputArtifact(task);
		if (candidateId && !latestAnalysisTaskByCandidateId.has(candidateId)) {
			latestAnalysisTaskByCandidateId.set(candidateId, task);
		}
	}

	const latestVerificationTaskByCandidateId = new Map<
		string,
		typeof tasks.$inferSelect
	>();
	for (const task of input.verificationTasks) {
		const candidateId = await readCandidateIdFromTaskInputArtifact(task);
		if (candidateId && !latestVerificationTaskByCandidateId.has(candidateId)) {
			latestVerificationTaskByCandidateId.set(candidateId, task);
		}
	}

	const latestTriageTaskByCandidateId = new Map<
		string,
		typeof tasks.$inferSelect
	>();
	for (const task of input.triageTasks) {
		const candidateId = await readCandidateIdFromTaskInputArtifact(task);
		if (candidateId && !latestTriageTaskByCandidateId.has(candidateId)) {
			latestTriageTaskByCandidateId.set(candidateId, task);
		}
	}

	const candidates: DerivedCandidateRecord[] = [];
	for (const functionTask of input.functionTasks) {
		const functionCandidates = await parseFunctionTaskCandidates(functionTask);
		for (const candidate of functionCandidates) {
			const analysisTask = latestAnalysisTaskByCandidateId.get(candidate.id);
			const verificationTask = latestVerificationTaskByCandidateId.get(
				candidate.id,
			);
			const triageTask = latestTriageTaskByCandidateId.get(candidate.id);
			const analysisOutput = analysisTask
				? analysisSchema.safeParse(analysisTask.output)
				: null;
			const verificationOutput = verificationTask
				? verificationSchema.safeParse(verificationTask.output)
				: null;
			const triageOutput = triageTask
				? triageSchema.safeParse(triageTask.output)
				: null;

			let status: DerivedCandidateRecord["status"] =
				candidate.status || "pending";
			let currentStage: DerivedCandidateRecord["currentStage"] =
				candidate.currentStage || "analyzing";

			if (triageTask) {
				status = triageTask.status;
				currentStage = "verifying";
			} else if (verificationTask) {
				status = verificationTask.status;
				currentStage = "verifying";
			} else if (analysisTask) {
				if (
					(analysisTask.status === "completed" ||
						analysisTask.status === "exited") &&
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
							: (candidate.confidence ?? null),
				score:
					triageOutput?.success &&
					typeof triageOutput.data.cvssScore === "number"
						? triageOutput.data.cvssScore
						: verificationOutput?.success &&
							typeof verificationOutput.data.score === "number"
							? verificationOutput.data.score
							: analysisOutput?.success &&
								typeof analysisOutput.data.score === "number"
							? analysisOutput.data.score
							: (candidate.score ?? null),
				note: "",
				tags: [],
				createdAt: functionTask.createdAt,
				updatedAt: maxTimestamp(
					functionTask.updatedAt,
					analysisTask?.updatedAt,
					verificationTask?.updatedAt,
					triageTask?.updatedAt,
				),
			});
		}
	}

	const sorted = candidates.sort((left, right) =>
		right.createdAt.localeCompare(left.createdAt),
	);

	// Deduplicate by vulnerabilityCandidateId: keep the entry with the most
	// recent createdAt (first after sorting above). The same candidate id can
	// appear in multiple function-task outputs when a task is retried.
	const seen = new Set<string>();
	const deduped: DerivedCandidateRecord[] = [];
	for (const candidate of sorted) {
		if (!seen.has(candidate.vulnerabilityCandidateId)) {
			seen.add(candidate.vulnerabilityCandidateId);
			deduped.push(candidate);
		}
	}
	return deduped;
};

const listDerivedCandidatesByScanJobId = async (
	scanJobId: string,
): Promise<DerivedCandidateRecord[] | null> => {
	const [
		scanTargetTasks,
		functionTasks,
		sinkPreAnalyzeTasks,
		analysisTasks,
		legacyAnalysisTasks,
		verificationTasks,
		legacyVerificationTasks,
		triageTasks,
		legacyTriageTasks,
	] = await Promise.all([
			listTasksByScanJobAndStageRepo({
				scanJobId,
				stageName: "scan-target",
			}),
			listTasksByScanJobAndStageRepo({
				scanJobId,
				stageName: "function-scan",
			}),
			listTasksByScanJobAndStageRepo({
				scanJobId,
				stageName: "sink-pre-analyze",
			}),
			listTasksByScanJobAndStageRepo({
				scanJobId,
				stageName: "analyze-finding",
			}),
			listTasksByScanJobAndStageRepo({
				scanJobId,
				stageName: "analyze",
			}),
			listTasksByScanJobAndStageRepo({
				scanJobId,
				stageName: "verify-finding",
			}),
			listTasksByScanJobAndStageRepo({
				scanJobId,
				stageName: "verify",
			}),
			listTasksByScanJobAndStageRepo({
				scanJobId,
				stageName: "triage-finding",
			}),
			listTasksByScanJobAndStageRepo({
				scanJobId,
				stageName: "triage",
			}),
		]);

	const hasUnifiedTaskPipeline =
		scanTargetTasks.length > 0 ||
		functionTasks.length > 0 ||
		sinkPreAnalyzeTasks.length > 0 ||
		analysisTasks.length > 0 ||
		legacyAnalysisTasks.length > 0 ||
		verificationTasks.length > 0 ||
		legacyVerificationTasks.length > 0 ||
		triageTasks.length > 0 ||
		legacyTriageTasks.length > 0;
	if (!hasUnifiedTaskPipeline) {
		return null;
	}

	return buildDerivedCandidatesFromTasks({
		functionTasks: [...scanTargetTasks, ...functionTasks, ...sinkPreAnalyzeTasks],
		analysisTasks: [...analysisTasks, ...legacyAnalysisTasks],
		verificationTasks: [...verificationTasks, ...legacyVerificationTasks],
		triageTasks: [...triageTasks, ...legacyTriageTasks],
	}).then(withCandidateMetadata);
};

const findDerivedCandidateById = async (
	vulnerabilityCandidateId: string,
): Promise<DerivedCandidateRecord | null> => {
	const stageTasks = await db
		.select()
		.from(tasks)
		.where(
			or(
				eq(tasks.stageName, "scan-target"),
				eq(tasks.stageName, "function-scan"),
				eq(tasks.stageName, "sink-pre-analyze"),
				eq(tasks.stageName, "analyze-finding"),
				eq(tasks.stageName, "analyze"),
				eq(tasks.stageName, "verify-finding"),
				eq(tasks.stageName, "verify"),
				eq(tasks.stageName, "triage-finding"),
				eq(tasks.stageName, "triage"),
			),
		)
		.orderBy(desc(tasks.createdAt));

	const functionTasks = stageTasks.filter(
		(task) => CANDIDATE_PRODUCER_STAGE_NAMES.includes(task.stageName),
	);
	const analysisTasks = stageTasks.filter(
		(task) => task.stageName === "analyze" || task.stageName === "analyze-finding",
	);
	const verificationTasks = stageTasks.filter(
		(task) => task.stageName === "verify" || task.stageName === "verify-finding",
	);
	const triageTasks = stageTasks.filter(
		(task) => task.stageName === "triage" || task.stageName === "triage-finding",
	);

	const candidates = await buildDerivedCandidatesFromTasks({
		functionTasks,
		analysisTasks,
		verificationTasks,
		triageTasks,
	}).then(withCandidateMetadata);
	return (
		candidates.find(
			(candidate) =>
				candidate.vulnerabilityCandidateId === vulnerabilityCandidateId,
		) || null
	);
};

export const findVulnerabilityCandidatesByScanJobIdRepo = async (
	scanJobId: string,
) => {
	return (await listDerivedCandidatesByScanJobId(scanJobId)) || [];
};

const findVulnerabilityCandidateByFunctionTaskRepo = async (input: {
	vulnerabilityCandidateId: string;
	scanJobId: string;
	scanFunctionTaskId: string;
}) => {
	const functionTask = await findTaskByIdRepo(input.scanFunctionTaskId).catch(
		() => null,
	);
	if (!functionTask) {
		return null;
	}
	if (
		functionTask.scanJobId !== input.scanJobId ||
		!CANDIDATE_PRODUCER_STAGE_NAMES.includes(functionTask.stageName)
	) {
		return null;
	}

	const candidates = await parseFunctionTaskCandidates(functionTask);
	if (
		!candidates.some(
			(candidate) => candidate.id === input.vulnerabilityCandidateId,
		)
	) {
		return null;
	}

	const candidateTasks = await listCandidateDescendantTasksByFunctionTaskIdRepo({
		scanFunctionTaskId: functionTask.taskId,
		vulnerabilityCandidateId: input.vulnerabilityCandidateId,
	});
	const derivedCandidates = await buildDerivedCandidatesFromTasks({
		functionTasks: [functionTask],
		analysisTasks: candidateTasks.filter(
			(task) => task.stageName === "analyze" || task.stageName === "analyze-finding",
		),
		verificationTasks: candidateTasks.filter(
			(task) => task.stageName === "verify" || task.stageName === "verify-finding",
		),
		triageTasks: candidateTasks.filter(
			(task) => task.stageName === "triage" || task.stageName === "triage-finding",
		),
	}).then(withCandidateMetadata);

	return (
		derivedCandidates.find(
			(candidate) =>
				candidate.vulnerabilityCandidateId === input.vulnerabilityCandidateId,
		) || null
	);
};

export const findVulnerabilityCandidateByIdAndScanJobIdRepo = async (input: {
	vulnerabilityCandidateId: string;
	scanJobId: string;
	scanFunctionTaskId?: string;
}) => {
	if (input.scanFunctionTaskId) {
		const derivedCandidate = await findVulnerabilityCandidateByFunctionTaskRepo({
			vulnerabilityCandidateId: input.vulnerabilityCandidateId,
			scanJobId: input.scanJobId,
			scanFunctionTaskId: input.scanFunctionTaskId,
		});
		if (derivedCandidate) {
			return derivedCandidate;
		}
	}

	const functionTasks = (
		await Promise.all(
			CANDIDATE_PRODUCER_STAGE_NAMES.map((stageName) =>
				listTasksByScanJobAndStageRepo({
					scanJobId: input.scanJobId,
					stageName,
				}),
			),
		)
	).flat();

	for (const functionTask of functionTasks) {
		const candidates = await parseFunctionTaskCandidates(functionTask);
		if (
			!candidates.some(
				(candidate) => candidate.id === input.vulnerabilityCandidateId,
			)
		) {
			continue;
		}

		const candidateTasks =
			await listCandidateDescendantTasksByFunctionTaskIdRepo({
				scanFunctionTaskId: functionTask.taskId,
				vulnerabilityCandidateId: input.vulnerabilityCandidateId,
			});
		const derivedCandidates = await buildDerivedCandidatesFromTasks({
			functionTasks: [functionTask],
			analysisTasks: candidateTasks.filter(
				(task) =>
					task.stageName === "analyze" ||
					task.stageName === "analyze-finding",
			),
			verificationTasks: candidateTasks.filter(
				(task) =>
					task.stageName === "verify" || task.stageName === "verify-finding",
			),
			triageTasks: candidateTasks.filter(
				(task) =>
					task.stageName === "triage" || task.stageName === "triage-finding",
			),
		}).then(withCandidateMetadata);
		const derivedCandidate = derivedCandidates.find(
			(candidate) =>
				candidate.vulnerabilityCandidateId === input.vulnerabilityCandidateId,
		);
		if (derivedCandidate) {
			return derivedCandidate;
		}
	}

	const derivedCandidate = (
		await listDerivedCandidatesByScanJobId(input.scanJobId)
	)?.find(
		(candidate) =>
			candidate.vulnerabilityCandidateId === input.vulnerabilityCandidateId,
	);
	if (derivedCandidate) {
		return derivedCandidate;
	}

	throw new TRPCError({
		code: "NOT_FOUND",
		message: "Vulnerability candidate not found",
	});
};

export const listCandidateTagsRepo = async () =>
	await db
		.select({
			name: candidateTags.name,
		})
		.from(candidateTags)
		.orderBy(asc(candidateTags.name))
		.then((rows) => rows.map((row) => row.name));

export const updateVulnerabilityCandidateMetadataRepo = async (input: {
	vulnerabilityCandidateId: string;
	scanJobId: string;
	note: string;
	tags: string[];
}) => {
	const now = new Date().toISOString();
	const note = normalizeCandidateNote(input.note);
	const tags = normalizeCandidateTags(input.tags);
	await Promise.all(
		tags.map((name) =>
			db
				.insert(candidateTags)
				.values({
					name,
					createdAt: now,
					updatedAt: now,
				})
				.onConflictDoUpdate({
					target: candidateTags.name,
					set: {
						updatedAt: now,
					},
				}),
		),
	);

	const [metadata] = await db
		.insert(candidateMetadata)
		.values({
			vulnerabilityCandidateId: input.vulnerabilityCandidateId,
			scanJobId: input.scanJobId,
			note,
			tags,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: [
				candidateMetadata.scanJobId,
				candidateMetadata.vulnerabilityCandidateId,
			],
			set: {
				note,
				tags,
				updatedAt: now,
			},
		})
		.returning();

	return {
		note: metadata?.note ?? note,
		tags: metadata?.tags ?? tags,
	};
};

export const findVulnerabilityCandidateByIdRepo = async (
	vulnerabilityCandidateId: string,
) => {
	const derivedCandidate = await findDerivedCandidateById(
		vulnerabilityCandidateId,
	);
	if (derivedCandidate) {
		return derivedCandidate;
	}
	throw new TRPCError({
		code: "NOT_FOUND",
		message: "Vulnerability candidate not found",
	});
};
