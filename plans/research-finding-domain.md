# Research Finding Domain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Research Scan its own strict `Finding` domain, database projection, event history, APIs, and UI while leaving Full Scan and Delta Scan Candidate behavior unchanged.

**Architecture:** Research discovery writes a schema-validated `DiscoveryReport.findings` artifact. TypeScript persistence projects those findings into `research_findings` and appends idempotent `research_finding_events` in the same transaction. Every later Research stage references `findingId`; Research APIs and UI read only the new tables, with no Candidate fallback or historical backfill.

**Tech Stack:** TypeScript, Drizzle ORM, PostgreSQL, YAML/JSON Schema pipeline definitions, tRPC, Next.js, React, Vitest.

## Global Constraints

- This change applies only to Research Scan; Full Scan and Delta Scan continue using `vulnerability_candidates` and `candidate_result_projections`.
- Do not backfill existing Research jobs and do not provide aliases or fallback reads for old Candidate-shaped Research artifacts.
- Existing Research jobs whose snapshots use the old contract must be canceled or allowed to end; validation uses a newly created Research job.
- Apply and verify the migration in dev only. Do not connect to, migrate, restart, or otherwise modify release.
- A task must not complete successfully if its referenced Finding artifact fails schema validation or cannot be persisted.
- Projection changes and append-only events must be committed in one transaction and be idempotent under task retries.

---

## Data Contracts

The canonical Research `Finding` has these fields:

```ts
type ResearchFindingArtifact = {
	findingId: string; // Stable within one job: `${trackKey}:${rootCauseKey}`
	trackKey: string;
	title: string;
	description: string;
	vulnerabilityClass: string | null;
	location: {
		filePath: string;
		line: number | null;
		symbol: string | null;
	};
	claim: string;
	rootCauseKey: string;
	source: Record<string, unknown>;
	sink: Record<string, unknown>;
	attackerControl: string;
	trustBoundaryCrossings: Record<string, unknown>[];
	preconditions: string[];
	evidence: Array<{
		id: string;
		kind: string;
		summary: string;
		filePath: string | null;
		line: number | null;
		symbol: string | null;
		observation: string;
		supports: string[];
		contradicts: string[];
	}>;
	quickDisproofAttempt: string;
	confidence: number; // 0 through 1
};
```

Allowed projection states are:

```text
discovered -> selected -> validated -> confirmed
                              |-------> needs-more-evidence
                              |-------> false-positive
confirmed -> invalidated
```

Allowed event types are `discovered`, `selected`, `validated`, `reviewed`, and `invalidated`.

## Task 1: Define And Enforce The Finding Artifact

**Files:**
- Modify: `packages/server/src/services/scan/pipeline/definitions/schemas/research.yaml`
- Modify: `packages/server/src/services/scan/pipeline/definitions/stages/research.yaml`
- Test: `apps/vulseek/__test__/scan/research-pipeline-contract.test.ts`
- Test: `apps/vulseek/__test__/scan/research-pipeline-artifacts.test.ts`
- Test: `packages/server/src/services/scan/pipeline/scan-pipeline-schema-contracts.test.ts`

**Interfaces:**
- Produces: JSON Schema `Finding`, `DiscoveryReport.findings: Finding[]`, and `DiscoveryManifest.discoveryReportPath` with `$pathOf: "#/schemas/DiscoveryReport"`.
- Consumes: Existing pipeline artifact validation in `scan-pipeline-schema-contracts.ts`.

- [ ] **Step 1: Add failing contract tests**

Cover one valid Finding, missing required fields, unknown fields, confidence outside `0..1`, malformed evidence, duplicate `findingId` values, and old fields such as `candidateFindings` or `candidateId`.

- [ ] **Step 2: Run the focused tests and confirm failure**

```bash
pnpm --filter vulseek test -- research-pipeline-contract research-pipeline-artifacts
pnpm --filter @vulseek/server test -- scan-pipeline-schema-contracts
```

