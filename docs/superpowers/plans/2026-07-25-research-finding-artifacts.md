# Research Finding Artifacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store each Research Finding in a separately validated JSON artifact before persisting its complete object to `research_findings`.

**Architecture:** `DiscoveryReport.findingPaths` is a nested `$pathOf` path list. The schema contract recursively validates referenced artifacts, while the Research Registry loads each path from the producer task and persists the resulting Finding objects. Track Review consumes persisted Findings through `research-db`.

**Tech Stack:** TypeScript, YAML pipeline definitions, Drizzle ORM, Vitest/Node test runner, pnpm.

## Global Constraints

- Preserve unrelated changes in the dirty worktree.
- Do not add legacy inline-Finding fallback behavior.
- Do not modify or connect to release.
- Do not add a database migration.

---

### Task 1: Recursive nested artifact validation

**Files:**
- Modify: `packages/server/src/services/scan/pipeline/scan-pipeline-schema-contracts.ts`
- Test: `packages/server/src/services/scan/pipeline/scan-pipeline-schema-contracts.test.ts`

**Interfaces:**
- Consumes: `JsonSchemaContract`, `JsonSchemaArtifactAnnotation`
- Produces: recursive annotations that validate `$pathOf` values inside an artifact JSON document

- [ ] **Step 1: Write a failing test**

Create a contract where `output.reportPath` references a report containing
`findingPaths[]`, and each item references a strict Finding schema. Assert that
the validator reads the report and both Finding files.

- [ ] **Step 2: Verify the test fails**

Run:

```bash
pnpm --filter @vulseek/server exec tsx --test packages/server/src/services/scan/pipeline/scan-pipeline-schema-contracts.test.ts
```

Expected: the nested Finding files are not read or invalid Finding content is
not rejected.

- [ ] **Step 3: Implement recursive annotations**

Retain child artifact annotations on their parent annotation and recursively
validate them against the loaded artifact value. Keep existing top-level path
and path-list behavior unchanged.

- [ ] **Step 4: Verify the focused test passes**

Run the command from Step 2 and expect all tests to pass.

### Task 2: Finding-file Registry persistence

**Files:**
- Modify: `packages/server/src/services/scan/persistence/research-registry.repo.ts`
- Modify: `packages/server/src/services/scan/persistence/research-finding.repo.ts`
- Test: `apps/vulseek/__test__/scan/research-pipeline-artifacts.test.ts`

**Interfaces:**
- Consumes: `DiscoveryReport.findingPaths: string[]`
- Produces: strict Finding objects passed to `persistDiscoveredFindingsTx`

- [ ] **Step 1: Write failing Registry tests**

Cover two valid Finding files, an empty list, a missing file, invalid Finding
content, and rejection of the removed `findings` field.

- [ ] **Step 2: Verify the tests fail**

Run:

```bash
pnpm --filter vulseek test -- research-pipeline-artifacts
```

- [ ] **Step 3: Implement path loading**

Read each `findingPaths` item with `readTaskJsonArtifact`, preserve list order,
and pass the loaded objects to `persistDiscoveredFindingsTx`. Keep the existing
transaction boundary and stable-ID validation.

- [ ] **Step 4: Verify the focused tests pass**

Run the command from Step 2 and expect all tests to pass.

### Task 3: Research schema and prompt contract

**Files:**
- Modify: `packages/server/src/services/scan/pipeline/definitions/schemas/research.yaml`
- Modify: `packages/server/src/services/scan/prompts/vulnerability-discovery.prompt.md`
- Modify: `packages/server/src/services/scan/prompts/track-review.prompt.md`
- Test: `packages/server/src/services/scan/pipeline/scan-pipeline-yaml-contracts.test.ts`
- Test: `apps/vulseek/__test__/scan/research-pipeline-contract.test.ts`

**Interfaces:**
- Produces: `DiscoveryReport.findingPaths` and one strict JSON file per path

- [ ] **Step 1: Write failing contract assertions**

Assert that `DiscoveryReport` requires `findingPaths`, does not expose
`findings`, and each item is `$pathOf: "#/schemas/Finding"`.

- [ ] **Step 2: Verify the tests fail**

Run:

```bash
pnpm --filter vulseek test -- research-pipeline-contract
```

- [ ] **Step 3: Update schema and prompts**

Require one Finding per `/task/findings/*.json`, prohibit inline/stringified
Findings, and instruct Track Review to query persisted Findings through
`research-db`.

- [ ] **Step 4: Verify focused tests pass**

Run the commands from Steps 1 and 2 and expect all tests to pass.

### Task 4: Final verification

**Files:**
- Verify all files changed by Tasks 1-3

- [ ] **Step 1: Run relevant tests**

```bash
pnpm --filter vulseek test
```

- [ ] **Step 2: Run type checks**

```bash
pnpm --filter @vulseek/server typecheck
pnpm --filter vulseek typecheck
```

- [ ] **Step 3: Check patch hygiene**

```bash
git diff --check
```

- [ ] **Step 4: Review scope**

Confirm no release configuration, migration, or unrelated worktree change was
modified by this implementation.
