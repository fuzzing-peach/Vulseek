# Research Entity-Local Review Concurrency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Research review stages safe to run concurrently by limiting each review task to its current primary entity, while keeping `track-plan` serial as the only global Track portfolio planner.

**Architecture:** Add an entity-claim layer keyed by `scanJobId + stageName + entityType + entityKey + expectedRevision`, then narrow review-stage outputs and registry effects so a task only mutates the entity it was launched to review. `track-plan`, `surface-map`, and `chain-synthesis` remain serial global stages; they own portfolio-wide creation, deduplication, ranking, and synthesis.

**Tech Stack:** TypeScript, Drizzle, PostgreSQL transactions, YAML pipeline definitions, JSON Schema contracts, Node test runner, existing Research Registry repositories.

## Global Constraints

- Do not parallelize `track-plan`, `surface-map`, or `chain-synthesis` in this first version.
- Do not let `track-review` create, block, exhaust, rank, or otherwise mutate any Track except the current task's Track.
- Keep global Track creation, deduplication, ordering, and adjustment in serial `track-plan`.
- Keep LLM agents as task consumers; database writes for registry state remain TypeScript pipeline effects.
- Do not introduce fallback behavior from old Candidate structures or old TrackReview bucket outputs.
- Preserve existing dynamic route envelope format: `{"route": "...", "exit": false, "output": {...}}`.
- New jobs use the updated external Research YAML and schemas; historical job snapshots are not rewritten.

---

## File Structure

- Modify `packages/server/src/db/schema.ts`: add `research_entity_claims` table and indexes.
- Create `apps/dokploy/drizzle/<timestamp>_research_entity_claims.sql`: migration for the claim table.
- Create `packages/server/src/services/scan/persistence/research-entity-claim.repo.ts`: claim acquisition, completion, lease renewal, release, and stale claim reset helpers.
- Modify `packages/server/src/services/scan/persistence/research-registry-state.ts`: replace bucket-based TrackReview status resolution with decision-based validation helpers.
- Modify `packages/server/src/services/scan/persistence/research-registry.repo.ts`: make `apply-track-review` update only the current Track and add route/decision checks.
- Modify `packages/server/src/services/scan/stages/generic-agent.stage.ts`: pass terminal route metadata to research registry effects.
- Modify `packages/server/src/services/scan/pipeline/pipeline-runner.ts`: pass `routeKey` through `stage.onSuccess`.
- Modify `packages/server/src/services/scan/pipeline/definitions/schemas/research.yaml`: replace `TrackReview` schema with current-track decision output.
- Modify `packages/server/src/services/scan/pipeline/definitions/stages/research.yaml`: keep `track-plan` serial; raise only entity-local stage concurrency after claim coverage exists.
- Modify `packages/server/src/services/scan/pipeline/definitions/pipelines/research.yaml`: add an explicit `blocked` route from `track-review` to `track-plan`.
- Modify `packages/server/src/services/scan/prompts/track-review.prompt.md`: instruct the agent to review only the current Track and return a local decision.
- Modify `packages/server/src/services/scan/prompts/track-plan.prompt.md`: clarify that Track portfolio changes are owned by this serial stage.
- Test `packages/server/src/services/scan/persistence/research-registry-state.test.ts`: decision mapping and validation.
- Test `packages/server/src/services/scan/persistence/research-entity-claim.test.ts`: claim semantics.
- Test `packages/server/src/services/scan/persistence/research-registry.test.ts`: local TrackReview writes and cross-track rejection.
- Test `packages/server/src/services/scan/pipeline/research-deterministic-fixture.test.ts`: updated TrackReview contract and routes.
- Test `packages/server/src/services/scan/pipeline/scan-pipeline-yaml-contracts.test.ts`: schema acceptance/rejection for new and old TrackReview shapes.

## Task 1: Add Entity Claim Table

**Files:**
- Modify: `packages/server/src/db/schema.ts`
- Create: `apps/dokploy/drizzle/<timestamp>_research_entity_claims.sql`
- Create: `packages/server/src/services/scan/persistence/research-entity-claim.repo.ts`
- Test: `packages/server/src/services/scan/persistence/research-entity-claim.test.ts`