Expected: old Candidate-shaped contracts are still accepted or the new Finding contract is missing.

- [ ] **Step 3: Implement the strict YAML schema**

Set `additionalProperties: false` on Finding and its nested objects. Change `DiscoveryReport.candidateFindings` to `findings`, and make `DiscoveryManifest.discoveryReportPath` validate the complete referenced report via `$pathOf`.

- [ ] **Step 4: Run focused tests**

Expected: valid reports pass; malformed or Candidate-shaped reports fail before post-success persistence.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/scan/pipeline/definitions/schemas/research.yaml \
  packages/server/src/services/scan/pipeline/definitions/stages/research.yaml \
  packages/server/src/services/scan/pipeline/scan-pipeline-schema-contracts.test.ts \
  apps/vulseek/__test__/scan/research-pipeline-contract.test.ts \
  apps/vulseek/__test__/scan/research-pipeline-artifacts.test.ts
git commit -m "feat(research): define strict finding artifacts"
```

## Task 2: Add Finding Projection And Event Tables

**Files:**
- Modify: `packages/server/src/db/schema/research.ts`
- Modify: the schema barrel that currently exports `packages/server/src/db/schema/research.ts`
- Create: `apps/vulseek/drizzle/0217_research_findings.sql`
- Test: `apps/vulseek/__test__/scan/research-registry-db.integration.test.ts`

**Interfaces:**
- Produces: Drizzle tables `researchFindings` and `researchFindingEvents`.
- Changes: `researchTracks.candidateFindingIds` to `findingIds`; `exploitPrimitives.candidateId` to `findingId`.
- Preserves: Existing Track, Primitive, and Chain rows without backfilling Finding records.

- [ ] **Step 1: Add failing database integration tests**

Assert composite uniqueness on `(scanJobId, findingId)`, job-scoped track resolution, event idempotency, cascade deletion by job, and the renamed Track/Primitive columns.

- [ ] **Step 2: Run the integration test and confirm failure**

```bash
pnpm --filter vulseek test -- research-registry-db.integration
```

- [ ] **Step 3: Add Drizzle models**

`research_findings` stores identity, track linkage, producer task, canonical content, current state, latest validation verdict, latest review decision, required evidence, current task, revision, and timestamps. `research_finding_events` stores the actor task, source stage, expected/resulting revision, compact payload, evidence references, idempotency key, and timestamp.

Use a composite primary or unique key for `(scanJobId, findingId)`. Index `(scanJobId, updatedAt)`, `(scanJobId, status)`, `(scanJobId, trackId)`, and `(findingId, createdAt)` as appropriate for list and event queries.

- [ ] **Step 4: Add migration `0217_research_findings.sql`**

Create both Finding tables and rename:

```sql
ALTER TABLE "research_tracks"
	RENAME COLUMN "candidateFindingIds" TO "findingIds";
ALTER TABLE "exploit_primitives"
	RENAME COLUMN "candidateId" TO "findingId";
```

Do not add a hard foreign key from `exploit_primitives.findingId` because old Primitive rows are retained without Finding backfill. Enforce that relationship in new persistence writes.

- [ ] **Step 5: Apply only to dev and run the integration test**

Use the repository's dev migration command, then rerun `research-registry-db.integration`. Expected: tables, indexes, constraints, and renamed columns are present.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/db/schema apps/vulseek/drizzle/0217_research_findings.sql \
  apps/vulseek/__test__/scan/research-registry-db.integration.test.ts
git commit -m "feat(research): add finding projection registry"
```

## Task 3: Persist Finding State And Events

