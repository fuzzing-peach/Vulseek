import { index, integer, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { scanJobs, tasks } from "./scan";

const timestamp = () => new Date().toISOString();

export const researchTracks = pgTable(
	"research_tracks",
	{
		trackId: text("trackId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		scanJobId: text("scanJobId")
			.notNull()
			.references(() => scanJobs.scanJobId, { onDelete: "cascade" }),
		trackKey: text("trackKey").notNull(),
		approachFamily: text("approachFamily").notNull(),
		researchIdea: text("researchIdea").notNull(),
		scope: jsonb("scope").$type<Record<string, unknown>>().notNull().default({}),
		mechanisms: jsonb("mechanisms").$type<string[]>().notNull().default([]),
		status: text("status").notNull().default("queued"),
		coverage: jsonb("coverage").$type<Record<string, unknown>>().notNull().default({}),
		evidenceRefs: jsonb("evidenceRefs").$type<string[]>().notNull().default([]),
		candidateFindingIds: jsonb("candidateFindingIds").$type<string[]>().notNull().default([]),
		blockReason: text("blockReason"),
		reopenCondition: text("reopenCondition"),
		nextStep: text("nextStep"),
		iteration: integer("iteration").notNull().default(0),
		currentTaskId: text("currentTaskId").references(() => tasks.taskId, {
			onDelete: "set null",
		}),
		revision: integer("revision").notNull().default(0),
		createdAt: text("createdAt").notNull().$defaultFn(timestamp),
		updatedAt: text("updatedAt").notNull().$defaultFn(timestamp),
	},
	(table) => [
		index("research_tracks_scan_job_idx").on(table.scanJobId, table.updatedAt),
		index("research_tracks_key_idx").on(table.scanJobId, table.trackKey),
		uniqueIndex("research_tracks_scan_job_key_unique").on(table.scanJobId, table.trackKey),
	],
);

export const researchTrackEvents = pgTable(
	"research_track_events",
	{
		eventId: text("eventId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		scanJobId: text("scanJobId")
			.notNull()
			.references(() => scanJobs.scanJobId, { onDelete: "cascade" }),
		trackId: text("trackId")
			.notNull()
			.references(() => researchTracks.trackId, { onDelete: "cascade" }),
			eventType: text("eventType").notNull(),
		actorTaskId: text("actorTaskId").references(() => tasks.taskId, {
			onDelete: "set null",
		}),
		sourceStage: text("sourceStage").notNull(),
		expectedRevision: integer("expectedRevision"),
		resultingRevision: integer("resultingRevision").notNull(),
		payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
		evidenceRefs: jsonb("evidenceRefs").$type<string[]>().notNull().default([]),
		idempotencyKey: text("idempotencyKey").notNull().unique(),
		createdAt: text("createdAt").notNull().$defaultFn(timestamp),
	},
	(table) => [
		index("research_track_events_track_idx").on(table.trackId, table.createdAt),
		index("research_track_events_job_idx").on(table.scanJobId, table.createdAt),
	],
);

export const exploitPrimitives = pgTable(
	"exploit_primitives",
	{
		primitiveId: text("primitiveId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		scanJobId: text("scanJobId")
			.notNull()
			.references(() => scanJobs.scanJobId, { onDelete: "cascade" }),
			candidateId: text("candidateId").notNull(),
			name: text("name").notNull(),
			capability: text("capability").notNull(),
		requiredInput: jsonb("requiredInput").$type<Record<string, unknown>>().notNull().default({}),
		producedCapability: jsonb("producedCapability").$type<Record<string, unknown>>().notNull().default({}),
		trustLevel: text("trustLevel").notNull(),
		status: text("status").notNull().default("confirmed"),
		evidenceRefs: jsonb("evidenceRefs").$type<string[]>().notNull().default([]),
		revision: integer("revision").notNull().default(0),
		createdAt: text("createdAt").notNull().$defaultFn(timestamp),
		updatedAt: text("updatedAt").notNull().$defaultFn(timestamp),
	},
	(table) => [
		index("exploit_primitives_scan_job_idx").on(table.scanJobId, table.updatedAt),
		index("exploit_primitives_candidate_idx").on(table.scanJobId, table.candidateId),
	],
);

export const exploitPrimitiveEvents = pgTable(
	"exploit_primitive_events",
	{
		eventId: text("eventId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		scanJobId: text("scanJobId")
			.notNull()
			.references(() => scanJobs.scanJobId, { onDelete: "cascade" }),
		primitiveId: text("primitiveId")
			.notNull()
			.references(() => exploitPrimitives.primitiveId, { onDelete: "cascade" }),
		eventType: text("eventType").notNull(),
		actorTaskId: text("actorTaskId").references(() => tasks.taskId, {
			onDelete: "set null",
		}),
		sourceStage: text("sourceStage").notNull(),
		expectedRevision: integer("expectedRevision"),
		resultingRevision: integer("resultingRevision").notNull(),
		payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
		evidenceRefs: jsonb("evidenceRefs").$type<string[]>().notNull().default([]),
		idempotencyKey: text("idempotencyKey").notNull().unique(),
		createdAt: text("createdAt").notNull().$defaultFn(timestamp),
	},
	(table) => [index("exploit_primitive_events_idx").on(table.primitiveId, table.createdAt)],
);

export const exploitChains = pgTable(
	"exploit_chains",
	{
		chainId: text("chainId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		scanJobId: text("scanJobId")
			.notNull()
			.references(() => scanJobs.scanJobId, { onDelete: "cascade" }),
		chainKey: text("chainKey").notNull(),
		status: text("status").notNull().default("candidate"),
		steps: jsonb("steps").$type<Record<string, unknown>[]>().notNull().default([]),
		entrypoint: jsonb("entrypoint").$type<Record<string, unknown>>().notNull().default({}),
		requiredCapabilities: jsonb("requiredCapabilities").$type<string[]>().notNull().default([]),
		producedCapabilities: jsonb("producedCapabilities").$type<string[]>().notNull().default([]),
		trustBoundaryCrossings: jsonb("trustBoundaryCrossings").$type<Record<string, unknown>[]>().notNull().default([]),
		deploymentConditions: jsonb("deploymentConditions").$type<string[]>().notNull().default([]),
		primitiveGaps: jsonb("primitiveGaps").$type<Record<string, unknown>[]>().notNull().default([]),
		successTarget: jsonb("successTarget").$type<Record<string, unknown>>().notNull().default({}),
		revision: integer("revision").notNull().default(0),
		createdAt: text("createdAt").notNull().$defaultFn(timestamp),
		updatedAt: text("updatedAt").notNull().$defaultFn(timestamp),
	},
	(table) => [
		index("exploit_chains_scan_job_idx").on(table.scanJobId, table.updatedAt),
		index("exploit_chains_key_idx").on(table.scanJobId, table.chainKey),
	],
);

export const exploitChainEvents = pgTable(
	"exploit_chain_events",
	{
		eventId: text("eventId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		scanJobId: text("scanJobId")
			.notNull()
			.references(() => scanJobs.scanJobId, { onDelete: "cascade" }),
		chainId: text("chainId")
			.notNull()
			.references(() => exploitChains.chainId, { onDelete: "cascade" }),
		eventType: text("eventType").notNull(),
		actorTaskId: text("actorTaskId").references(() => tasks.taskId, {
			onDelete: "set null",
		}),
		sourceStage: text("sourceStage").notNull(),
		expectedRevision: integer("expectedRevision"),
		resultingRevision: integer("resultingRevision").notNull(),
		payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
		evidenceRefs: jsonb("evidenceRefs").$type<string[]>().notNull().default([]),
		idempotencyKey: text("idempotencyKey").notNull().unique(),
		createdAt: text("createdAt").notNull().$defaultFn(timestamp),
	},
	(table) => [index("exploit_chain_events_idx").on(table.chainId, table.createdAt)],
);
