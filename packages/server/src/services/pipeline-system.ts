import { TRPCError } from "@trpc/server";
import { and, eq, inArray, isNull, max } from "drizzle-orm";
import { db } from "@vulseek/server/db";
import {
	applications,
	compose,
	environments,
	organization,
	projects,
	scanPipelines,
	scanPipelineVersions,
} from "@vulseek/server/db/schema";
import { nanoid } from "nanoid";
import {
	compilePipelineDocumentV3,
	loadBuiltinPipelineTemplates,
	parsePipelineDocumentV3,
	type BuiltinPipelineTemplate,
} from "../services/scan/pipeline/document-v3";

/**
 * System pipeline seeding and template upgrade.
 *
 * - Every organization gets the four built-in pipelines (full / delta /
 *   research / tob-goal) as `systemKey` rows with a `source=system` v1.
 * - Profile defaults backfill to the org's Full pipeline.
 * - Ship-time template upgrades compare the built-in template hash against
 *   the org's current version; a new hash appends a system version and
 *   switches `current` — previous system versions and custom versions stay
 *   and can be switched back to.
 *
 * Everything is idempotent; audit happens via the version rows themselves
 * (source + publishedBy + publishedAt) and the pipeline `updatedBy`.
 */

const SYSTEM_SLUG_SUFFIXES = ["", "-system-1", "-system-2", "-system-3"];

const ensureUniqueSystemSlug = async (
	organizationId: string,
	baseSlug: string,
): Promise<string> => {
	for (const suffix of SYSTEM_SLUG_SUFFIXES) {
		const slug = `${baseSlug}${suffix}`;
		const existing = await db
			.select({ pipelineId: scanPipelines.pipelineId })
			.from(scanPipelines)
			.where(
				and(
					eq(scanPipelines.organizationId, organizationId),
					eq(scanPipelines.slug, slug),
				),
			)
			.limit(1)
			.then((rows) => rows[0]);
		if (!existing) return slug;
	}
	throw new Error(`Cannot allocate a system slug for "${baseSlug}"`);
};

const publishTemplateVersion = async (input: {
	organizationId: string;
	userId: string | null;
	template: BuiltinPipelineTemplate;
}) => {
	const { organizationId, userId, template } = input;
	const pipeline = await db
		.select()
		.from(scanPipelines)
		.where(
			and(
				eq(scanPipelines.organizationId, organizationId),
				eq(scanPipelines.systemKey, template.systemKey),
			),
		)
		.limit(1)
		.then((rows) => rows[0]);

	let pipelineId = pipeline?.pipelineId ?? null;

	if (!pipeline) {
		const slug = await ensureUniqueSystemSlug(
			organizationId,
			template.systemKey,
		);
		const created = await db
			.insert(scanPipelines)
			.values({
				pipelineId: nanoid(),
				organizationId,
				slug,
				name: template.name,
				systemKey: template.systemKey,
				createdBy: userId,
				updatedBy: userId,
			})
			.returning({ pipelineId: scanPipelines.pipelineId });
		pipelineId = created[0]!.pipelineId;
	}

	// Idempotent: the exact template content is already the current version.
	const current = pipelineId
		? await db
				.select({
					contentHash: scanPipelineVersions.contentHash,
					pipelineVersionId: scanPipelineVersions.pipelineVersionId,
				})
				.from(scanPipelineVersions)
				.where(
					eq(
						scanPipelineVersions.pipelineVersionId,
						pipeline?.currentPublishedVersionId ?? "",
					),
				)
				.limit(1)
				.then((rows) => rows[0])
		: null;
	if (current?.contentHash === template.contentHash) {
		return { pipelineId: pipelineId!, unchanged: true };
	}

	const existingVersion = await db
		.select({ pipelineVersionId: scanPipelineVersions.pipelineVersionId })
		.from(scanPipelineVersions)
		.where(
			and(
				eq(scanPipelineVersions.pipelineId, pipelineId!),
				eq(scanPipelineVersions.contentHash, template.contentHash),
			),
		)
		.limit(1)
		.then((rows) => rows[0]);

	let versionId: string;
	if (existingVersion) {
		versionId = existingVersion.pipelineVersionId;
	} else {
		const [latest] = await db
			.select({ next: max(scanPipelineVersions.versionNumber) })
			.from(scanPipelineVersions)
			.where(eq(scanPipelineVersions.pipelineId, pipelineId!));
		const versionNumber = (latest?.next ?? 0) + 1;
		const inserted = await db
			.insert(scanPipelineVersions)
			.values({
				pipelineVersionId: nanoid(),
				pipelineId: pipelineId!,
				versionNumber,
				yaml: template.yaml,
				contentHash: template.contentHash,
				compiledDefinition: compilePipelineDocumentV3(
					parsePipelineDocumentV3(template.yaml).document!,
				) as unknown,
				source: "system",
				publishedBy: userId,
			})
			.returning({ pipelineVersionId: scanPipelineVersions.pipelineVersionId });
		versionId = inserted[0]!.pipelineVersionId;
	}

	await db
		.update(scanPipelines)
		.set({
			currentPublishedVersionId: versionId,
			updatedAt: new Date().toISOString(),
			updatedBy: userId,
		})
		.where(eq(scanPipelines.pipelineId, pipelineId!));

	return { pipelineId: pipelineId!, unchanged: false };
};

