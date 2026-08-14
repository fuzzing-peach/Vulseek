import { and, asc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@vulseek/server/db";
import {
	scanPipelineProfiles,
	scanPipelineVersions,
	scanPipelines,
} from "@vulseek/server/db/schema";
import type { ScanRuntimeSettings } from "@vulseek/server/db/schema/shared";
import { TRPCError } from "@trpc/server";
import {
	compilePipelineDocumentV3,
	parsePipelineDocumentV3,
} from "./scan/pipeline/document-v3";

const notFound = () => new TRPCError({ code: "NOT_FOUND", message: "Pipeline profile not found" });

const assertPipelineVersion = async (organizationId: string, pipelineId: string, versionId: string) => {
	const row = await db
		.select({ pipelineId: scanPipelineVersions.pipelineId, yaml: scanPipelineVersions.yaml })
		.from(scanPipelineVersions)
		.innerJoin(scanPipelines, eq(scanPipelines.pipelineId, scanPipelineVersions.pipelineId))
		.where(and(
			eq(scanPipelineVersions.pipelineVersionId, versionId),
			eq(scanPipelineVersions.pipelineId, pipelineId),
			eq(scanPipelines.organizationId, organizationId),
		))
		.limit(1)
		.then((rows) => rows[0]);
	if (!row) throw new TRPCError({ code: "BAD_REQUEST", message: "Pipeline version is not available" });
	return row;
};

export const listPipelineProfilesForOrganization = (organizationId: string, pipelineId: string) =>
	db.select().from(scanPipelineProfiles).where(and(
		eq(scanPipelineProfiles.organizationId, organizationId),
		eq(scanPipelineProfiles.pipelineId, pipelineId),
	)).orderBy(asc(scanPipelineProfiles.name));

export const findPipelineProfileForOrganization = async (organizationId: string, pipelineProfileId: string) => {
	const row = await db.select().from(scanPipelineProfiles).where(and(
		eq(scanPipelineProfiles.organizationId, organizationId),
		eq(scanPipelineProfiles.pipelineProfileId, pipelineProfileId),
	)).limit(1).then((rows) => rows[0]);
	if (!row) throw notFound();
	return row;
};

export const createPipelineProfileForOrganization = async (input: {
	organizationId: string; pipelineId: string; pipelineVersionId: string; name: string;
	description?: string | null; settings: ScanRuntimeSettings;
}) => {
	await assertPipelineVersion(input.organizationId, input.pipelineId, input.pipelineVersionId);
	return db.insert(scanPipelineProfiles).values({
		pipelineProfileId: nanoid(), ...input, description: input.description ?? null,
	}).returning().then((rows) => rows[0]);
};

export const updatePipelineProfileForOrganization = async (input: {
	organizationId: string; pipelineProfileId: string; name: string;
	description?: string | null; settings: ScanRuntimeSettings;
}) => {
	await findPipelineProfileForOrganization(input.organizationId, input.pipelineProfileId);
	return db.update(scanPipelineProfiles).set({
		name: input.name, description: input.description ?? null, settings: input.settings,
		updatedAt: new Date().toISOString(),
	}).where(and(
		eq(scanPipelineProfiles.organizationId, input.organizationId),
		eq(scanPipelineProfiles.pipelineProfileId, input.pipelineProfileId),
	)).returning().then((rows) => rows[0]);
};

export const getPipelineProfileGraphForOrganization = async (organizationId: string, pipelineId: string, versionId: string) => {
	const version = await assertPipelineVersion(organizationId, pipelineId, versionId);
	const parsed = parsePipelineDocumentV3(version.yaml);
	if (!parsed.document) throw new TRPCError({ code: "BAD_REQUEST", message: "Pipeline YAML is invalid" });
	const compiled = compilePipelineDocumentV3(parsed.document, { pipelineId });
	return {
		pipelineName: compiled.name,
		nodes: compiled.stages.map((stage, order) => ({
			id: stage.id, stageId: stage.id, stageName: stage.id, name: stage.name, title: stage.name,
			queueId: null, queueName: null, status: "pending" as const, counts: {
				waiting: 0, queued: 0, launching: 0, launched: 0, starting: 0, running: 0,
				completed: 0, failed: 0, exited: 0, total: 0, pending: 0,
			}, concurrencyLimit: stage.concurrency, disabled: false, effectiveDisabled: false,
			configuredConcurrency: stage.concurrency, configuredAgentProfileId: stage.runtime.agentProfileId ?? null,
			agentProfile: null, groupId: stage.group, order,
		})),
		edges: compiled.edges.map((edge) => ({
			id: edge.id, name: edge.name, source: edge.from, target: edge.to, fork: edge.fork ?? false,
			routeKey: edge.route?.key ?? null, isDefaultRoute: Boolean(edge.route?.default),
		})),
		groups: compiled.groups.map((group) => ({
			id: group.id, name: group.name, leaderStageName: group.leader,
			memberStageNames: group.members, stageNames: [group.leader, ...group.members],
		})),
	};
};
