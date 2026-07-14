import { relations } from "drizzle-orm";
import {
	type AnyPgColumn,
	bigint,
	boolean,
	foreignKey,
	index,
	integer,
	jsonb,
	primaryKey,
	pgEnum,
	pgTable,
	real,
	text,
} from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";
import { nanoid } from "nanoid";
import { z } from "zod";
import { applications } from "./application";
import { compose } from "./compose";
import {
	buildDefaultEvaluateConfig,
	type EvaluateConfig,
	type ScanRuntimeSettings,
	ScanRuntimeSettingsSchema,
} from "./shared";

export type TaskAgentProfileSnapshot = {
	agentProfileId: string | null;
	name: string | null;
	provider: "codex" | "claude_code" | null;
	authMode: "api_key" | "host_home" | null;
	homePath: string | null;
	baseUrl: string | null;
	model: string | null;
	pricingProvider: string | null;
	thinkingLevel: string | null;
	thinkingLevelEnabled?: boolean | null;
};

export const scanTypeEnum = pgEnum("scanType", ["delta", "full"]);
export const scanJobStatusEnum = pgEnum("scanJobStatus", [
	"pending",
	"running",
	"paused",
	"finished",
	"failed",
	"canceled",
]);
export const scanEvaluateStatusEnum = pgEnum("scanEvaluateStatus", [
	"pending",
	"running",
	"completed",
	"failed",
]);
export const taskStatusEnum = pgEnum("taskStatus", [
	"pending",
	"launching",
	"launched",
	"starting",
	"running",
	"completed",
	"failed",
	"exited",
	"canceled",
]);

export const scanJobs = pgTable("scan_jobs", {
	scanJobId: text("scanJobId")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	title: text("title").notNull().default("Scan Job"),
	description: text("description"),
	note: text("note"),
	scanType: scanTypeEnum("scanType").notNull(),
	status: scanJobStatusEnum("status").notNull().default("pending"),
	triggerSource: text("triggerSource").notNull().default("manual"),
	commitSha: text("commitSha"),
	baseSha: text("baseSha"),
	targetRef: text("targetRef"),
	targetTag: text("targetTag"),
	scanRuntimeSettings: jsonb("scanRuntimeSettings")
		.$type<ScanRuntimeSettings>()
		.notNull()
		.default({}),
	scanPipelineDefinitionSnapshot: jsonb("scanPipelineDefinitionSnapshot")
		.$type<Record<string, unknown>>()
		.notNull()
		.default({}),
	commitWindow: integer("commitWindow").notNull().default(3),
	moduleTasksTotal: integer("moduleTasksTotal").notNull().default(0),
	moduleTasksCompleted: integer("moduleTasksCompleted").notNull().default(0),
	moduleTasksFailed: integer("moduleTasksFailed").notNull().default(0),
	functionTasksTotal: integer("functionTasksTotal").notNull().default(0),
	functionTasksCompleted: integer("functionTasksCompleted").notNull().default(0),
	functionTasksFailed: integer("functionTasksFailed").notNull().default(0),
	inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
	outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
	thoughtTokens: bigint("thought_tokens", { mode: "number" }).notNull().default(0),
	totalTokens: bigint("total_tokens", { mode: "number" }).notNull().default(0),
	cachedReadTokens: bigint("cached_read_tokens", { mode: "number" }).notNull().default(0),
	cachedWriteTokens: bigint("cached_write_tokens", { mode: "number" }).notNull().default(0),
	applicationId: text("applicationId").references(
		() => applications.applicationId,
		{
			onDelete: "cascade",
		},
	),
	composeId: text("composeId").references(() => compose.composeId, {
		onDelete: "cascade",
	}),
	createdAt: text("createdAt")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
	startedAt: text("startedAt"),
	finishedAt: text("finishedAt"),
	errorMessage: text("errorMessage"),
	scanningThreadId: text("scanningThreadId"),
});