/**
 * Seed the four system pipelines for one organization (v1). Idempotent —
 * safe to call on every organization create and on startup.
 */
export const seedSystemPipelinesForOrganization = async (
	organizationId: string,
	userId: string | null = null,
) => {
	const templates = loadBuiltinPipelineTemplates();
	const results: Array<{ systemKey: string; pipelineId: string }> = [];
	for (const template of templates) {
		const result = await publishTemplateVersion({
			organizationId,
			userId,
			template,
		});
		results.push({
			systemKey: template.systemKey,
			pipelineId: result.pipelineId,
		});
	}
	return results;
};

/** Ship-time template upgrade for a single organization. */
export const syncSystemPipelineTemplatesForOrganization = async (
	organizationId: string,
	userId: string | null = null,
) => {
	const templates = loadBuiltinPipelineTemplates();
	const updates: Array<{ systemKey: string; unchanged: boolean }> = [];
	for (const template of templates) {
		const result = await publishTemplateVersion({
			organizationId,
			userId,
			template,
		});
		updates.push({ systemKey: template.systemKey, unchanged: result.unchanged });
	}
	return updates;
};

/** Seed every existing organization (startup). */
export const seedAllOrganizationsSystemPipelines = async () => {
	const organizations = await db
		.select({ id: organization.id })
		.from(organization);
	for (const org of organizations) {
		await seedSystemPipelinesForOrganization(org.id);
	}
	return organizations.length;
};

/** Backfill profile defaults to the org Full pipeline. */
export const backfillProfileDefaultPipelines = async () => {
	const fullPipelines = await db
		.select({
			pipelineId: scanPipelines.pipelineId,
			organizationId: scanPipelines.organizationId,
		})
		.from(scanPipelines)
		.where(
			and(
				eq(scanPipelines.systemKey, "full"),
				isNull(scanPipelines.archivedAt),
			),
		);
	let updated = 0;
	for (const pipeline of fullPipelines) {
		// application → environment → project → organization
		const orgEnvironmentIds = await db
			.select({ environmentId: environments.environmentId })
			.from(environments)
			.innerJoin(projects, eq(projects.projectId, environments.projectId))
			.where(eq(projects.organizationId, pipeline.organizationId));
		if (orgEnvironmentIds.length === 0) continue;
		const environmentIds = orgEnvironmentIds.map((row) => row.environmentId);
		const [app] = await db
			.update(applications)
			.set({ defaultPipelineId: pipeline.pipelineId })
			.where(
				and(
					inArray(applications.environmentId, environmentIds),
					isNull(applications.defaultPipelineId),
				),
			)
			.returning({ applicationId: applications.applicationId });
		if (app) updated += 1;
		const [composeRow] = await db
			.update(compose)
			.set({ defaultPipelineId: pipeline.pipelineId })
			.where(
				and(
					inArray(compose.environmentId, environmentIds),
					isNull(compose.defaultPipelineId),
				),
			)
			.returning({ composeId: compose.composeId });
		if (composeRow) updated += 1;
	}
	return updated;
};

export const findSystemPipelineForOrganization = async (
	organizationId: string,
	systemKey: string,
) => {
	const pipeline = await db
		.select()
		.from(scanPipelines)
		.where(
			and(
				eq(scanPipelines.organizationId, organizationId),
				eq(scanPipelines.systemKey, systemKey),
			),
		)
		.limit(1)
		.then((rows) => rows[0]);
	if (!pipeline) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: `System pipeline "${systemKey}" not found for this organization`,
		});
	}
	return pipeline;
};
