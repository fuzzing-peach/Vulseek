import { db } from "@vulseek/server/db";
import { scanJobs } from "@vulseek/server/db/schema";
import { eq } from "drizzle-orm";
import {
	normalizeLegacyVerificationSchema,
	normalizePipelineDefinitionSnapshot,
	loadScanPipelineDefinitions,
	type ScanPipelineDefinitions,
} from "../pipeline/scan-pipeline-definitions";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isEmptySnapshot = (value: unknown) =>
	isRecord(value) && Object.keys(value).length === 0;

export const backfillScanPipelineDefinitionSnapshots = async () => {
	let processedCount = 0;
	let updatedCount = 0;
	const currentDefinitions = loadScanPipelineDefinitions();

	await db.transaction(async (tx) => {
		const rows = await tx
			.select({
				scanJobId: scanJobs.scanJobId,
				snapshot: scanJobs.scanPipelineDefinitionSnapshot,
			})
			.from(scanJobs);

		for (const row of rows) {
			const rawSnapshot = row.snapshot;
			const source = isEmptySnapshot(rawSnapshot)
				? currentDefinitions
				: rawSnapshot;
			if (!isRecord(source)) {
				throw new Error(
					`Scan job ${row.scanJobId} has an invalid pipeline definition snapshot`,
				);
			}

			const normalized = normalizePipelineDefinitionSnapshot(
				normalizeLegacyVerificationSchema(source as ScanPipelineDefinitions),
			);
			if (
				normalized.version !== 2 ||
				!Array.isArray(normalized.stages) ||
				!normalized.pipelines.full ||
				!normalized.pipelines.delta
			) {
				throw new Error(
					`Scan job ${row.scanJobId} could not be converted to a complete v2 pipeline snapshot`,
				);
			}

			processedCount += 1;
			if (JSON.stringify(rawSnapshot) !== JSON.stringify(normalized)) {
				await tx
					.update(scanJobs)
					.set({ scanPipelineDefinitionSnapshot: normalized })
					.where(eq(scanJobs.scanJobId, row.scanJobId));
				updatedCount += 1;
			}
		}
	});

	return { processedCount, updatedCount };
};
