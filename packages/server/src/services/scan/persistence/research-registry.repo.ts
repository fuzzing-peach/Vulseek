import { db } from "@vulseek/server/db";
import {
	exploitChainEvents,
	exploitChains,
	exploitPrimitiveEvents,
	exploitPrimitives,
	researchTrackEvents,
	researchTracks,
	vulnerabilityCandidates,
} from "@vulseek/server/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { readTaskJsonArtifact } from "../artifacts/task-artifact-paths";
import { candidateSchema } from "../artifacts/contracts/domain-object.contract";
import type { StageContext } from "../stages/full-scan-stage.runtime";

type JsonRecord = Record<string, unknown>;
type RegistryDb = Pick<typeof db, "select" | "insert" | "update">;
type ResearchRegistryOperation =
	| "persist-scope"
	| "persist-track-plan"
	| "apply-track-review"
	| "record-discovery"
	| "record-finding-validation"
	| "record-finding-review"
	| "persist-chain"
	| "apply-chain-review"
	| "record-exploit-validation"
	| "apply-exploit-review"
	| "persist-report";

const asRecord = (value: unknown): JsonRecord =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as JsonRecord)
		: {};

const asString = (value: unknown) =>
	typeof value === "string" && value.trim() ? value.trim() : null;

const asStringArray = (value: unknown) =>
	Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];

const readManifest = async (ctx: StageContext, pathValue: unknown) => {
	const path = asString(pathValue);
	if (!path) return {};
	return asRecord(
		await readTaskJsonArtifact({
			taskDir: await ctx.taskDir(),
			containerPath: path,
		}),
	);
};

const eventKey = (
	ctx: StageContext,
	operation: string,
	entity: string,
	expectedRevision: number | null,
) => `${ctx.scanJobId}:${ctx.taskId}:${operation}:${entity}:${expectedRevision ?? "initial"}`;

const persistTrackEvent = async (input: {
	db: RegistryDb;
	scanJobId: string;
	trackId: string;
	trackKey: string;
	operation: string;
	payload: JsonRecord;
	evidenceRefs?: string[];
	expectedRevision: number | null;
	resultingRevision: number;
	ctx: StageContext;
}) => {
	await input.db
		.insert(researchTrackEvents)
		.values({
			eventId: nanoid(),
			scanJobId: input.scanJobId,
			trackId: input.trackId,
			eventType: input.operation,
			actorTaskId: input.ctx.taskId,
			sourceStage: input.ctx.stageName,
			expectedRevision: input.expectedRevision,
			resultingRevision: input.resultingRevision,
			payload: input.payload,
			evidenceRefs: input.evidenceRefs ?? [],
			idempotencyKey: eventKey(
				input.ctx,
				input.operation,
				input.trackKey,
				input.expectedRevision,
			),
		createdAt: new Date().toISOString(),
		})
		.onConflictDoNothing({ target: researchTrackEvents.idempotencyKey });
};

const upsertTrack = async (
	db: RegistryDb,
	ctx: StageContext,
	value: JsonRecord,
) => {
	const trackKey = asString(value.trackKey) ?? asString(value.id) ?? nanoid();
	const [existing] = await db
		.select()
		.from(researchTracks)
		.where(
			and(
				eq(researchTracks.scanJobId, ctx.scanJobId),
				eq(researchTracks.trackKey, trackKey),
			),
		)
		.limit(1);
	const now = new Date().toISOString();
	const fields = {
		approachFamily: asString(value.approachFamily) ?? "unclassified",
		researchIdea: asString(value.researchIdea) ?? asString(value.idea) ?? trackKey,
		scope: asRecord(value.scope),
		mechanisms: asStringArray(value.mechanisms),
		status: asString(value.status) ?? "queued",
		coverage: asRecord(value.coverage),
		evidenceRefs: asStringArray(value.evidenceRefs),
		candidateFindingIds: asStringArray(value.candidateFindingIds),
		blockReason: asString(value.blockReason),
		reopenCondition: asString(value.reopenCondition),
		nextStep: asString(value.nextStep),
		iteration: typeof value.iteration === "number" ? value.iteration : 0,
		updatedAt: now,
	};
	const trackId = existing?.trackId ?? nanoid();
	if (existing) {
		const updated = await db
			.update(researchTracks)
			.set({ ...fields, revision: existing.revision + 1 })
			.where(
				and(
					eq(researchTracks.trackId, trackId),
					eq(researchTracks.revision, existing.revision),
				),
			)
			.returning({ trackId: researchTracks.trackId });
		if (updated.length === 0) {
			throw new Error(`Research track revision conflict: ${trackKey}`);
		}
	} else {
		await db.insert(researchTracks).values({
			trackId,
			scanJobId: ctx.scanJobId,
			trackKey,
			...fields,
			revision: 0,
			createdAt: now,
		});
	}
	return {
		trackId,
		trackKey,
		previousRevision: existing?.revision ?? null,
		revision: existing ? existing.revision + 1 : 0,
	};
};

