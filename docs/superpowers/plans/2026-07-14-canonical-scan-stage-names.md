# Canonical Scan Stage Names Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove legacy scan stage terminology and use canonical stage IDs and names throughout Vulseek.

**Architecture:** Stage identity flows directly from pipeline definitions through persistence, runtime APIs, and UI without compatibility aliases. A one-time migration canonicalizes historical task rows; immutable historical migrations remain unchanged.

**Tech Stack:** TypeScript, Next.js, tRPC, Drizzle ORM, PostgreSQL, Vitest, Biome.

## Global Constraints

- Canonical IDs are `repository-profile`, `identify-target`, and `scan-target`.
- No runtime compatibility for `repository-profile`, `identify-target`, or `scan-target`.
- Historical Drizzle migration files are not modified.

---

### Task 1: Canonical Runtime Values

**Files:**
- Modify: `packages/server/src/services/scan/running-task-stage.ts`
- Modify: `packages/server/src/services/scan/live-session.ts`
- Modify: `apps/vulseek/pages/api/scan/jobs/[scanJobId]/scanner-jsonrpc-stream.ts`
- Modify: `apps/vulseek/components/dashboard/scanning/*.tsx`
- Test: `apps/vulseek/__test__/server/running-task-stage.test.ts`

- [ ] Write failing tests that require canonical IDs and reject legacy IDs.
- [ ] Run the focused tests and confirm the legacy behavior fails.
- [ ] Replace snake_case and legacy runtime stage values with canonical IDs.
- [ ] Run the focused tests and server typecheck.

### Task 2: Canonical Implementations And Symbols

**Files:**
- Rename: `packages/server/src/services/scan/stages/repository-profile.stage.ts`
- Rename: `packages/server/src/services/scan/prompts/repository-profile.prompt.ts`
- Delete: superseded module/function scan stage and scanner prompt files.
- Modify: `packages/server/src/services/scan.ts`
- Modify: `packages/server/src/services/scan/stage-metadata.ts`
- Modify: pipeline definitions, recovery helpers, tests, and current docs.

- [ ] Rename repository implementation exports and imports.
- [ ] Rename queue, enqueue, runtime-log, and metadata symbols.
- [ ] Delete superseded implementations and remove their tests/imports.
- [ ] Run scan pipeline and prompt tests.

### Task 3: Historical Data Migration

**Files:**
- Create: next `apps/vulseek/drizzle/*.sql` migration.
- Modify: `apps/vulseek/drizzle/meta/_journal.json`.
- Test: migration journal and migration tests.

- [ ] Add SQL updates from each legacy task stage ID to its canonical ID.
- [ ] Register the migration in the journal.
- [ ] Run migration tests and verify idempotent results.

### Task 4: Residual Scan And Verification

**Files:**
- Modify: current documentation and `CLAUDE.md` where legacy terminology remains.

- [ ] Scan source and current docs for every legacy identifier, excluding immutable migrations and generated output.
- [ ] Run focused tests, server typecheck, Vulseek tests, Biome, server build, and Next build.
- [ ] Record any unrelated pre-existing failures without changing unrelated files.