**Files:**
- Modify: `packages/server/src/services/scan/persistence/research-registry.repo.ts`
- Modify: `packages/server/src/services/scan/persistence/research-registry-state.ts`
- Create: `packages/server/src/services/scan/persistence/research-finding.repo.ts`
- Create: `packages/server/src/services/scan/persistence/research-finding-state.ts`
- Test: `packages/server/src/services/scan/persistence/research-registry-state.test.ts`
- Create: `packages/server/src/services/scan/persistence/research-finding-state.test.ts`
- Modify: `apps/vulseek/__test__/scan/research-registry-db.integration.test.ts`

**Interfaces:**
- Produces: `persistDiscoveredFindingsTx`, `transitionResearchFindingTx`, and `requireResearchFindingTx`.
- Consumes: Strict `DiscoveryReport.findings` from Task 1 and tables from Task 2.

```ts
persistDiscoveredFindingsTx(tx, {
	scanJobId,
	trackId,
	producerTaskId,
	findings,
}): Promise<void>

transitionResearchFindingTx(tx, {
	scanJobId,
	findingId,
	actorTaskId,
	sourceStage,
	eventType,
	nextStatus,
	patch,
	idempotencyKey,
}): Promise<{ applied: boolean; revision: number }>
```

- [ ] **Step 1: Add failing state and transaction tests**

Cover discovery upsert, retry idempotency, conflicting same-ID content, selected/validated/reviewed transitions, `needs-more-evidence`, `false-positive`, confirmed Primitive creation, later invalidation, missing Finding references, wrong-job references, and event/projection atomicity.

- [ ] **Step 2: Run focused tests and confirm failure**

```bash
pnpm --filter vulseek test -- research-finding-state research-registry-db.integration
```

- [ ] **Step 3: Implement Finding persistence**

`record-discovery` must read `report.findings`, resolve each `trackKey` within the same Job, upsert the projection, append a `discovered` event, and update `research_tracks.findingIds`. Remove the import and invocation of the Full Scan Candidate schema and Candidate sync logic from this path.

- [ ] **Step 4: Update later-stage transitions**

Finding Validation and Finding Review update the projection and append events in one transaction. Confirmed review verifies the Finding exists before writing `exploit_primitives.findingId`. Chain and Exploit review invalidation also transitions the referenced Finding rather than a Candidate.

- [ ] **Step 5: Run focused tests**

Expected: retries are no-ops, invalid transitions do not partially update state, and no Research persistence path touches `vulnerability_candidates`.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/services/scan/persistence/research-* \
  apps/vulseek/__test__/scan/research-registry-db.integration.test.ts
git commit -m "feat(research): persist finding lifecycle"
```

## Task 4: Convert The Research Pipeline To Finding References

**Files:**
- Modify: `packages/server/src/services/scan/pipeline/definitions/schemas/research.yaml`
- Modify: `packages/server/src/services/scan/pipeline/definitions/stages/research.yaml`
- Modify: `packages/server/src/services/scan/pipeline/definitions/pipelines/research.yaml`
- Modify: Research prompt files referenced by `stages/research.yaml`
- Modify: `packages/server/src/services/scan/persistence/research-registry-state.ts`
- Test: `apps/vulseek/__test__/scan/research-pipeline-contract.test.ts`
- Test: `apps/vulseek/__test__/scan/research-pipeline-artifacts.test.ts`
- Test: `packages/server/src/services/scan/persistence/research-registry-state.test.ts`

**Interfaces:**
- Renames: `candidateFindingIds` to `findingIds`, `candidateId` to `findingId`, `invalidCandidateId` to `invalidFindingId`, and route `candidate-found` to `finding-found`.
- Preserves: Existing Research stage topology and local feedback-loop semantics.

- [ ] **Step 1: Add failing topology and prompt-contract tests**

Assert that Research definitions contain no Candidate field or route names, Track Review fans out `$.findingIds[*]`, all downstream task inputs carry `findingId`, and prompts require reading/writing the Finding artifact rather than constructing Candidate output.

- [ ] **Step 2: Run focused tests and confirm failure**

```bash
pnpm --filter vulseek test -- research-pipeline-contract research-pipeline-artifacts research-registry-state
```

- [ ] **Step 3: Rename schemas, edges, fanout, and prompt values**

Track Review emits only IDs that exist in `research_findings` for the same Job. Finding Validation and Review use `findingId`. Chain Review and Exploit Review emit `invalidFindingId`. Task names and artifact manifests use Finding titles or IDs and never Candidate terminology.

- [ ] **Step 4: Enforce routing semantics**

`confirmed` creates a Primitive and routes to Chain Synthesis; `needs-more-evidence` loops to Finding Validation; `false-positive` returns to Track Planning; a later review may route an invalidated Finding back to validation. Missing or cross-job Finding IDs fail post-success handling instead of silently routing.

- [ ] **Step 5: Run focused tests and inspect definitions**

```bash
rg -n 'candidateFindingIds|candidateId|invalidCandidateId|candidate-found' \
  packages/server/src/services/scan/pipeline/definitions/{schemas,stages,pipelines}/research.yaml \
  packages/server/src/services/scan/prompts