export const applyResearchRegistryEffect = async (input: {
	ctx: StageContext;
	operation: ResearchRegistryOperation;
	stageInput: unknown;
	output: unknown;
}) => await db.transaction(async (tx) => {
	const output = asRecord(input.output);
	const stageInput = asRecord(input.stageInput);
	const ctx = input.ctx;
	if (input.operation === "persist-scope") {
		const scope = await readManifest(ctx, output.scopePath);
		const track = await upsertTrack(tx, ctx, {
			trackKey: "__scope__",
			approachFamily: "scope",
			researchIdea: "attacker-model-and-trust-boundary",
			scope,
			status: "active",
		});
		await persistTrackEvent({
			db: tx,
			ctx,
			scanJobId: ctx.scanJobId,
			trackId: track.trackId,
			trackKey: track.trackKey,
				operation: input.operation,
				payload: scope,
				expectedRevision: track.previousRevision,
				resultingRevision: track.revision,
			});
		return;
	}
	if (input.operation === "persist-track-plan") {
		const tracks = Array.isArray(output.tracks) ? output.tracks : [];
		for (const value of tracks) {
			const track = await upsertTrack(tx, ctx, asRecord(value));
			await persistTrackEvent({
				db: tx,
				ctx,
				scanJobId: ctx.scanJobId,
				trackId: track.trackId,
				trackKey: track.trackKey,
				operation: input.operation,
				payload: asRecord(value),
				evidenceRefs: asStringArray(asRecord(value).evidenceRefs),
				expectedRevision: track.previousRevision,
				resultingRevision: track.revision,
			});
		}
		return;
	}
	const track = asRecord(stageInput.track);
	const trackKey =
		asString(stageInput.trackId) ??
		asString(stageInput.trackKey) ??
		asString(track.trackId) ??
		asString(track.trackKey);
	if (trackKey) {
		const track = await upsertTrack(tx, ctx, {
			trackKey,
			status: asString(output.status) ?? asString(output.decision) ?? "active",
			candidateFindingIds: output.candidateFindingIds,
			evidenceRefs: output.evidenceRefs,
			coverage: output.coverage,
		});
		await persistTrackEvent({
			db: tx,
			ctx,
			scanJobId: ctx.scanJobId,
			trackId: track.trackId,
			trackKey: track.trackKey,
			operation: input.operation,
			payload: { input: stageInput, output },
			evidenceRefs: asStringArray(output.evidenceRefs),
			expectedRevision: track.previousRevision,
			resultingRevision: track.revision,
		});
	}
	if (input.operation === "record-discovery") {
		const report = await readManifest(ctx, output.discoveryReportPath);
		const candidates = Array.isArray(report.candidateFindings)
			? report.candidateFindings
			: [];
		const now = new Date().toISOString();
		for (const rawCandidate of candidates) {
			const candidate = candidateSchema.parse(rawCandidate);
			await tx
				.insert(vulnerabilityCandidates)
				.values({
					vulnerabilityCandidateId: candidate.id,
					scanJobId: ctx.scanJobId,
					producerTaskId: ctx.taskId,
					producerStageName: "vulnerability-discovery",
					functionId: candidate.functionId,
					title: candidate.title,
					description: candidate.description,
					filePath: candidate.filePath,
					line: candidate.line,
					vulnerabilityType: candidate.vulnerabilityType,
					confidence: candidate.confidence,
					score: candidate.score,
					targetId: candidate.targetId ?? null,
					targetKind: candidate.targetKind ?? null,
					claim: candidate.claim,
					rootCauseKey: candidate.rootCauseKey,
					evidence: candidate.evidence,
					attackerControl: candidate.attackerControl,
					affectedSink: candidate.affectedSink,
					preconditions: candidate.preconditions,
					quickDisproofAttempt: candidate.quickDisproofAttempt,
					needsFuzzing: candidate.needsFuzzing,
					needsManualAnalysis: candidate.needsManualAnalysis,
					createdAt: now,
					updatedAt: now,
				})
				.onConflictDoUpdate({
					target: [
						vulnerabilityCandidates.scanJobId,
						vulnerabilityCandidates.vulnerabilityCandidateId,
					],
					set: {
						producerTaskId: ctx.taskId,
						updatedAt: now,
						title: candidate.title,
						description: candidate.description,
						evidence: candidate.evidence,
					},
				});
		}
		return;
	}
	if (input.operation === "record-finding-review") {
		const primitive = asRecord(output.confirmedPrimitive);
		const candidateId = asString(output.candidateId) ?? asString(stageInput.candidateId);
		if (candidateId && Object.keys(primitive).length > 0) {
			const primitiveId =
				asString(primitive.primitiveId) ??
				`primitive-${candidateId}-${asString(primitive.name) ?? "default"}`;
			const now = new Date().toISOString();
			const [existingPrimitive] = await tx
				.select({ revision: exploitPrimitives.revision })
				.from(exploitPrimitives)
				.where(
					and(
						eq(exploitPrimitives.primitiveId, primitiveId),
						eq(exploitPrimitives.scanJobId, ctx.scanJobId),
					),
				)
				.limit(1);
			const expectedRevision = existingPrimitive?.revision ?? null;
			const resultingRevision = expectedRevision === null ? 0 : expectedRevision + 1;
			await tx
				.insert(exploitPrimitives)
				.values({
				primitiveId,
				scanJobId: ctx.scanJobId,
				candidateId,
				name: asString(primitive.name) ?? candidateId,
				capability: asString(primitive.capability) ?? "unclassified",
				requiredInput: asRecord(primitive.requiredInput),
				producedCapability: asRecord(primitive.producedCapability),
				trustLevel: asString(primitive.trustLevel) ?? "unknown",
				status: "confirmed",
				evidenceRefs: asStringArray(primitive.evidenceRefs),
				createdAt: now,
				updatedAt: now,
				})
				.onConflictDoUpdate({
					target: exploitPrimitives.primitiveId,
					set: {
						name: asString(primitive.name) ?? candidateId,
						capability: asString(primitive.capability) ?? "unclassified",
						requiredInput: asRecord(primitive.requiredInput),
						producedCapability: asRecord(primitive.producedCapability),
						trustLevel: asString(primitive.trustLevel) ?? "unknown",
						status: "confirmed",
						evidenceRefs: asStringArray(primitive.evidenceRefs),
						revision: sql`${exploitPrimitives.revision} + 1`,
						updatedAt: now,
					},
				});
				await tx
				.insert(exploitPrimitiveEvents)
				.values({
					eventId: nanoid(),
					scanJobId: ctx.scanJobId,
					primitiveId,
					eventType: input.operation,
					actorTaskId: ctx.taskId,
					sourceStage: ctx.stageName,
					expectedRevision,
					resultingRevision,
					payload: primitive,
					evidenceRefs: asStringArray(primitive.evidenceRefs),
					idempotencyKey: eventKey(
						ctx,
						input.operation,
						candidateId,
						expectedRevision,
					),
					createdAt: now,
				})
				.onConflictDoNothing({ target: exploitPrimitiveEvents.idempotencyKey });
		}
		return;
	}
	if (input.operation === "persist-report") {
		const reportChain = asRecord(stageInput.chain);
		const chainId =
			asString(output.chainId) ??
			asString(stageInput.chainId) ??
			asString(reportChain.chainId);
		if (!chainId) return;
		const now = new Date().toISOString();
		const [existingChain] = await tx
			.select({ revision: exploitChains.revision })
			.from(exploitChains)
			.where(
				and(
					eq(exploitChains.chainId, chainId),
					eq(exploitChains.scanJobId, ctx.scanJobId),
				),
			)
			.limit(1);
		const expectedRevision = existingChain?.revision ?? null;
		const resultingRevision = expectedRevision === null ? 0 : expectedRevision + 1;
		await tx
			.update(exploitChains)
			.set({
				status: asString(output.verdict) ?? "reported",
				updatedAt: now,
				revision: resultingRevision,
			})
			.where(and(eq(exploitChains.chainId, chainId), eq(exploitChains.scanJobId, ctx.scanJobId)));
		await tx
			.insert(exploitChainEvents)
			.values({
				eventId: nanoid(),
				scanJobId: ctx.scanJobId,
				chainId,
				eventType: input.operation,
				actorTaskId: ctx.taskId,
				sourceStage: ctx.stageName,
				expectedRevision,
				resultingRevision,
				payload: { input: stageInput, output },
				evidenceRefs: asStringArray(output.evidenceRefs),
				idempotencyKey: eventKey(
					ctx,
					input.operation,
					chainId,
					expectedRevision,
				),
				createdAt: now,
			})
			.onConflictDoNothing({ target: exploitChainEvents.idempotencyKey });
		return;
	}
	if (input.operation.includes("finding")) return;
	if (input.operation.includes("chain")) {
		const chainValues = input.operation === "persist-chain" && Array.isArray(output.chains)
			? output.chains.map(asRecord)
			: [output];
		for (const chainValue of chainValues) {
			const chainInput = asRecord(stageInput.chain);
			const chainId =
				asString(chainValue.chainId) ??
				asString(stageInput.chainId) ??
				asString(chainInput.chainId) ??
				nanoid();
			const chainKey = asString(chainValue.chainKey) ?? chainId;
			const now = new Date().toISOString();
			const [existingChain] = await tx
				.select({ revision: exploitChains.revision })
				.from(exploitChains)
				.where(
					and(
						eq(exploitChains.chainId, chainId),
						eq(exploitChains.scanJobId, ctx.scanJobId),
					),
				)
				.limit(1);
			const expectedRevision = existingChain?.revision ?? null;
			const resultingRevision = expectedRevision === null ? 0 : expectedRevision + 1;
			await tx
				.insert(exploitChains)
				.values({
					chainId,
					scanJobId: ctx.scanJobId,
					chainKey,
					status:
						asString(chainValue.status) ??
						asString(chainValue.decision) ??
						"candidate",
					steps: Array.isArray(chainValue.steps)
						? (chainValue.steps as JsonRecord[])
						: [],
					entrypoint: asRecord(chainValue.entrypoint),
					requiredCapabilities: asStringArray(chainValue.requiredCapabilities),
					producedCapabilities: asStringArray(chainValue.producedCapabilities),
					trustBoundaryCrossings: Array.isArray(chainValue.trustBoundaryCrossings)
						? (chainValue.trustBoundaryCrossings as JsonRecord[])
						: [],
					deploymentConditions: asStringArray(chainValue.deploymentConditions),
					primitiveGaps: Array.isArray(chainValue.primitiveGaps)
						? (chainValue.primitiveGaps as JsonRecord[])
						: [],
					successTarget: asRecord(chainValue.successTarget),
					createdAt: now,
					updatedAt: now,
				})
				.onConflictDoUpdate({
					target: exploitChains.chainId,
					set: {
						chainKey,
						status:
							asString(chainValue.status) ??
							asString(chainValue.decision) ??
							"candidate",
						steps: Array.isArray(chainValue.steps)
							? (chainValue.steps as JsonRecord[])
							: [],
						entrypoint: asRecord(chainValue.entrypoint),
						requiredCapabilities: asStringArray(chainValue.requiredCapabilities),
						producedCapabilities: asStringArray(chainValue.producedCapabilities),
						trustBoundaryCrossings: Array.isArray(chainValue.trustBoundaryCrossings)
							? (chainValue.trustBoundaryCrossings as JsonRecord[])
							: [],
						deploymentConditions: asStringArray(chainValue.deploymentConditions),
						primitiveGaps: Array.isArray(chainValue.primitiveGaps)
							? (chainValue.primitiveGaps as JsonRecord[])
							: [],
						successTarget: asRecord(chainValue.successTarget),
						revision: sql`${exploitChains.revision} + 1`,
						updatedAt: now,
					},
				});
			await tx
				.insert(exploitChainEvents)
				.values({
					eventId: nanoid(),
					scanJobId: ctx.scanJobId,
					chainId,
					eventType: input.operation,
					actorTaskId: ctx.taskId,
					sourceStage: ctx.stageName,
					expectedRevision,
					resultingRevision,
					payload: { input: stageInput, output: chainValue },
					evidenceRefs: asStringArray(chainValue.evidenceRefs),
					idempotencyKey: eventKey(
						ctx,
						input.operation,
						chainKey,
						expectedRevision,
					),
					createdAt: now,
				})
				.onConflictDoNothing({ target: exploitChainEvents.idempotencyKey });
		}
	}
});
