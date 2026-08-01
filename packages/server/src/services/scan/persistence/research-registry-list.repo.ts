import { db } from "@vulseek/server/db";
import {
	exploitChains,
	exploitPrimitives,
	researchTracks,
} from "@vulseek/server/db/schema";
import { and, asc, count, desc, eq, ilike, inArray, or } from "drizzle-orm";
import {
	buildResearchRegistryPage,
	normalizeResearchRegistryPageInput,
	type ResearchRegistryPageInput,
} from "./research-registry-list";

const orderDirection = (direction: string) =>
	direction === "asc" ? asc : desc;

const trackOrderBy = (
	normalized: ReturnType<typeof normalizeResearchRegistryPageInput>,
) => {
	switch (normalized.sortKey) {
		case "trackKey":
			return researchTracks.trackKey;
		case "approachFamily":
			return researchTracks.approachFamily;
		case "researchIdea":
			return researchTracks.researchIdea;
		case "status":
			return researchTracks.status;
		case "iteration":
			return researchTracks.iteration;
		default:
			return researchTracks.updatedAt;
	}
};

const primitiveOrderBy = (
	normalized: ReturnType<typeof normalizeResearchRegistryPageInput>,
) => {
	switch (normalized.sortKey) {
		case "primitiveId":
			return exploitPrimitives.primitiveId;
		case "findingId":
			return exploitPrimitives.findingId;
		case "name":
			return exploitPrimitives.name;
		case "capability":
			return exploitPrimitives.capability;
		case "trustLevel":
			return exploitPrimitives.trustLevel;
		case "status":
			return exploitPrimitives.status;
		default:
			return exploitPrimitives.updatedAt;
	}
};

const chainOrderBy = (
	normalized: ReturnType<typeof normalizeResearchRegistryPageInput>,
) => {
	switch (normalized.sortKey) {
		case "chainId":
			return exploitChains.chainId;
		case "chainKey":
			return exploitChains.chainKey;
		case "status":
			return exploitChains.status;
		default:
			return exploitChains.updatedAt;
	}
};

export const listResearchTracksPageRepo = async (
	input: ResearchRegistryPageInput,
) => {
	const normalized = normalizeResearchRegistryPageInput(input);
	const conditions = [
		eq(researchTracks.scanJobId, normalized.scanJobId),
		normalized.statuses.length
			? inArray(researchTracks.status, normalized.statuses)
			: normalized.status
				? eq(researchTracks.status, normalized.status)
				: undefined,
		normalized.query
			? or(
					ilike(researchTracks.trackKey, `%${normalized.query}%`),
					ilike(researchTracks.approachFamily, `%${normalized.query}%`),
					ilike(researchTracks.researchIdea, `%${normalized.query}%`),
					ilike(researchTracks.nextStep, `%${normalized.query}%`),
			  )
			: undefined,
	].filter(Boolean);
	const where = and(...conditions);
	const [{ total = 0 } = { total: 0 }] = await db
		.select({ total: count() })
		.from(researchTracks)
		.where(where);
	const page = buildResearchRegistryPage({
		items: [],
		total,
		requestedPage: normalized.page,
		pageSize: normalized.pageSize,
	});
	const items = await db
		.select()
		.from(researchTracks)
		.where(where)
		.orderBy(
			orderDirection(normalized.sortDirection)(trackOrderBy(normalized)),
		asc(researchTracks.trackId),
		)
		.limit(normalized.pageSize)
		.offset((page.page - 1) * normalized.pageSize);

	return { ...page, items };
};

export const listExploitPrimitivesPageRepo = async (
	input: ResearchRegistryPageInput,
) => {
	const normalized = normalizeResearchRegistryPageInput(input);
	const conditions = [
		eq(exploitPrimitives.scanJobId, normalized.scanJobId),
		normalized.statuses.length
			? inArray(exploitPrimitives.status, normalized.statuses)
			: normalized.status
				? eq(exploitPrimitives.status, normalized.status)
				: undefined,
		normalized.trustLevels.length
			? inArray(exploitPrimitives.trustLevel, normalized.trustLevels)
			: undefined,
		normalized.query
			? or(
					ilike(exploitPrimitives.primitiveId, `%${normalized.query}%`),
					ilike(exploitPrimitives.findingId, `%${normalized.query}%`),
					ilike(exploitPrimitives.name, `%${normalized.query}%`),
					ilike(exploitPrimitives.capability, `%${normalized.query}%`),
					ilike(exploitPrimitives.trustLevel, `%${normalized.query}%`),
			  )
			: undefined,
	].filter(Boolean);
	const where = and(...conditions);
	const [{ total = 0 } = { total: 0 }] = await db
		.select({ total: count() })
		.from(exploitPrimitives)
		.where(where);
	const page = buildResearchRegistryPage({
		items: [],
		total,
		requestedPage: normalized.page,
		pageSize: normalized.pageSize,
	});
	const items = await db
		.select()
		.from(exploitPrimitives)
		.where(where)
		.orderBy(
			orderDirection(normalized.sortDirection)(primitiveOrderBy(normalized)),
			asc(exploitPrimitives.primitiveId),
		)
		.limit(normalized.pageSize)
		.offset((page.page - 1) * normalized.pageSize);

	return { ...page, items };
};

export const listExploitChainsPageRepo = async (
	input: ResearchRegistryPageInput,
) => {
	const normalized = normalizeResearchRegistryPageInput(input);
	const conditions = [
		eq(exploitChains.scanJobId, normalized.scanJobId),
		normalized.statuses.length
			? inArray(exploitChains.status, normalized.statuses)
			: normalized.status
				? eq(exploitChains.status, normalized.status)
				: undefined,
		normalized.query
			? or(
					ilike(exploitChains.chainId, `%${normalized.query}%`),
					ilike(exploitChains.chainKey, `%${normalized.query}%`),
			  )
			: undefined,
	].filter(Boolean);
	const where = and(...conditions);
	const [{ total = 0 } = { total: 0 }] = await db
		.select({ total: count() })
		.from(exploitChains)
		.where(where);
	const page = buildResearchRegistryPage({
		items: [],
		total,
		requestedPage: normalized.page,
		pageSize: normalized.pageSize,
	});
	const items = await db
		.select()
		.from(exploitChains)
		.where(where)
		.orderBy(
			orderDirection(normalized.sortDirection)(chainOrderBy(normalized)),
			asc(exploitChains.chainId),
		)
		.limit(normalized.pageSize)
		.offset((page.page - 1) * normalized.pageSize);

	return { ...page, items };
};