**Interfaces:**
- Produces: `claimResearchEntity(input): Promise<ResearchEntityClaim | null>`
- Produces: `completeResearchEntityClaim(input): Promise<boolean>`
- Produces: `failResearchEntityClaim(input): Promise<boolean>`
- Produces: `resetExpiredResearchEntityClaims(input): Promise<number>`
- Consumes: existing task ID, scan job ID, stage name, and entity revision values.

- [x] **Step 1: Write the failing claim repository tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
	claimResearchEntity,
	completeResearchEntityClaim,
	resetExpiredResearchEntityClaims,
} from "./research-entity-claim.repo";

test("claims one entity revision once per stage", async () => {
	const first = await claimResearchEntity({
		scanJobId: "job-a",
		stageName: "track-review",
		entityType: "track",
		entityKey: "track-a",
		expectedRevision: 3,
		taskId: "task-a",
		leaseMs: 60_000,
	});
	const second = await claimResearchEntity({
		scanJobId: "job-a",
		stageName: "track-review",
		entityType: "track",
		entityKey: "track-a",
		expectedRevision: 3,
		taskId: "task-b",
		leaseMs: 60_000,
	});

	assert.ok(first);
	assert.equal(second, null);
});

test("allows different entities and later revisions to claim independently", async () => {
	assert.ok(await claimResearchEntity({
		scanJobId: "job-a",
		stageName: "track-review",
		entityType: "track",
		entityKey: "track-a",
		expectedRevision: 4,
		taskId: "task-c",
		leaseMs: 60_000,
	}));
	assert.ok(await claimResearchEntity({
		scanJobId: "job-a",
		stageName: "track-review",
		entityType: "track",
		entityKey: "track-b",
		expectedRevision: 3,
		taskId: "task-d",
		leaseMs: 60_000,
	}));
});

test("does not complete a claim owned by another task", async () => {
	await claimResearchEntity({
		scanJobId: "job-a",
		stageName: "track-review",
		entityType: "track",
		entityKey: "track-c",
		expectedRevision: 1,
		taskId: "owner-task",
		leaseMs: 60_000,
	});

	assert.equal(await completeResearchEntityClaim({
		scanJobId: "job-a",
		stageName: "track-review",
		entityType: "track",
		entityKey: "track-c",
		expectedRevision: 1,
		taskId: "other-task",
	}), false);
});
```

- [x] **Step 2: Add schema and migration**

Create a table with these columns:

```ts
export const researchEntityClaims = pgTable(
	"research_entity_claims",
	{
		scanJobId: text("scan_job_id").notNull(),
		stageName: text("stage_name").notNull(),
		entityType: text("entity_type").notNull(),
		entityKey: text("entity_key").notNull(),
		expectedRevision: integer("expected_revision").notNull(),
		taskId: text("task_id").notNull(),
		status: text("status").notNull().default("claimed"),
		claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }).notNull(),
		completedAt: timestamp("completed_at", { withTimezone: true }),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => ({
		pk: primaryKey({
			columns: [
				table.scanJobId,
				table.stageName,
				table.entityType,
				table.entityKey,
				table.expectedRevision,
			],
		}),
		taskIdx: index("research_entity_claims_task_idx").on(table.taskId),
		activeIdx: index("research_entity_claims_active_idx").on(
			table.scanJobId,
			table.stageName,
			table.status,
		),
	}),
);
```

- [x] **Step 3: Implement repository helpers**

`claimResearchEntity()` inserts a `claimed` row. If the unique key already exists with `completed` or unexpired `claimed`, return `null`. If it exists with expired `claimed` or `failed`, update it to the new task ID and lease in one conditional statement.

Renew leases for task IDs that are still active before resetting expired claims, so a long-running agent cannot lose its entity claim while it is still executing.

- [x] **Step 4: Run the focused tests**

Run: `pnpm --filter vulseek test -- research-entity-claim`

Expected: the new claim tests pass and no existing Research tests fail.

## Task 2: Replace TrackReview Bucket Contract

**Files:**
- Modify: `packages/server/src/services/scan/pipeline/definitions/schemas/research.yaml`
- Modify: `packages/server/src/services/scan/prompts/track-review.prompt.md`
- Modify: `packages/server/src/services/scan/persistence/research-registry-state.ts`
- Test: `packages/server/src/services/scan/persistence/research-registry-state.test.ts`
- Test: `packages/server/src/services/scan/pipeline/scan-pipeline-yaml-contracts.test.ts`

**Interfaces:**
- Produces: `ResearchTrackReviewOutput` with `trackKey`, `decision`, `summary`, `findingIds`, `coverageGaps`, `nextStep`, `blockReason`, and `reopenCondition`.
- Produces: `resolveTrackReviewStatus(output): "active" | "finding-found" | "blocked" | "exhausted"`.
- Produces: `validateTrackReviewDecision(output, routeKey): void`.

- [x] **Step 1: Write failing schema and state tests**

```ts
test("accepts current-track TrackReview decision output", () => {
	const output = {
		trackKey: "track-a",
		decision: "finding-found",
		summary: "Two owned findings are ready for validation.",
		findingIds: ["track-a:finding-1", "track-a:finding-2"],
		coverageGaps: [],
		nextStep: "Validate both findings.",
		blockReason: null,
		reopenCondition: null,
	};

	validateJsonSchemaContract(trackReviewContract, output);
});

