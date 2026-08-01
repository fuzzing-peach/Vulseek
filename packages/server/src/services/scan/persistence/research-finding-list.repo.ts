import { db } from "@vulseek/server/db";
import { researchFindings, researchTracks } from "@vulseek/server/db/schema";
import { and, asc, count, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import {
	buildResearchRegistryPage,
	normalizeResearchRegistryPageInput,
	type ResearchRegistryPageInput,
} from "./research-registry-list";

const findingText = (key: string) => sql<string>`${researchFindings.content}->>${key}`;
const findingFilePath = () => sql<string>`${researchFindings.content}->'location'->>'filePath'`;

const findingConfidence = () =>
	sql<number>`coalesce(nullif(${findingText("confidence")}, '')::double precision, -1)`;

const buildStatusCondition = (
	normalized: ReturnType<typeof normalizeResearchRegistryPageInput>,
) => {
	const statuses = normalized.statuses.length
		? normalized.statuses
		: normalized.status
			? [normalized.status]
			: [];
	return statuses.length ? inArray(researchFindings.status, statuses) : undefined;
};

const buildOrderBy = (
	normalized: ReturnType<typeof normalizeResearchRegistryPageInput>,
) => {
	const direction = normalized.sortDirection === "asc" ? asc : desc;
	const order = (() => {
		switch (normalized.sortKey) {
			case "findingId":
				return researchFindings.findingId;
			case "title":
				return findingText("title");
			case "trackKey":
				return researchTracks.trackKey;
			case "vulnerabilityClass":
				return findingText("vulnerabilityClass");
			case "location":
				return findingFilePath();
			case "confidence":
				return findingConfidence();
			case "status":
				return researchFindings.status;
		default:
				return researchFindings.updatedAt;
		}
	})();
	return [direction(order), asc(researchFindings.findingId)];
};

export const listResearchFindingsPageRepo = async (
	input: ResearchRegistryPageInput,
) => {
	const normalized = normalizeResearchRegistryPageInput(input);
	const search = `%${normalized.query}%`;
	const conditions = [
		eq(researchFindings.scanJobId, normalized.scanJobId),
		buildStatusCondition(normalized),
		normalized.query
			? or(
					ilike(researchFindings.findingId, search),
					ilike(researchTracks.trackKey, search),
					ilike(findingText("title"), search),
					ilike(findingText("vulnerabilityClass"), search),
					ilike(findingText("claim"), search),
					ilike(findingText("rootCauseKey"), search),
					ilike(findingFilePath(), search),
			  )
			: undefined,
	].filter(Boolean);
	const where = and(...conditions);
	const [{ total = 0 } = { total: 0 }] = await db
		.select({ total: count() })
		.from(researchFindings)
		.innerJoin(researchTracks, eq(researchTracks.trackId, researchFindings.trackId))
		.where(where);
	const page = buildResearchRegistryPage({
		items: [],
		total,
		requestedPage: normalized.page,
		pageSize: normalized.pageSize,
	});
	const items = await db
		.select({
			scanJobId: researchFindings.scanJobId,
			findingId: researchFindings.findingId,
			trackId: researchFindings.trackId,
			trackKey: researchTracks.trackKey,
			producerTaskId: researchFindings.producerTaskId,
			content: researchFindings.content,
			status: researchFindings.status,
			latestValidationVerdict: researchFindings.latestValidationVerdict,
			latestReviewDecision: researchFindings.latestReviewDecision,
			requiredEvidence: researchFindings.requiredEvidence,
			revision: researchFindings.revision,
			createdAt: researchFindings.createdAt,
			updatedAt: researchFindings.updatedAt,
		})
		.from(researchFindings)
		.innerJoin(researchTracks, eq(researchTracks.trackId, researchFindings.trackId))
		.where(where)
		.orderBy(...buildOrderBy(normalized))
		.limit(normalized.pageSize)
		.offset((page.page - 1) * normalized.pageSize);

	return { ...page, items };
};

export const findResearchFindingRepo = async (input: {
	scanJobId: string;
	findingId: string;
}) => {
	const [item] = await db
		.select({
			scanJobId: researchFindings.scanJobId,
			findingId: researchFindings.findingId,
			trackId: researchFindings.trackId,
			trackKey: researchTracks.trackKey,
			producerTaskId: researchFindings.producerTaskId,
			content: researchFindings.content,
			status: researchFindings.status,
			latestValidationVerdict: researchFindings.latestValidationVerdict,
			latestReviewDecision: researchFindings.latestReviewDecision,
			requiredEvidence: researchFindings.requiredEvidence,
			revision: researchFindings.revision,
			createdAt: researchFindings.createdAt,
			updatedAt: researchFindings.updatedAt,
		})
		.from(researchFindings)
		.innerJoin(researchTracks, eq(researchTracks.trackId, researchFindings.trackId))
		.where(
			and(
				eq(researchFindings.scanJobId, input.scanJobId),
				eq(researchFindings.findingId, input.findingId),
			),
		)
		.limit(1);
	return item ?? null;
};
