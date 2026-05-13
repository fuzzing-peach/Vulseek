import { relations } from "drizzle-orm";
import {
	AnyPgColumn,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	text,
} from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";
import { nanoid } from "nanoid";
import { z } from "zod";
import { applications } from "./application";
import { compose } from "./compose";

type TaskAgentProfileSnapshot = {
	agentProfileId: string | null;
	name: string | null;
	provider: "codex" | "claude_code" | null;
	baseUrl: string | null;
	model: string | null;
	thinkingLevel: string | null;
};

export const scanTypeEnum = pgEnum("scanType", ["delta", "full"]);
export const scanJobStatusEnum = pgEnum("scanJobStatus", [
	"pending",
	"running",
	"finished",
	"canceled",
]);
export const taskStatusEnum = pgEnum("taskStatus", [
	"pending",
	"launching",
	"running",
	"completed",
	"failed",
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
	commitWindow: integer("commitWindow").notNull().default(3),
	moduleTasksTotal: integer("moduleTasksTotal").notNull().default(0),
	moduleTasksCompleted: integer("moduleTasksCompleted").notNull().default(0),
	moduleTasksFailed: integer("moduleTasksFailed").notNull().default(0),
	functionTasksTotal: integer("functionTasksTotal").notNull().default(0),
	functionTasksCompleted: integer("functionTasksCompleted").notNull().default(0),
	functionTasksFailed: integer("functionTasksFailed").notNull().default(0),
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
		input: jsonb("input").$type<unknown | null>(),
		output: jsonb("output").$type<unknown | null>(),
		rawOutput: text("rawOutput"),
		errorMessage: text("errorMessage"),
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
	}),
);

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