```

Expected: no Research-specific matches remain.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/services/scan/pipeline/definitions \
  packages/server/src/services/scan/prompts \
  packages/server/src/services/scan/persistence/research-registry-state* \
  apps/vulseek/__test__/scan/research-pipeline-*.test.ts
git commit -m "refactor(research): route pipeline by finding"
```

## Task 5: Add Finding Repositories, tRPC, And Agent Broker Operations

**Files:**
- Create: `packages/server/src/services/scan/persistence/research-finding-list.repo.ts`
- Modify: `packages/server/src/services/scan/persistence/research-registry-list.repo.ts`
- Modify: `apps/vulseek/server/api/routers/scan.ts`
- Modify: `apps/vulseek/pages/api/internal/scan/research-broker.ts`
- Modify: `agents/skills/research-db/research_db.py`
- Modify: `agents/skills/research-db/SKILL.md`
- Modify: `apps/vulseek/__test__/scan/research-registry-list.test.ts`
- Modify: `apps/vulseek/__test__/scan/research-registry-api.test.ts`
- Modify: `apps/vulseek/__test__/scan/research-broker-contract.test.ts`

**Interfaces:**
- Produces: `scan.researchFindings`, `findResearchFindingRepo`, and `listResearchFindingEventsRepo`.
- Broker operations: `list-findings`, `get-finding`, and `list-finding-events`.

```ts
type ResearchFindingListInput = {
	scanJobId: string;
	page: number;
	pageSize: number;
	query?: string;
	status?: string;
};
```

- [ ] **Step 1: Add failing repository, authorization, and broker tests**

Cover job isolation, organization authorization, pagination, status filter, search across ID/title/class/claim/root cause/track/file, projection detail, ordered events, and a broker assertion that `list-findings` does not query `vulnerability_candidates`.

- [ ] **Step 2: Run focused tests and confirm failure**

```bash
pnpm --filter vulseek test -- research-registry-list research-registry-api research-broker-contract
```

- [ ] **Step 3: Implement repository and tRPC queries**

Use `research_findings` as the only Research Finding source. Return projection state and canonical content; detail may join Track metadata but must not parse Task output or Candidate projection output.

- [ ] **Step 4: Implement broker and Python skill operations**

`list-findings` reads the new table. `get-finding` returns one same-job projection. `list-finding-events` returns chronological compact events. Keep DB writes in TypeScript pipeline persistence; the Python skill remains read-oriented for agent context.

- [ ] **Step 5: Run focused tests**

Expected: all reads are job-scoped, authorized, paginated, and independent from Candidate tables.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/services/scan/persistence/research-* \
  apps/vulseek/server/api/routers/scan.ts \
  apps/vulseek/pages/api/internal/scan/research-broker.ts \
  agents/skills/research-db \
  apps/vulseek/__test__/scan/research-*.test.ts