export const tasks = pgTable(
	"tasks",
	{
		taskId: text("taskId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => randomUUID().replace(/-/g, "").slice(0, 8)),
		scanJobId: text("scanJobId")
			.notNull()
			.references(() => scanJobs.scanJobId, {
				onDelete: "cascade",
			}),
		vulnerabilityCandidateId: text("vulnerabilityCandidateId"),
		parentTaskId: text("parentTaskId").references(
			(): AnyPgColumn => tasks.taskId,
			{
				onDelete: "set null",
			},
		),
		name: text("name").notNull(),
		stageName: text("stageName").notNull(),
		status: taskStatusEnum("status").notNull().default("pending"),
		priority: integer("priority"),
		attempt: integer("attempt").notNull().default(0),
		agentProfile: jsonb("agentProfile").$type<TaskAgentProfileSnapshot | null>(),
		containerName: text("containerName"),
		containerIndex: integer("containerIndex"),
		threadId: text("threadId"),
		runtimeMode: text("runtimeMode").$type<
			"new_session" | "fork_session" | null
		>(),
		forkedFromTaskId: text("forkedFromTaskId").references(
			(): AnyPgColumn => tasks.taskId,
			{
				onDelete: "set null",
			},
		),
		forkedFromThreadId: text("forkedFromThreadId"),
			stageGroupInstanceId: text("stageGroupInstanceId"),
			input: jsonb("input").$type<unknown | null>(),
			output: jsonb("output").$type<unknown | null>(),
			inputTokens: bigint("input_tokens", { mode: "number" }),
			outputTokens: bigint("output_tokens", { mode: "number" }),
			thoughtTokens: bigint("thought_tokens", { mode: "number" }),
			totalTokens: bigint("total_tokens", { mode: "number" }),
			cachedReadTokens: bigint("cached_read_tokens", { mode: "number" }),
			cachedWriteTokens: bigint("cached_write_tokens", { mode: "number" }),
			errorMessage: text("errorMessage"),
		exitReason: text("exitReason").$type<
			"agent_exit" | "leader_exit" | null
		>(),
		exitNote: text("exitNote"),
		startedAt: text("startedAt"),
		completedAt: text("completedAt"),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		updatedAt: text("updatedAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(table) => ({
		scanJobIdx: index("tasks_scan_job_idx").on(table.scanJobId),
		scanJobCandidateIdx: index("tasks_scan_job_candidate_idx").on(
			table.scanJobId,
			table.vulnerabilityCandidateId,
			table.stageName,
			table.createdAt,
		),
		parentTaskIdx: index("tasks_parent_task_idx").on(table.parentTaskId),
		forkedFromTaskIdx: index("tasks_forked_from_task_idx").on(
			table.forkedFromTaskId,
		),
		forkedFromThreadIdx: index("tasks_forked_from_thread_idx").on(
			table.forkedFromThreadId,
		),
		scanJobStatusIdx: index("tasks_scan_job_status_idx").on(
			table.scanJobId,
			table.status,
		),
		scanJobCreatedAtIdx: index("tasks_scan_job_created_at_idx").on(
			table.scanJobId,
			table.createdAt,
		),
		stageStatusIdx: index("tasks_stage_status_idx").on(
			table.stageName,
			table.status,
		),
		threadIdx: index("tasks_thread_idx").on(table.threadId),
		containerIdx: index("tasks_container_idx").on(table.containerName),
		containerIndexIdx: index("tasks_container_index_idx").on(
			table.scanJobId,
			table.stageName,
			table.containerIndex,
		),
	}),
);

export const scanStageLaneRuntimes = pgTable(
	"scan_stage_lane_runtimes",
	{
		scanJobId: text("scanJobId")
			.notNull()
			.references(() => scanJobs.scanJobId, {
				onDelete: "cascade",
			}),
		stageName: text("stageName").notNull(),
		laneIndex: integer("laneIndex").notNull(),
		containerName: text("containerName"),
		threadId: text("threadId"),
		activeTaskId: text("activeTaskId").references(() => tasks.taskId, {
			onDelete: "set null",
		}),
		forkedFromTaskId: text("forkedFromTaskId").references(
			(): AnyPgColumn => tasks.taskId,
			{
				onDelete: "set null",
			},
		),
		forkedFromThreadId: text("forkedFromThreadId"),
		status: text("status")
			.$type<"idle" | "active" | "exiting">()
			.notNull()
			.default("idle"),
		lastExitTaskId: text("lastExitTaskId"),
		lastExitAt: text("lastExitAt"),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		updatedAt: text("updatedAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(table) => ({
		pk: primaryKey({
			columns: [table.scanJobId, table.stageName, table.laneIndex],
		}),
		scanJobStageIdx: index("scan_stage_lane_scan_job_stage_idx").on(
			table.scanJobId,
			table.stageName,
		),
		activeTaskIdx: index("scan_stage_lane_active_task_idx").on(
			table.activeTaskId,
		),
		containerIdx: index("scan_stage_lane_container_idx").on(
			table.containerName,
		),
	}),
);

export const scanStageGroupInstances = pgTable(
	"scan_stage_group_instances",
	{
		groupInstanceId: text("groupInstanceId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		scanJobId: text("scanJobId")
			.notNull()
			.references(() => scanJobs.scanJobId, {
				onDelete: "cascade",
			}),
		groupName: text("groupName").notNull(),
		leaderStageName: text("leaderStageName").notNull(),
		leaderLaneIndex: integer("leaderLaneIndex").notNull(),
		leaderTaskId: text("leaderTaskId").references(() => tasks.taskId, {
			onDelete: "set null",
		}),
		status: text("status")
			.$type<"active" | "exited">()
			.notNull()
			.default("active"),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		updatedAt: text("updatedAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(table) => ({
		scanJobGroupIdx: index("scan_stage_group_instance_scan_job_group_idx").on(
			table.scanJobId,
			table.groupName,
		),
		leaderIdx: index("scan_stage_group_instance_leader_idx").on(
			table.scanJobId,
			table.leaderStageName,
			table.leaderLaneIndex,
		),
	}),
);

export const scanStageGroupLaneMemberships = pgTable(
	"scan_stage_group_lane_memberships",
	{
		groupInstanceId: text("groupInstanceId")
			.notNull()
			.references(() => scanStageGroupInstances.groupInstanceId, {
				onDelete: "cascade",
			}),
		stageName: text("stageName").notNull(),
		laneIndex: integer("laneIndex").notNull(),
		role: text("role").$type<"leader" | "member">().notNull(),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		updatedAt: text("updatedAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(table) => ({
		pk: primaryKey({
			columns: [table.groupInstanceId, table.stageName],
		}),
		groupIdx: index("scan_stage_group_lane_membership_group_idx").on(
			table.groupInstanceId,
		),
		stageLaneIdx: index("scan_stage_group_lane_membership_stage_lane_idx").on(
			table.stageName,
			table.laneIndex,
		),
	}),
);

export const candidateMetadata = pgTable(
	"candidate_metadata",
	{
		vulnerabilityCandidateId: text("vulnerabilityCandidateId")
			.notNull(),
		scanJobId: text("scanJobId")
			.notNull()
			.references(() => scanJobs.scanJobId, {
				onDelete: "cascade",
			}),
		note: text("note").notNull().default(""),
		tags: jsonb("tags").$type<string[]>().notNull().default([]),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		updatedAt: text("updatedAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(table) => ({
		pk: primaryKey({
			columns: [table.scanJobId, table.vulnerabilityCandidateId],
		}),
		scanJobIdx: index("candidate_metadata_scan_job_idx").on(table.scanJobId),
	}),
);

export const vulnerabilityCandidates = pgTable(
	"vulnerability_candidates",
	{
		vulnerabilityCandidateId: text("vulnerabilityCandidateId").notNull(),
		scanJobId: text("scanJobId")
			.notNull()
			.references(() => scanJobs.scanJobId, {
				onDelete: "cascade",
			}),
		producerTaskId: text("producerTaskId")
			.notNull()
			.references(() => tasks.taskId, {
				onDelete: "cascade",
			}),
		producerStageName: text("producerStageName").notNull(),
		functionId: text("functionId"),
		title: text("title").notNull(),
		description: text("description"),
		filePath: text("filePath"),
		line: integer("line"),
		vulnerabilityType: text("vulnerabilityType"),
		confidence: real("confidence"),
		score: real("score"),
		targetId: text("targetId"),
		targetKind: text("targetKind"),
		claim: text("claim").notNull(),
		rootCauseKey: text("rootCauseKey"),
		evidence: jsonb("evidence").$type<unknown[]>().notNull().default([]),
		attackerControl: text("attackerControl"),
		affectedSink: text("affectedSink"),
		preconditions: jsonb("preconditions").$type<string[]>().notNull().default([]),
		quickDisproofAttempt: text("quickDisproofAttempt"),
		needsFuzzing: boolean("needsFuzzing").notNull().default(false),
		needsManualAnalysis: boolean("needsManualAnalysis").notNull().default(false),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		updatedAt: text("updatedAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(table) => ({
		pk: primaryKey({
			columns: [table.scanJobId, table.vulnerabilityCandidateId],
		}),
		scanJobIdx: index("vulnerability_candidates_scan_job_idx").on(
			table.scanJobId,
		),
		producerTaskIdx: index("vulnerability_candidates_producer_task_idx").on(
			table.producerTaskId,
		),
		producerStageIdx: index("vulnerability_candidates_producer_stage_idx").on(
			table.producerStageName,
		),
		createdAtIdx: index("vulnerability_candidates_created_at_idx").on(
			table.createdAt,
		),
	}),
);

export const candidateResultProjections = pgTable(
	"candidate_result_projections",
	{
		scanJobId: text("scanJobId")
			.notNull()
			.references(() => scanJobs.scanJobId, { onDelete: "cascade" }),
		vulnerabilityCandidateId: text("vulnerabilityCandidateId").notNull(),
		analysisTaskId: text("analysisTaskId"),
		analysisOutput: jsonb("analysisOutput").$type<unknown | null>(),
		analysisResult: text("analysisResult"),
		analysisRank: integer("analysisRank"),
		analysisResultAt: text("analysisResultAt"),
		verificationTaskId: text("verificationTaskId"),
		verificationOutput: jsonb("verificationOutput").$type<unknown | null>(),
		verificationResult: text("verificationResult"),
		verificationRank: integer("verificationRank"),
		verificationResultAt: text("verificationResultAt"),
		triageTaskId: text("triageTaskId"),
		triageOutput: jsonb("triageOutput").$type<unknown | null>(),
		triageResult: text("triageResult"),
		triageRank: integer("triageRank"),
		triageResultAt: text("triageResultAt"),
		latestResultAt: text("latestResultAt"),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		updatedAt: text("updatedAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(table) => ({
		pk: primaryKey({
			columns: [table.scanJobId, table.vulnerabilityCandidateId],
		}),
		candidateFk: foreignKey({
			columns: [table.scanJobId, table.vulnerabilityCandidateId],
			foreignColumns: [
				vulnerabilityCandidates.scanJobId,
				vulnerabilityCandidates.vulnerabilityCandidateId,
			],
				name: "candidate_result_projection_candidate_fk",
		}),
		scanJobIdx: index("candidate_result_projection_scan_job_idx").on(
			table.scanJobId,
		),
		analysisResultIdx: index("candidate_result_projection_analysis_idx").on(
			table.scanJobId,
			table.analysisResult,
		),
		verificationResultIdx: index(
			"candidate_result_projection_verification_idx",
		).on(table.scanJobId, table.verificationResult),
		triageResultIdx: index("candidate_result_projection_triage_idx").on(
			table.scanJobId,
			table.triageResult,
		),
		latestResultIdx: index("candidate_result_projection_latest_idx").on(
			table.scanJobId,
			table.latestResultAt,
		),
	}),
);

export const candidateResultProjectionBackfills = pgTable(
	"candidate_result_projection_backfills",
	{
		backfillId: text("backfillId").primaryKey(),
		status: text("status")
			.$type<"pending" | "running" | "completed">()
			.notNull()
			.default("pending"),
		processedCount: integer("processedCount").notNull().default(0),
		skippedCount: integer("skippedCount").notNull().default(0),
		skippedTasks: jsonb("skippedTasks")
			.$type<Array<Record<string, string>>>()
			.notNull()
			.default([]),
		errorMessage: text("errorMessage"),
		startedAt: text("startedAt"),
		completedAt: text("completedAt"),
		updatedAt: text("updatedAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
);

export const scanEvaluateResults = pgTable(
	"scan_evaluate_results",
	{
		evaluateResultId: text("evaluateResultId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		scanJobId: text("scanJobId")
			.notNull()
			.references(() => scanJobs.scanJobId, {
				onDelete: "cascade",
			}),
		applicationId: text("applicationId")
			.notNull()
			.references(() => applications.applicationId, {
				onDelete: "cascade",
			}),
		status: scanEvaluateStatusEnum("status").notNull().default("pending"),
		configSnapshot: jsonb("configSnapshot")
			.$type<EvaluateConfig>()
			.notNull()
			.default(buildDefaultEvaluateConfig()),
		realVulnCsvPath: text("realVulnCsvPath"),
		result: jsonb("result").$type<Record<string, unknown> | null>(),
		errorMessage: text("errorMessage"),
		startedAt: text("startedAt"),
		finishedAt: text("finishedAt"),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		updatedAt: text("updatedAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(table) => ({
		scanJobIdx: index("scan_evaluate_results_scan_job_idx").on(
			table.scanJobId,
		),
		applicationIdx: index("scan_evaluate_results_application_idx").on(
			table.applicationId,
		),
		scanJobCreatedAtIdx: index("scan_evaluate_results_scan_job_created_idx").on(
			table.scanJobId,
			table.createdAt,
		),
	}),
);

export const candidateTags = pgTable("candidate_tags", {
	name: text("name").notNull().primaryKey(),
	createdAt: text("createdAt")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
	updatedAt: text("updatedAt")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});

export const scanJobsRelations = relations(scanJobs, ({ one, many }) => ({
	application: one(applications, {
		fields: [scanJobs.applicationId],
		references: [applications.applicationId],
	}),
	compose: one(compose, {
		fields: [scanJobs.composeId],
		references: [compose.composeId],
	}),
	tasks: many(tasks),
	candidateMetadata: many(candidateMetadata),
	vulnerabilityCandidates: many(vulnerabilityCandidates),
	evaluateResults: many(scanEvaluateResults),
}));

export const tasksRelations = relations(tasks, ({ one, many }) => ({
	scanJob: one(scanJobs, {
		fields: [tasks.scanJobId],
		references: [scanJobs.scanJobId],
	}),
	parentTask: one(tasks, {
		fields: [tasks.parentTaskId],
		references: [tasks.taskId],
		relationName: "task_parent",
	}),
	childTasks: many(tasks, {
		relationName: "task_parent",
	}),
}));

export const candidateMetadataRelations = relations(
	candidateMetadata,
	({ one }) => ({
		scanJob: one(scanJobs, {
			fields: [candidateMetadata.scanJobId],
			references: [scanJobs.scanJobId],
		}),
	}),
);

export const vulnerabilityCandidatesRelations = relations(
	vulnerabilityCandidates,
	({ one }) => ({
		scanJob: one(scanJobs, {
			fields: [vulnerabilityCandidates.scanJobId],
			references: [scanJobs.scanJobId],
		}),
		producerTask: one(tasks, {
			fields: [vulnerabilityCandidates.producerTaskId],
			references: [tasks.taskId],
		}),
	}),
);

export const scanEvaluateResultsRelations = relations(
	scanEvaluateResults,
	({ one }) => ({
		scanJob: one(scanJobs, {
			fields: [scanEvaluateResults.scanJobId],
			references: [scanJobs.scanJobId],
		}),
		application: one(applications, {
			fields: [scanEvaluateResults.applicationId],
			references: [applications.applicationId],
		}),
	}),
);

export const apiCreateScanJob = z
	.object({
		applicationId: z.string().min(1).optional(),
		composeId: z.string().min(1).optional(),
		scanType: z.enum(["delta", "full"]),
		title: z.string().min(1).optional(),
		description: z.string().optional(),
		triggerSource: z.enum(["manual", "webhook", "schedule"]).default("manual"),
		commitSha: z.string().optional(),
		baseSha: z.string().optional(),
		targetRef: z.string().optional(),
		targetTag: z.string().optional(),
		commitWindow: z.number().int().min(1).max(50).optional(),
		scanRuntimeSettings: ScanRuntimeSettingsSchema.optional(),
	})
	.refine((value) => Boolean(value.applicationId) !== Boolean(value.composeId), {
		message: "Provide exactly one target: applicationId or composeId",
		path: ["applicationId"],
	});

export const apiFindScanJobsByApplication = z
	.object({
		applicationId: z.string().min(1),
	})
	.required();

export const apiFindScanJobsByCompose = z
	.object({
		composeId: z.string().min(1),
	})
	.required();

export const apiFindOneScanJob = z
	.object({
		scanJobId: z.string().min(1),
	})
	.required();

export const apiUpdateScanJobNote = z
	.object({
		scanJobId: z.string().min(1),
		note: z.string().max(4000).nullable(),
	})
	.required();

export const apiFindVulnerabilityCandidatesByScanJob = z
	.object({
		scanJobId: z.string().min(1),
	})
	.required();

export const apiCheckoutScanEnvironment = z
	.object({
		applicationId: z.string().min(1).optional(),
		composeId: z.string().min(1).optional(),
	})
	.refine((value) => Boolean(value.applicationId) !== Boolean(value.composeId), {
		message: "Provide exactly one target: applicationId or composeId",
		path: ["applicationId"],
	});

export const apiFindCheckoutStatus = z
	.object({
		checkoutId: z.string().min(1),
	})
	.required();

export const apiFindRunningCheckout = z
	.object({
		applicationId: z.string().min(1).optional(),
		composeId: z.string().min(1).optional(),
	})
	.refine((value) => Boolean(value.applicationId) !== Boolean(value.composeId), {
		message: "Provide exactly one target: applicationId or composeId",
		path: ["applicationId"],
	});
