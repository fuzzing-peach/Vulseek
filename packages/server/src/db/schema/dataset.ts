import {
	bigint,
	index,
	integer,
	jsonb,
	pgTable,
	real,
	text,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { organization } from "./account";

const timestamp = () => new Date().toISOString();

export type DatasetHook =
	| { type: "none" }
	| {
			type: "script";
			command: string;
			timeoutSeconds?: number;
	  }
	| {
			type: "prompt";
			prompt: string;
			agentProfileId: string;
			timeoutSeconds?: number;
	  };

export type DatasetSource =
	| {
			type: "git";
			url: string;
			ref?: string | null;
			sshKeyId?: string | null;
			submodules?: boolean;
	  }
	| { type: "local"; path: string };

export type DatasetManifest = {
	version: 1;
	samples: Array<{
		sampleKey: string;
		title?: string;
		repositoryPath: string;
		scannerInput?: Record<string, unknown>;
		evaluatorMetadata?: Record<string, unknown>;
	}>;
};

export const datasetSourceSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("git"),
		url: z.string().trim().min(1).refine((value) => /^(https?:\/\/|ssh:\/\/|git@)/.test(value), "Git source URL must use https, ssh, or git@ syntax"),
		ref: z.string().trim().min(1).optional().nullable(),
		sshKeyId: z.string().min(1).optional().nullable(),
		submodules: z.boolean().default(false),
	}),
	z.object({
		type: z.literal("local"),
		path: z.string().trim().min(1),
	}),
]);

export const datasetHookSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("none") }),
	z.object({
		type: z.literal("script"),
		command: z.string().trim().min(1),
		timeoutSeconds: z.number().int().min(1).max(86_400).optional(),
	}),
	z.object({
		type: z.literal("prompt"),
		prompt: z.string().trim().min(1),
		agentProfileId: z.string().min(1),
		timeoutSeconds: z.number().int().min(1).max(86_400).optional(),
	}),
]);

export const datasets = pgTable(
	"datasets",
	{
		datasetId: text("datasetId").primaryKey().$defaultFn(() => nanoid()),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		description: text("description").notNull().default(""),
		source: jsonb("source").$type<DatasetSource>().notNull(),
		postCheckoutHook: jsonb("postCheckoutHook")
			.$type<DatasetHook>()
			.notNull()
			.default({ type: "none" }),
		postCheckoutSchema: jsonb("postCheckoutSchema")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		postScanHook: jsonb("postScanHook")
			.$type<DatasetHook>()
			.notNull()
			.default({ type: "none" }),
		postEvaluationHook: jsonb("postEvaluationHook")
			.$type<DatasetHook>()
			.notNull()
			.default({ type: "none" }),
		postScanSchema: jsonb("postScanSchema")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		postEvaluationSchema: jsonb("postEvaluationSchema")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		createdAt: text("createdAt").notNull().$defaultFn(timestamp),
		updatedAt: text("updatedAt").notNull().$defaultFn(timestamp),
	},
	(table) => ({
		organizationIdx: index("datasets_organization_idx").on(table.organizationId),
		organizationNameUnique: uniqueIndex("datasets_organization_name_unique").on(
			table.organizationId,
			table.name,
		),
	}),
);

export const datasetProfiles = pgTable(
	"dataset_profiles",
	{
		profileId: text("profileId").primaryKey().$defaultFn(() => nanoid()),
		datasetId: text("datasetId")
			.notNull()
			.references(() => datasets.datasetId, { onDelete: "cascade" }),
			profileKey: text("profileKey").notNull(),
		status: text("status")
			.$type<"preparing" | "ready" | "failed">()
			.notNull()
			.default("preparing"),
		hostRoot: text("hostRoot").notNull(),
		sourceDigest: text("sourceDigest"),
		checkoutImage: text("checkoutImage"),
		checkoutImageDigest: text("checkoutImageDigest"),
		configSnapshot: jsonb("configSnapshot")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		postCheckoutStatus: text("postCheckoutStatus")
			.$type<"pending" | "running" | "completed" | "failed" | "skipped">()
			.notNull()
			.default("pending"),
		postCheckoutLog: text("postCheckoutLog"),
		postCheckoutResult: jsonb("postCheckoutResult").$type<unknown | null>(),
		errorMessage: text("errorMessage"),
		createdAt: text("createdAt").notNull().$defaultFn(timestamp),
		updatedAt: text("updatedAt").notNull().$defaultFn(timestamp),
	},
	(table) => ({
		datasetIdx: index("dataset_profiles_dataset_idx").on(table.datasetId, table.createdAt),
		datasetKeyUnique: uniqueIndex("dataset_profiles_dataset_key_unique").on(
			table.datasetId,
			table.profileKey,
		),
		statusIdx: index("dataset_profiles_status_idx").on(table.status),
	}),
);