test("rejects legacy TrackReview bucket output", () => {
	assert.throws(() => validateJsonSchemaContract(trackReviewContract, {
		continueTracks: [{ trackKey: "track-a" }],
		newTracks: [],
		blockedTracks: [],
		exhaustedTracks: [],
		findingIds: [],
		coverageGaps: [],
	}));
});
```

- [x] **Step 2: Replace `TrackReview` schema**

Use this YAML shape:

```yaml
TrackReview:
  type: object
  additionalProperties: false
  properties:
    trackKey: { type: string, minLength: 1 }
    decision:
      type: string
      enum: [continue, finding-found, new-surface, blocked, exhausted]
    summary: { type: string, minLength: 1 }
    findingIds: { type: array, items: { type: string } }
    coverageGaps: { type: array, items: { type: string } }
    nextStep:
      anyOf:
        - { type: string, minLength: 1 }
        - { type: "null" }
    blockReason:
      anyOf:
        - { type: string, minLength: 1 }
        - { type: "null" }
    reopenCondition:
      anyOf:
        - { type: string, minLength: 1 }
        - { type: "null" }
  required: [trackKey, decision, summary, findingIds, coverageGaps, nextStep, blockReason, reopenCondition]
```

- [x] **Step 3: Update the TrackReview prompt**

Make the prompt say:

```md
You review exactly one current Track. Use other tracks, findings, primitives, and chains as read-only context. Do not create, block, exhaust, rank, or update any Track except the current Track.

Return only `trackKey`, `decision`, `summary`, `findingIds`, `coverageGaps`, `nextStep`, `blockReason`, and `reopenCondition`. `trackKey` must equal the input Track key. `decision` must match the output envelope route. `findingIds` may only contain Findings owned by the current Track.
```

- [x] **Step 4: Replace bucket status resolution**

Implement decision-based mapping:

```ts
export type TrackReviewDecision =
	| "continue"
	| "finding-found"
	| "new-surface"
	| "blocked"
	| "exhausted";

export type ResearchTrackReviewOutput = {
	trackKey?: unknown;
	decision?: unknown;
	findingIds?: unknown;
	coverageGaps?: unknown;
	nextStep?: unknown;
	blockReason?: unknown;
	reopenCondition?: unknown;
};

