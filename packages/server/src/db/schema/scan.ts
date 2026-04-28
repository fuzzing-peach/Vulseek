import { relations } from "drizzle-orm";
import {
	boolean,
	integer,
	pgEnum,
	pgTable,
	real,
	text,
	unique,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { z } from "zod";
import { applications } from "./application";
import { compose } from "./compose";

export const scanTypeEnum = pgEnum("scanType", ["delta", "full"]);
export const scanJobStatusEnum = pgEnum("scanJobStatus", [
	"queued",
	"scanning",
	"analyzing",
	"verifying",
	"completed",
	"failed",
]);
export const scanPhaseEnum = pgEnum("scanPhase", [
	"queued",
	"repository_scanning",
	"module_scanning",
	"function_scanning",
	"analyzing",
	"verifying",
	"completed",
	"failed",
]);
export const scanTaskStatusEnum = pgEnum("scanTaskStatus", [
	"queued",
	"running",
	"completed",
	"failed",
]);
export const vulnerabilityCandidateStatusEnum = pgEnum(
	"vulnerabilityCandidateStatus",
	["queued", "running", "completed", "failed"],
);

export const scanJobs = pgTable("scan_jobs", {
	scanJobId: text("scanJobId")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	title: text("title").notNull().default("Scan Job"),
	description: text("description"),
	note: text("note"),
	scanType: scanTypeEnum("scanType").notNull(),
	status: scanJobStatusEnum("status").notNull().default("queued"),
	scanPhase: scanPhaseEnum("scanPhase").notNull().default("queued"),
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

export const scanRepositoryTasks = pgTable(
	"scan_repository_tasks",
	{
		scanRepositoryTaskId: text("scanRepositoryTaskId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		scanJobId: text("scanJobId")
			.notNull()
			.references(() => scanJobs.scanJobId, {
				onDelete: "cascade",
			}),
		status: scanTaskStatusEnum("status").notNull().default("queued"),
		attempt: integer("attempt").notNull().default(0),
		containerName: text("containerName"),
		threadId: text("threadId"),
		result: text("result"),
		repositoryScanMdPath: text("repositoryScanMdPath"),
		repositoryScanJsonPath: text("repositoryScanJsonPath"),
		modulePlanJsonPath: text("modulePlanJsonPath"),
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
		uniqueScanJobRepositoryTask: unique().on(table.scanJobId),
	}),
);

export const scanModuleTasks = pgTable(
	"scan_module_tasks",
	{
		scanModuleTaskId: text("scanModuleTaskId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		scanJobId: text("scanJobId")
			.notNull()
			.references(() => scanJobs.scanJobId, {
				onDelete: "cascade",
			}),
		moduleId: text("moduleId").notNull(),
		moduleName: text("moduleName").notNull(),
		status: scanTaskStatusEnum("status").notNull().default("queued"),
		priority: integer("priority").notNull().default(0),
		attempt: integer("attempt").notNull().default(0),
		containerName: text("containerName"),
		threadId: text("threadId"),
		result: text("result"),
		moduleScanMdPath: text("moduleScanMdPath"),
		moduleScanJsonPath: text("moduleScanJsonPath"),
		functionPlanJsonPath: text("functionPlanJsonPath"),
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
		uniqueScanJobModule: unique().on(table.scanJobId, table.moduleId),
	}),
);

export const scanFunctionTasks = pgTable(
	"scan_function_tasks",
	{
		scanFunctionTaskId: text("scanFunctionTaskId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		scanJobId: text("scanJobId")
			.notNull()
			.references(() => scanJobs.scanJobId, {
				onDelete: "cascade",
			}),
		scanModuleTaskId: text("scanModuleTaskId")
			.notNull()
			.references(() => scanModuleTasks.scanModuleTaskId, {
				onDelete: "cascade",
			}),
		moduleId: text("moduleId").notNull(),
		moduleName: text("moduleName").notNull(),
		functionId: text("functionId").notNull(),
		functionName: text("functionName").notNull(),
		filePath: text("filePath"),
		line: integer("line"),
		status: scanTaskStatusEnum("status").notNull().default("queued"),
		priority: integer("priority").notNull().default(0),
		attempt: integer("attempt").notNull().default(0),
		score: real("score"),
		riskType: text("riskType"),
		summary: text("summary"),
		containerName: text("containerName"),
		threadId: text("threadId"),
		result: text("result"),
		functionScanMdPath: text("functionScanMdPath"),
		functionScanJsonPath: text("functionScanJsonPath"),
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
		uniqueScanJobFunction: unique().on(table.scanJobId, table.functionId),
	}),
);

export const vulnerabilityCandidates = pgTable("vulnerability_candidates", {
	vulnerabilityCandidateId: text("vulnerabilityCandidateId")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	scanJobId: text("scanJobId")
		.notNull()
		.references(() => scanJobs.scanJobId, {
			onDelete: "cascade",
		}),
	scanFunctionTaskId: text("scanFunctionTaskId").references(
		() => scanFunctionTasks.scanFunctionTaskId,
		{
			onDelete: "set null",
		},
	),
	title: text("title").notNull(),
	description: text("description"),
	filePath: text("filePath"),
	line: integer("line"),
	status: vulnerabilityCandidateStatusEnum("status")
		.notNull()
		.default("queued"),
	currentStage: text("currentStage").default("analyzing").notNull(),
	analysisThreadId: text("analysisThreadId"),
	verifierThreadId: text("verifierThreadId"),
	confidence: real("confidence"),
	score: real("score"),
	createdAt: text("createdAt")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
	updatedAt: text("updatedAt")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});

export const candidateAnalysisTasks = pgTable(
	"candidate_analysis_tasks",
	{
		candidateAnalysisTaskId: text("candidateAnalysisTaskId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		scanJobId: text("scanJobId")
			.notNull()
			.references(() => scanJobs.scanJobId, {
				onDelete: "cascade",
			}),
		vulnerabilityCandidateId: text("vulnerabilityCandidateId")
			.notNull()
			.references(() => vulnerabilityCandidates.vulnerabilityCandidateId, {
				onDelete: "cascade",
			}),
		status: scanTaskStatusEnum("status").notNull().default("queued"),
		attempt: integer("attempt").notNull().default(0),
		containerName: text("containerName"),
		threadId: text("threadId"),
		result: text("result"),
		confidence: real("confidence"),
		score: real("score"),
		reportPath: text("reportPath"),
		runtimeSeconds: real("runtimeSeconds"),
		summary: text("summary"),
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
		uniqueCandidateAnalysisTask: unique().on(table.vulnerabilityCandidateId),
	}),
);

export const candidateVerificationTasks = pgTable(
	"candidate_verification_tasks",
	{
		candidateVerificationTaskId: text("candidateVerificationTaskId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		scanJobId: text("scanJobId")
			.notNull()
			.references(() => scanJobs.scanJobId, {
				onDelete: "cascade",
			}),
		vulnerabilityCandidateId: text("vulnerabilityCandidateId")
			.notNull()
			.references(() => vulnerabilityCandidates.vulnerabilityCandidateId, {
				onDelete: "cascade",
			}),
		status: scanTaskStatusEnum("status").notNull().default("queued"),
		attempt: integer("attempt").notNull().default(0),
		containerName: text("containerName"),
		threadId: text("threadId"),
		result: text("result"),
		isBug: boolean("isBug"),
		isSecurity: boolean("isSecurity"),
		confidence: real("confidence"),
		score: real("score"),
		reportPath: text("reportPath"),
		issueDraftPath: text("issueDraftPath"),
		pocPath: text("pocPath"),
		dockerfilePath: text("dockerfilePath"),
		runScriptPath: text("runScriptPath"),
		runtimeSeconds: real("runtimeSeconds"),
		summary: text("summary"),
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
		uniqueCandidateVerificationTask: unique().on(
			table.vulnerabilityCandidateId,
		),
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
	scanRepositoryTasks: many(scanRepositoryTasks),
	vulnerabilityCandidates: many(vulnerabilityCandidates),
	scanModuleTasks: many(scanModuleTasks),
	scanFunctionTasks: many(scanFunctionTasks),
	candidateAnalysisTasks: many(candidateAnalysisTasks),
	candidateVerificationTasks: many(candidateVerificationTasks),
}));

export const scanRepositoryTasksRelations = relations(
	scanRepositoryTasks,
	({ one }) => ({
		scanJob: one(scanJobs, {
			fields: [scanRepositoryTasks.scanJobId],
			references: [scanJobs.scanJobId],
		}),
	}),
);

export const scanModuleTasksRelations = relations(
	scanModuleTasks,
	({ one, many }) => ({
		scanJob: one(scanJobs, {
			fields: [scanModuleTasks.scanJobId],
			references: [scanJobs.scanJobId],
		}),
		scanFunctionTasks: many(scanFunctionTasks),
	}),
);

export const scanFunctionTasksRelations = relations(
	scanFunctionTasks,
	({ one }) => ({
		scanJob: one(scanJobs, {
			fields: [scanFunctionTasks.scanJobId],
			references: [scanJobs.scanJobId],
		}),
		scanModuleTask: one(scanModuleTasks, {
			fields: [scanFunctionTasks.scanModuleTaskId],
			references: [scanModuleTasks.scanModuleTaskId],
		}),
	}),
);

export const vulnerabilityCandidatesRelations = relations(
	vulnerabilityCandidates,
	({ one, many }) => ({
		scanJob: one(scanJobs, {
			fields: [vulnerabilityCandidates.scanJobId],
			references: [scanJobs.scanJobId],
		}),
		candidateAnalysisTasks: many(candidateAnalysisTasks),
		candidateVerificationTasks: many(candidateVerificationTasks),
	}),
);

export const candidateAnalysisTasksRelations = relations(
	candidateAnalysisTasks,
	({ one }) => ({
		scanJob: one(scanJobs, {
			fields: [candidateAnalysisTasks.scanJobId],
			references: [scanJobs.scanJobId],
		}),
		vulnerabilityCandidate: one(vulnerabilityCandidates, {
			fields: [candidateAnalysisTasks.vulnerabilityCandidateId],
			references: [vulnerabilityCandidates.vulnerabilityCandidateId],
		}),
	}),
);

export const candidateVerificationTasksRelations = relations(
	candidateVerificationTasks,
	({ one }) => ({
		scanJob: one(scanJobs, {
			fields: [candidateVerificationTasks.scanJobId],
			references: [scanJobs.scanJobId],
		}),
		vulnerabilityCandidate: one(vulnerabilityCandidates, {
			fields: [candidateVerificationTasks.vulnerabilityCandidateId],
			references: [vulnerabilityCandidates.vulnerabilityCandidateId],
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