export const datasetSamples = pgTable(
	"dataset_samples",
	{
		sampleId: text("sampleId").primaryKey().$defaultFn(() => nanoid()),
		profileId: text("profileId")
			.notNull()
			.references(() => datasetProfiles.profileId, { onDelete: "cascade" }),
		sampleKey: text("sampleKey").notNull(),
		title: text("title").notNull().default(""),
		repositoryPath: text("repositoryPath").notNull(),
		scannerInput: jsonb("scannerInput")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		evaluatorMetadata: jsonb("evaluatorMetadata")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		ordinal: integer("ordinal").notNull().default(0),
		createdAt: text("createdAt").notNull().$defaultFn(timestamp),
		updatedAt: text("updatedAt").notNull().$defaultFn(timestamp),
	},
	(table) => ({
		profileIdx: index("dataset_samples_profile_idx").on(table.profileId, table.ordinal),
		profileSampleKeyUnique: uniqueIndex("dataset_samples_profile_sample_key_unique").on(
			table.profileId,
			table.sampleKey,
		),
	}),
);

export const datasetEvaluations = pgTable(
	"dataset_evaluations",
	{
		evaluationId: text("evaluationId").primaryKey().$defaultFn(() => nanoid()),
		datasetId: text("datasetId")
			.notNull()
			.references(() => datasets.datasetId, { onDelete: "cascade" }),
		profileId: text("profileId")
			.notNull()
			.references(() => datasetProfiles.profileId, { onDelete: "restrict" }),
		name: text("name").notNull(),
		pipelineId: text("pipelineId").notNull(),
		sampleKeys: jsonb("sampleKeys").$type<string[]>().notNull().default([]),
		repetitions: integer("repetitions").notNull().default(1),
		timeBudgetSeconds: integer("timeBudgetSeconds"),
		scanRuntimeSettings: jsonb("scanRuntimeSettings")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		scanPipelineDefinitionSnapshot: jsonb("scanPipelineDefinitionSnapshot")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		postEvaluationStatus: text("postEvaluationStatus")
			.$type<"pending" | "running" | "completed" | "failed" | "skipped">()
			.notNull()
			.default("pending"),
		postEvaluationResult: jsonb("postEvaluationResult").$type<unknown | null>(),
		status: text("status")
			.$type<
				| "pending"
				| "running"
				| "paused"
				| "finalizing"
				| "completed"
				| "completed_with_errors"
				| "failed"
				| "canceled"
			>()
			.notNull()
			.default("pending"),
		errorMessage: text("errorMessage"),
		startedAt: text("startedAt"),
		finishedAt: text("finishedAt"),
		createdAt: text("createdAt").notNull().$defaultFn(timestamp),
		updatedAt: text("updatedAt").notNull().$defaultFn(timestamp),
	},
	(table) => ({
		datasetIdx: index("dataset_evaluations_dataset_idx").on(table.datasetId, table.createdAt),
		profileIdx: index("dataset_evaluations_profile_idx").on(table.profileId),
		statusIdx: index("dataset_evaluations_status_idx").on(table.status),
	}),
);