export const resolveTrackReviewStatus = (
	output: ResearchTrackReviewOutput,
) => {
	switch (asString(output.decision)) {
		case "finding-found":
			return "finding-found";
		case "blocked":
			return "blocked";
		case "exhausted":
			return "exhausted";
		case "continue":
		case "new-surface":
			return "active";
		default:
			throw new Error("TrackReview output has invalid decision");
	}
};
```

- [x] **Step 5: Add decision invariants**

Add validation rules:

```ts
export const validateTrackReviewDecision = (
	output: ResearchTrackReviewOutput,
	routeKey: string | null,
) => {
	const decision = asString(output.decision);
	if (!decision) throw new Error("TrackReview output is missing decision");
	if (routeKey !== decision) {
		throw new Error(`TrackReview decision ${decision} does not match route ${routeKey ?? "<null>"}`);
	}
	const findingIds = asStringArray(output.findingIds);
	if (decision === "finding-found" && findingIds.length === 0) {
		throw new Error("TrackReview finding-found decision requires findingIds");
	}
	if (decision !== "finding-found" && findingIds.length > 0) {
		throw new Error("TrackReview findingIds are only allowed for finding-found");
	}
	if (decision === "blocked" && !asString(output.blockReason)) {
		throw new Error("TrackReview blocked decision requires blockReason");
	}
	if (decision === "new-surface" && asStringArray(output.coverageGaps).length === 0) {
		throw new Error("TrackReview new-surface decision requires coverageGaps");
	}
};
```

- [x] **Step 6: Run focused tests**

Run: `pnpm --filter vulseek test -- research-registry-state scan-pipeline-yaml-contracts`

Expected: new decision tests pass; legacy bucket output is rejected.

## Task 3: Pass Route Key Into Registry Effects

**Files:**
- Modify: `packages/server/src/services/scan/pipeline/pipeline-runner.ts`
- Modify: `packages/server/src/services/scan/stages/generic-agent.stage.ts`
- Modify: stage definition types if `onSuccess` signature is declared separately.
- Test: existing pipeline completion and Research deterministic fixture tests.

**Interfaces:**
- Produces: `stage.onSuccess(ctx, input, output, transaction, metadata)` where `metadata.routeKey` is `string | null`.
- Consumes: `persistTerminalSuccess()` already receives `routeKey`.

- [x] **Step 1: Write a failing test for route metadata**

Add a fixture assertion that a routed Research stage effect sees the parsed route:

```ts
assert.equal(effectMetadata.routeKey, "finding-found");
```

Use the existing deterministic fixture harness instead of adding a second runner harness.

- [x] **Step 2: Extend the lifecycle signature**

Change the success callback contract to:

```ts
type StageSuccessMetadata = {
	routeKey: string | null;
};
```

Pass `{ routeKey }` from `persistTerminalSuccess()` into `stage.onSuccess`.

- [x] **Step 3: Forward route metadata from generic agent effects**

Call:

```ts
await applyResearchRegistryEffect({
	ctx,
	operation: effect.operation,
	stageInput,
	output,
	routeKey: metadata.routeKey,
	transaction: transaction as ResearchRegistryTransaction | undefined,
});
```

- [x] **Step 4: Keep non-routed stages explicit**

For non-routed stages, pass `routeKey: null`. Existing non-routed output validation already requires `route: null`.

- [x] **Step 5: Run focused tests**

Run: `pnpm --filter vulseek test -- research-deterministic-fixture`

Expected: routed stages pass route metadata to effects; non-routed stages still pass `null`.

## Task 4: Make `apply-track-review` Local to Current Track

**Files:**
- Modify: `packages/server/src/services/scan/persistence/research-registry.repo.ts`
- Modify: `packages/server/src/services/scan/persistence/research-registry-state.ts`
- Test: `packages/server/src/services/scan/persistence/research-registry.test.ts`

**Interfaces:**
- Consumes: `routeKey` from Task 3.
- Consumes: `validateTrackReviewDecision()` from Task 2.
- Produces: registry effect that updates only the current Track row and one Track event.

- [x] **Step 1: Write failing registry tests**

```ts
test("track review updates only the current track", async () => {
	await seedTrack({ scanJobId: "job-a", trackKey: "track-a", revision: 2 });
	await seedTrack({ scanJobId: "job-a", trackKey: "track-b", revision: 7 });

	await applyResearchRegistryEffect({
		ctx: fakeResearchCtx({ scanJobId: "job-a", taskId: "task-review-a", stageName: "track-review" }),
		operation: "apply-track-review",
		stageInput: { track: { trackKey: "track-a", revision: 2 } },
		output: {
			trackKey: "track-a",
			decision: "blocked",
			summary: "The evidence contradicts this route.",
			findingIds: [],
			coverageGaps: [],
			nextStep: null,
			blockReason: "No reachable source remains.",
			reopenCondition: "Reopen only if a new source is mapped.",
		},
		routeKey: "blocked",
	});

	assert.equal((await findTrack("job-a", "track-a")).status, "blocked");
	assert.equal((await findTrack("job-a", "track-b")).revision, 7);
});