git commit -m "feat(research): expose finding registry"
```

## Task 6: Replace The Research Candidate Tab With Findings

**Files:**
- Modify: `apps/vulseek/components/dashboard/scanning/show-scan-job-detail.tsx`
- Modify: `apps/vulseek/components/dashboard/scanning/research-registry-tabs.ts`
- Modify: `apps/vulseek/components/dashboard/scanning/research-registry-panels.tsx`
- Modify: `apps/vulseek/__test__/scan/research-registry-tabs.test.ts`
- Modify: `apps/vulseek/__test__/scan/research-registry-ui-contract.test.ts`

**Interfaces:**
- Research tab order: `Overview / Tasks / Findings / Tracks / Primitives / Chains / Monitoring / Files`.
- Full/Delta tab behavior: Candidates remains present; Findings is absent.
- Finding interaction: paginated list plus side-sheet detail; no dedicated detail route or Candidate actions.

- [ ] **Step 1: Add failing UI contract tests**

Cover scan-type-specific tabs, `tab=candidates` redirecting to `findings` for Research, `tab=findings` redirecting to Overview for Full/Delta, empty state, loading/error state, long-text containment, pagination, search, status filter, and opening/closing the detail sheet.

- [ ] **Step 2: Run focused tests and confirm failure**

```bash
pnpm --filter vulseek test -- research-registry-tabs research-registry-ui-contract
```

- [ ] **Step 3: Add the Findings panel**

Display title, track, vulnerability class, source location, confidence, status, and updated time. The detail sheet displays the canonical claim, root cause, source/sink, attacker control, trust-boundary crossings, preconditions, evidence, quick disproof attempt, latest validation/review state, and event history.

Do not expose Candidate metadata editing, export, rerun, files, or Candidate detail routes in the first version.

- [ ] **Step 4: Make tabs scan-type-specific**

Hide Candidates for Research and show Findings. Preserve Candidates for Full/Delta without issuing a Research Findings query. Normalize invalid legacy tab query values as described in the interface.

- [ ] **Step 5: Run focused tests**

Expected: Research and Full/Delta tab sets and queries are isolated.

- [ ] **Step 6: Commit**

```bash
git add apps/vulseek/components/dashboard/scanning/show-scan-job-detail.tsx \
  apps/vulseek/components/dashboard/scanning/research-registry-*.tsx \
  apps/vulseek/components/dashboard/scanning/research-registry-tabs.ts \
  apps/vulseek/__test__/scan/research-registry-*.test.ts
git commit -m "feat(research): add findings workspace"
```

## Final Verification

- [ ] Run all required checks:

```bash
pnpm --filter vulseek test
pnpm --filter @vulseek/server typecheck
pnpm --filter vulseek typecheck
git diff --check
```

- [ ] Search for stale Candidate terminology limited to Research code:

```bash
rg -n 'candidateFindingIds|candidateId|invalidCandidateId|candidate-found|candidateFindings' \
  packages/server/src/services/scan/pipeline/definitions/{schemas,stages,pipelines}/research.yaml \
  packages/server/src/services/scan/persistence/research-* \
  apps/vulseek/pages/api/internal/scan/research-broker.ts \
  agents/skills/research-db \
  apps/vulseek/components/dashboard/scanning/research-registry-*
```

Expected: no stale Research-domain references. Candidate references in Full/Delta code remain unchanged.

- [ ] Start a new dev Research Scan and verify:
  - Discovery cannot complete with an invalid Finding artifact.
  - Valid discovery creates `research_findings` and one idempotent `discovered` event.
  - Track Review and Finding Validation route by `findingId`.
  - Needs-more-evidence and false-positive loops update projection and event history.
  - Confirmed Finding creates a Primitive linked by `findingId`.
  - Findings UI updates during the running Job and is isolated from other Jobs.
  - Full/Delta Candidate pages still load and behave unchanged.

