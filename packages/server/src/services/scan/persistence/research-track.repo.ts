import { db } from "@vulseek/server/db";
import { researchTracks } from "@vulseek/server/db/schema";
import { and, eq } from "drizzle-orm";

export type ResearchTrackIdentity = {
	trackKey: string;
	trackId: string;
};

export const findResearchTrackIdByKeyRepo = async (input: {
	scanJobId: string;
	trackKey: string;
}) => {
	const [row] = await db
		.select({ trackId: researchTracks.trackId })
		.from(researchTracks)
		.where(
			and(
				eq(researchTracks.scanJobId, input.scanJobId),
				eq(researchTracks.trackKey, input.trackKey),
			),
		)
		.limit(1);
	return row?.trackId ?? null;
};

export const findResearchTrackIdentityRepo = async (input: {
	scanJobId: string;
	trackKey: string;
	approachFamily?: string | null;
}) => {
	const [exact] = await db
		.select({
			trackKey: researchTracks.trackKey,
			trackId: researchTracks.trackId,
		})
		.from(researchTracks)
		.where(
			and(
				eq(researchTracks.scanJobId, input.scanJobId),
				eq(researchTracks.trackKey, input.trackKey),
			),
		)
		.limit(1);
	if (exact) return exact;

	const approachFamily = input.approachFamily?.trim();
	if (!approachFamily) return null;

	const matches = await db
		.select({
			trackKey: researchTracks.trackKey,
			trackId: researchTracks.trackId,
		})
		.from(researchTracks)
		.where(
			and(
				eq(researchTracks.scanJobId, input.scanJobId),
				eq(researchTracks.approachFamily, approachFamily),
			),
		)
		.limit(2);
	return matches.length === 1 ? matches[0] ?? null : null;
};