test("track review rejects output for another track", async () => {
	await assert.rejects(() => applyResearchRegistryEffect({
		ctx: fakeResearchCtx({ scanJobId: "job-a", taskId: "task-review-a", stageName: "track-review" }),
		operation: "apply-track-review",
		stageInput: { track: { trackKey: "track-a", revision: 2 } },
		output: {
			trackKey: "track-b",
			decision: "continue",
			summary: "Wrong track.",
			findingIds: [],
			coverageGaps: [],
			nextStep: "Continue.",
			blockReason: null,
			reopenCondition: null,
		},
		routeKey: "continue",
	}), /does not match current track/);
});
```

- [x] **Step 2: Remove multi-bucket writes**

Delete the loop over `continueTracks`, `newTracks`, `blockedTracks`, and `exhaustedTracks`. The effect should load only `stageInput.track`, require `output.trackKey` to match the current Track key, and call `persistReviewedTrack()` once.

- [x] **Step 3: Stop mutating Findings from TrackReview**

Remove the loop that transitions selected Findings to `selected`. TrackReview may route `finding-found` and pass `findingIds` downstream, but Finding state transitions belong to `finding-validation` and `finding-review`.

- [x] **Step 4: Enforce Finding ownership**

Before completing `finding-found`, verify every `findingId` belongs to the current Track and current scan job. Reject the whole effect if any Finding belongs to another Track.

- [x] **Step 5: Persist a current-track event**

Store the full TrackReview output as the Track event payload. Include `expectedRevision` from the existing Track and `resultingRevision` from the updated Track.

- [x] **Step 6: Run focused tests**

Run: `pnpm --filter vulseek test -- research-registry research-registry-state`

Expected: TrackReview no longer writes other Tracks or Finding statuses; cross-track Finding references are rejected.

## Task 5: Keep `track-plan` Serial and Global

**Files:**
- Modify: `packages/server/src/services/scan/pipeline/definitions/stages/research.yaml`
- Modify: `packages/server/src/services/scan/prompts/track-plan.prompt.md`
- Test: `packages/server/src/services/scan/pipeline/research-deterministic-fixture.test.ts`

**Interfaces:**
- Consumes: current Registry state and TrackReview artifacts/events.
- Produces: global Track portfolio mutations through `persist-track-plan`.

- [x] **Step 1: Assert `track-plan` remains serial**

Add or update a YAML contract test:

```ts
assert.equal(researchStages["track-plan"].runtimeConfig.mode, "serial");
assert.equal(researchStages["track-plan"].concurrency, 1);
```

- [x] **Step 2: Clarify prompt ownership**

Add wording:

```md
You are the only stage that may create new Tracks, merge duplicate Track ideas, adjust global Track ordering, and rebalance the portfolio. Treat TrackReview outputs as evidence and planning signals, not as authoritative Track mutations.
```

- [x] **Step 3: Preserve Track ownership constraints**

Keep the existing rule that `findingIds` are ownership data. For a new Track, `findingIds` must remain `[]`.

- [x] **Step 4: Run focused tests**

Run: `pnpm --filter vulseek test -- research-deterministic-fixture`

Expected: `track-plan` remains serial and still feeds `vulnerability-discovery`.

## Task 6: Update TrackReview Routes

**Files:**
- Modify: `packages/server/src/services/scan/pipeline/definitions/pipelines/research.yaml`
- Test: `packages/server/src/services/scan/pipeline/research-deterministic-fixture.test.ts`
- Test: `packages/server/src/services/scan/pipeline/pipeline-routing.test.ts`

**Interfaces:**
- Produces routes: `continue`, `new-surface`, `finding-found`, `blocked`, `exhausted`.

- [x] **Step 1: Add a `blocked` route edge**

Add an edge from `track-review` to `track-plan`:

```yaml
- name: track-review-blocked-to-track-plan
  from: track-review
  to: track-plan
  mode: map
  route:
    key: blocked
  input:
    scopePath: "$input.scopePath"
    surfaceMapPath: "$input.surfaceMapPath"
  artifacts:
    - from: "$input.scopePath"
      to: inputs/scope.json
      inputField: scopePath
    - from: "$input.surfaceMapPath"
      to: inputs/surface-map.json
      inputField: surfaceMapPath
    - from: "$output"
      to: inputs/track-review.json
      inputField: reviewPath