export const datasetEvaluationTrials = pgTable(
	"dataset_evaluation_trials",
	{
		trialId: text("trialId").primaryKey().$defaultFn(() => nanoid()),
		evaluationId: text("evaluationId")
			.notNull()
			.references(() => datasetEvaluations.evaluationId, { onDelete: "cascade" }),
		sampleId: text("sampleId")
			.notNull()
			.references(() => datasetSamples.sampleId, { onDelete: "restrict" }),
		repetition: integer("repetition").notNull(),
		ordinal: integer("ordinal").notNull(),
		status: text("status")
			.$type<
				| "pending"
				| "preparing"
				| "running"
				| "post_processing"
				| "completed"
				| "scan_failed"
				| "timed_out"
				| "postprocess_failed"
				| "canceled"
			>()
			.notNull()
			.default("pending"),
		scanJobId: text("scanJobId"),
		postScanStatus: text("postScanStatus")
			.$type<"pending" | "running" | "completed" | "failed" | "skipped">()
			.notNull()
			.default("pending"),
		postScanResult: jsonb("postScanResult").$type<unknown | null>(),
		durationMs: integer("durationMs"),
		inputTokens: bigint("inputTokens", { mode: "number" }).notNull().default(0),
		outputTokens: bigint("outputTokens", { mode: "number" }).notNull().default(0),
		thoughtTokens: bigint("thoughtTokens", { mode: "number" }).notNull().default(0),
		totalTokens: bigint("totalTokens", { mode: "number" }).notNull().default(0),
		estimatedCost: real("estimatedCost").notNull().default(0),
		result: jsonb("result").$type<Record<string, unknown> | null>(),
		errorMessage: text("errorMessage"),
		startedAt: text("startedAt"),
		finishedAt: text("finishedAt"),
		createdAt: text("createdAt").notNull().$defaultFn(timestamp),
		updatedAt: text("updatedAt").notNull().$defaultFn(timestamp),
	},
	(table) => ({
		evaluationIdx: index("dataset_evaluation_trials_evaluation_idx").on(
			table.evaluationId,
			table.ordinal,
		),
		sampleIdx: index("dataset_evaluation_trials_sample_idx").on(table.sampleId),
		evaluationSampleRepetitionUnique: uniqueIndex(
			"dataset_evaluation_trials_sample_repetition_unique",
		).on(table.evaluationId, table.sampleId, table.repetition),
		activeEvaluationUnique: uniqueIndex("dataset_evaluation_active_trial_unique")
			.on(table.evaluationId)
			.where(sql`${table.status} in ('preparing', 'running', 'post_processing')`),
		statusIdx: index("dataset_evaluation_trials_status_idx").on(table.status),
	}),
);

export const apiDatasetId = z.object({ datasetId: z.string().min(1) });
export const apiDatasetProfileId = z.object({ profileId: z.string().min(1) });
export const apiDatasetEvaluationId = z.object({ evaluationId: z.string().min(1) });
export const apiDatasetTrialId = z.object({ trialId: z.string().min(1) });

export const apiCreateDataset = z.object({
	name: z.string().trim().min(1).max(160),
	description: z.string().max(4000).optional().default(""),
	source: datasetSourceSchema,
	postCheckoutHook: datasetHookSchema.optional().default({ type: "none" }),
	postCheckoutSchema: z.record(z.unknown()).optional().default({}),
	postScanHook: datasetHookSchema.optional().default({ type: "none" }),
	postEvaluationHook: datasetHookSchema.optional().default({ type: "none" }),
	postScanSchema: z.record(z.unknown()).optional().default({}),
	postEvaluationSchema: z.record(z.unknown()).optional().default({}),
});

export const apiUpdateDataset = apiDatasetId.extend({
	name: z.string().trim().min(1).max(160).optional(),
	description: z.string().max(4000).optional(),
	source: datasetSourceSchema.optional(),
	postCheckoutHook: datasetHookSchema.optional(),
	postCheckoutSchema: z.record(z.unknown()).optional(),
	postScanHook: datasetHookSchema.optional(),
	postEvaluationHook: datasetHookSchema.optional(),
	postScanSchema: z.record(z.unknown()).optional(),
	postEvaluationSchema: z.record(z.unknown()).optional(),
});

export const apiCreateDatasetProfile = apiDatasetId.extend({
	profileKey: z.string().trim().min(1).max(160).optional(),
});

export const apiListDatasetSamples = apiDatasetProfileId.extend({
	search: z.string().optional(),
	page: z.number().int().min(1).default(1),
	pageSize: z.number().int().min(1).max(100).default(25),
});

export const apiCreateDatasetEvaluation = apiDatasetId.extend({
	profileId: z.string().min(1),
	name: z.string().trim().min(1).max(160),
	pipelineId: z.enum(["full", "research", "tob-goal"]),
	sampleKeys: z.array(z.string().min(1)).min(1),
	repetitions: z.number().int().min(1).max(100),
	timeBudgetSeconds: z.number().int().min(1).max(86_400).nullable().optional(),
	scanRuntimeSettings: z.record(z.unknown()).optional().default({}),
});

export type DatasetManifestInput = z.infer<typeof datasetSourceSchema>;