```

- [x] **Step 2: Keep existing route destinations**

Keep `continue` and `exhausted` routing to `track-plan`, `new-surface` routing to `surface-map`, and `finding-found` fanout routing to `finding-validation`.

- [x] **Step 3: Update expected route list**

Include `blocked` in `EXPECTED_ROUTES` in the deterministic fixture test.

- [x] **Step 4: Run route tests**

Run: `pnpm --filter vulseek test -- research-deterministic-fixture pipeline-routing`

Expected: every TrackReview decision has exactly one route edge; duplicate route keys are rejected by existing route validation.

## Task 7: Apply Entity Claims to Review Stages

**Files:**
- Modify: Research task dispatch or launch path in `packages/server/src/services/scan/pipeline/pipeline-runner.ts`
- Modify: stage input extraction helpers if entity keys are resolved there.
- Test: `packages/server/src/services/scan/pipeline/research-runtime-recovery.test.ts`
- Test: `packages/server/src/services/scan/pipeline/research-dispatch-recovery.test.ts`

**Interfaces:**
- Consumes: `claimResearchEntity()` from Task 1.
- Produces: one active task per entity revision per stage.

- [x] **Step 1: Define claimable stage mapping**

Use this mapping:

```ts
const RESEARCH_ENTITY_CLAIM_STAGES = {
	"track-review": { entityType: "track", inputPath: ["track"] },
	"vulnerability-discovery": { entityType: "track", inputPath: ["track"] },
	"finding-validation": { entityType: "finding", inputPath: ["findingId"] },
	"finding-review": { entityType: "finding", inputPath: ["findingId"] },
	"chain-review": { entityType: "chain", inputPath: ["chainId"] },
	"exploit-validation": { entityType: "chain", inputPath: ["chainId"] },
	"exploit-review": { entityType: "chain", inputPath: ["chainId"] },
	"research-report": { entityType: "chain", inputPath: ["chainId"] },
} as const;
```

Do not include `surface-map`, `track-plan`, or `chain-synthesis`.

- [x] **Step 2: Acquire claim before enqueue or launch**

When a claimable stage is about to create or launch a task, resolve `entityKey` and `expectedRevision` from the task input or the corresponding registry row. If the claim returns `null`, skip creating the duplicate task.

- [x] **Step 3: Complete claim after successful registry effect**

After the registry effect commits, mark the claim `completed`. If the task fails before registry effect, mark it `failed` so retry logic can claim the same entity revision again.

Before applying a runtime registry effect, verify that the task still owns a `claimed` row with the same `expectedRevision` as the current registry entity. If the entity revision has advanced, reject the stale completion without mutating the entity or appending an event.

- [x] **Step 4: Reset expired claims during runtime recovery**

At the beginning of each runtime loop, call `resetExpiredResearchEntityClaims({ scanJobId })`. This allows recovery after process death without requiring multi-instance coordination.

The loop renews claims from the previous active-task snapshot before this reset, and refreshes the snapshot after each iteration.

- [x] **Step 5: Run recovery tests**

Run: `pnpm --filter vulseek test -- research-runtime-recovery research-dispatch-recovery`

Expected: duplicate task creation is prevented for the same entity revision; recovery can retry failed or expired claims.

## Task 8: Raise Concurrency Only for Local Review Stages

**Files:**
- Modify: `packages/server/src/services/scan/pipeline/definitions/stages/research.yaml`
- Test: `packages/server/src/services/scan/pipeline/research-deterministic-fixture.test.ts`

**Interfaces:**
- Consumes: claim coverage from Task 7.
- Produces: higher concurrency for entity-local stages without global Track races.

- [x] **Step 1: Keep global stages serial**

Keep these values:

```yaml
surface-map:
  concurrency: 1
  runtimeConfig:
    mode: serial
track-plan:
  concurrency: 1
  runtimeConfig:
    mode: serial
chain-synthesis:
  concurrency: 1
  runtimeConfig:
    mode: serial
```

- [x] **Step 2: Raise entity-local stages**

After claim tests pass, set local stage concurrency to practical defaults:

```yaml
vulnerability-discovery:
  concurrency: 8
track-review:
  concurrency: 4
finding-validation:
  concurrency: 8
finding-review:
  concurrency: 4
chain-review:
  concurrency: 4
exploit-validation:
  concurrency: 4
exploit-review:
  concurrency: 4
research-report:
  concurrency: 2
```

- [x] **Step 3: Run fixture tests**

Run: `pnpm --filter vulseek test -- research-deterministic-fixture`

Expected: fixture still reaches Research Report and every entity-local stage has claim protection.

## Task 9: Align Chain and Exploit Review Responsibility

**Files:**
- Modify: `packages/server/src/services/scan/persistence/research-registry.repo.ts`
- Modify: `packages/server/src/services/scan/pipeline/definitions/schemas/research.yaml`
- Modify: `packages/server/src/services/scan/prompts/chain-review.prompt.md`
- Modify: `packages/server/src/services/scan/prompts/exploit-review.prompt.md`
- Test: `packages/server/src/services/scan/persistence/research-registry.test.ts`

**Interfaces:**
- Produces: review effects that mutate only the reviewed Chain.
- Leaves Finding revalidation to existing `finding-validation` downstream routes.

- [x] **Step 1: Write failing cross-entity mutation tests**

Assert that `chain-review` and `exploit-review` do not directly invalidate or modify a Finding row. They may route `invalid-finding` or `finding-revalidation` and pass the Finding ID to the downstream Finding stage.

- [x] **Step 2: Remove direct Finding mutation from chain/exploit review effects**

Keep Chain status/revision/event writes. Remove direct Finding state transitions from these review effects.

- [x] **Step 3: Validate referenced Finding ownership**

If a Chain or Exploit review references a Finding ID, require that the Finding belongs to the same scan job. Do not change its status in the review effect.

- [x] **Step 4: Run focused registry tests**

Run: `pnpm --filter vulseek test -- research-registry`

Expected: Chain and Exploit reviews remain local to the Chain entity.

## Task 10: Full Verification

**Files:**
- No new files.

**Interfaces:**
- Consumes all previous tasks.
- Produces verified implementation ready for a dev Research scan.

- [x] **Step 1: Run unit and contract tests**

Run:

```bash
pnpm --filter vulseek test -- research-registry-state
pnpm --filter vulseek test -- research-entity-claim
pnpm --filter vulseek test -- research-registry
pnpm --filter vulseek test -- research-deterministic-fixture
pnpm --filter vulseek test -- scan-pipeline-yaml-contracts
```

Expected: all targeted tests pass.

- [x] **Step 2: Run type checks**

Run:

```bash
pnpm --filter @vulseek/server typecheck
pnpm --filter vulseek typecheck
```

Expected: both type checks pass.

- [x] **Step 3: Run formatting diff check**

Run:

```bash
git diff --check
```

Expected: no whitespace errors.

- [x] **Step 4: Run a short dev Research scan**

Start one dev Research scan and observe until at least one `track-review` completes. Confirm:

```text
track-review can run concurrently across different tracks
track-plan remains serial
TrackReview output only contains current-track decision fields
no TrackReview task mutates another Track
finding-found routes create Finding Validation tasks
blocked and exhausted routes return to TrackPlan
new-surface routes to Surface Map
```

- [x] **Step 5: Inspect database state**

Run SQL against the dev database:

```sql
select stage_name, entity_type, entity_key, expected_revision, status, count(*)
from research_entity_claims
where scan_job_id = '<dev-research-job-id>'
group by stage_name, entity_type, entity_key, expected_revision, status
order by stage_name, entity_key, expected_revision;
```

Expected: no duplicate claim rows for the same primary key; completed local review tasks have completed claims.

Also verify that a stale task completion is rejected after another revision is committed, while direct deterministic fixtures without a runtime claim remain supported.

- [ ] **Step 6: Commit**

Use a focused commit:

```bash
git add packages/server/src apps/dokploy/drizzle plans/research-entity-local-review-concurrency.md
git commit -m "feat(research): constrain review stages to local entities"
```
