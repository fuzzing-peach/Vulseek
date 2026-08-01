# Research Agent-Owned Database Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Research Registry reads, entity CRUD, revision checks, and conflict handling from TypeScript pipeline effects into the `research-db` Python skill operated by each Agent.

**Architecture:** Every Research task receives `VULSEEK_RESEARCH_DATABASE_URL`, `VULSEEK_SCAN_JOB_ID`, and `VULSEEK_TASK_ID`. Agents call typed Python CRUD commands directly; each command executes one entity mutation in its own short PostgreSQL transaction and returns structured success/conflict/error JSON. Registry tables retain only current entity state and `revision`; TypeScript continues to manage tasks, containers, output validation, routes, dispatch, and job settlement, but no longer mutates Research Registry entities.

**Tech Stack:** Python 3, `psycopg` 3, PostgreSQL 16, TypeScript, Drizzle ORM, YAML pipeline definitions, Vitest.

## Global Constraints

- Same Track, Finding, Primitive, or Chain may be processed by multiple tasks concurrently.
- Agents own Research Registry revision checks, conflict resolution, and retries.
- Python encapsulates all SQL; prompts must not contain raw SQL.
- Do not expose a generic `apply-batch` command or require Agents to create mutation JSON.
- Mutations must set absolute desired values. Relative operations such as increment, append, or remove-by-index are forbidden because they cannot be recognized safely after a retry.
- Do not add per-Job database roles, RLS, a SQL proxy, or a write API.
- Use one shared `VULSEEK_RESEARCH_DATABASE_URL`, defaulted from the Vulseek service `DATABASE_URL`.
- Do not serialize the database URL into `acp-driver-input.json`, task artifacts, stdout, or ordinary logs.
- A committed Agent transaction remains valid if the task later fails or is canceled; TypeScript does not roll it back.
- The four entity tables are the only Research Registry data source; no event or operation-history table remains.
- Existing running Research Jobs are not runtime-compatible and must be canceled before applying the migration.
- Do not deploy, restart, migrate, or test against release while implementing this plan.

---

## Removal And Retention Map

### Remove

- Database table `research_entity_claims`.
- Database tables `research_track_events`, `research_finding_events`, `exploit_primitive_events`, and `exploit_chain_events`.
- Columns `research_tracks.currentTaskId` and `research_findings.currentTaskId`.
- `research-entity-claim.repo.ts` and its unit/integration tests.
- Claim acquire, renew, complete, fail, recovery, and cancellation code in `scan.ts` and `pipeline-runner.ts`.
- Runtime Research Registry writer files:
  - `research-registry.repo.ts`
  - `research-finding.repo.ts`
  - `research-finding-state.ts`
  - `research-registry-state.ts`
- Dead TypeScript consistency helper `research-effect-consistency.ts`.
- Internal Research Broker API, token generator, runtime config, token mount/env handling, and broker tests.
- `research-registry` effects from the active Research stage YAML and Generic Agent completion handler.
- Event-list Python commands, Finding event API/repository methods, and the Finding detail event timeline.
- `idempotencyKey`, `expectedRevision`, and `resultingRevision` event-only storage.

### Retain

- `research_tracks`
- `research_findings`
- `exploit_primitives`
- `exploit_chains`
- The `revision` column on each entity table.
- Existing entity provenance fields such as `producerTaskId`, where they are part of the current entity state.
- Read-only TypeScript repositories and API/UI code:
  - `research-registry-list.repo.ts`
  - `research-registry-list.ts`
  - `research-finding-list.repo.ts`
  - Tracks, Findings, Primitives, and Chains tabs.
- Task dispatch recovery; it is independent from Registry writes.
- A schema-only decoder for legacy `research-registry` effects so historical Job snapshots remain viewable. It must have no runtime executor.

---

### Task 1: Define The Python Registry Contract

**Files:**
- Modify: `agents/skills/research-db/SKILL.md`
- Modify: `agents/skills/research-db/research_db.py`
- Create: `agents/skills/research-db/research_store.py`
- Create: `agents/skills/research-db/research_mutations.py`
- Create: `agents/skills/research-db/tests/test_research_mutations.py`
- Create: `agents/skills/research-db/tests/test_research_store.py`

**Interfaces:**
- Consumes: `VULSEEK_RESEARCH_DATABASE_URL`, `VULSEEK_SCAN_JOB_ID`, `VULSEEK_TASK_ID`.
- Produces: direct CLI reads and entity CRUD commands. No generic operation document is accepted.

- [ ] **Step 1: Write failing contract tests**

Cover these commands:

```text
list-tracks       get-track       create-track       update-track       delete-track
list-findings     get-finding     create-finding     update-finding     delete-finding
list-primitives   get-primitive   create-primitive   update-primitive   delete-primitive
list-chains       get-chain       create-chain       update-chain       delete-chain
```

Tests must prove:

- `scanJobId` and `producerTaskId` default from environment context where the entity supports them.
- SQL values are parameters, never string interpolation.
- unknown flags and unknown commands are rejected before opening a transaction.
- scalar fields use named CLI flags, list fields use repeatable flags, and structured content may reference an already-existing stage artifact with `--content-file`; no command accepts a generic mutation JSON file.
- stdout contains JSON only and never includes the database URL.
- exit codes are `0=success`, `2=input error`, `3=revision conflict`, `4=database error`.
- each create/update/delete command opens and commits its own transaction.

- [ ] **Step 2: Run tests and confirm failure**

```bash
python3 -m unittest discover -s agents/skills/research-db/tests -v
```

Expected: failures because writer modules and commands do not exist.

- [ ] **Step 3: Implement entity metadata and typed mutations**

`research_mutations.py` must define one allowlist per entity:

```python
ENTITY_SPECS = {
    "track": {
        "table": "research_tracks",
        "id_column": "trackId",
        "mutable": {
            "trackKey", "approachFamily", "researchIdea", "scope",
            "mechanisms", "status", "coverage", "evidenceRefs",
            "findingIds", "blockReason", "reopenCondition", "nextStep",
            "iteration",
        },
    },
    "finding": {
        "table": "research_findings",
        "id_column": "findingId",
        "mutable": {
            "trackId", "producerTaskId", "content", "status",
            "latestValidationVerdict", "latestReviewDecision",
            "requiredEvidence",
        },
    },
    "primitive": {
        "table": "exploit_primitives",
        "id_column": "primitiveId",
        "mutable": {
            "findingId", "name", "capability", "requiredInput",
            "producedCapability", "trustLevel", "status", "evidenceRefs",
        },
    },
    "chain": {
        "table": "exploit_chains",
        "id_column": "chainId",
        "mutable": {
            "chainKey", "status", "steps", "entrypoint",
            "requiredCapabilities", "producedCapabilities",
            "trustBoundaryCrossings", "deploymentConditions",
            "primitiveGaps", "successTarget",
        },
    },
}
```

Create/update/delete operations use these rules:

- `create-*`: insert at revision `0`. If the identity already exists and all supplied values match, return `alreadyExists`; otherwise return `conflict`.
- `update-*`: require `--expected-revision`. Execute `UPDATE ... WHERE revision = expectedRevision`, set absolute desired values, and increment revision exactly once.
- If an update affects no row, read the current row in the same command. Return `alreadyApplied` when every requested value already matches; otherwise return `conflict` with the current row and revision.
- `delete-*`: require `--expected-revision`. A missing row returns `alreadyDeleted`; a present row with another revision returns `conflict`.
- Foreign-key or validation failures roll back the command transaction.

- [ ] **Step 4: Implement direct command argument parsing**

Examples:

```bash
python3 research_db.py update-track \
  --track-id track-a \
  --expected-revision 3 \
  --status active \
  --next-step "inspect callback authorization"

python3 research_db.py create-finding \
  --finding-id finding-a \
  --track-id track-a \
  --content-file /task/outputs/finding-a.json \
  --status discovered
```

Do not implement `apply-batch`, `append-*-event`, `list-*-events`, `--operations`, or a generic `--input` mutation document.

- [ ] **Step 5: Document the Agent conflict loop**

The skill must prescribe:

```text
read -> reason without an open transaction -> direct create/update/delete command
  success/alreadyApplied/alreadyExists -> continue and write output.json
  conflict -> read current entity -> merge, supersede, or abandon -> retry if needed
  alreadyDeleted -> treat delete as complete
```

It must forbid long-running transactions during LLM reasoning. Because no history or operation key is retained, an Agent must reread state after ambiguous command failures before retrying.

- [ ] **Step 6: Run Python unit tests**

```bash
python3 -m unittest discover -s agents/skills/research-db/tests -v
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add agents/skills/research-db
git commit -m "feat(research): add agent-owned registry database client"
```

---

### Task 2: Add Direct Database Connectivity To Research Containers

**Files:**
- Modify: `packages/server/src/services/dockerfiles/Dockerfile.scan-tools`
- Modify: `packages/server/src/services/scan/runtime/run-single-turn-agent.ts`
- Modify: `apps/vulseek/__test__/scan/runtime/run-single-turn-agent.test.ts`
- Modify: `dev.sh`
- Modify: `run.sh`
- Delete: `packages/server/src/services/scan/runtime/research-broker-config.ts`
- Delete: `apps/vulseek/__test__/scan/research-broker-config.test.ts`
- Delete: `scripts/research-broker-token.sh`
- Delete: `apps/vulseek/__test__/scan/research-broker-token.test.ts`

**Interfaces:**
- Produces: `VULSEEK_RESEARCH_DATABASE_URL`, `VULSEEK_SCAN_JOB_ID`, and `VULSEEK_TASK_ID` inside Research containers.

- [ ] **Step 1: Write failing runtime tests**

Assert:

- Research containers receive the database variable by name: `-e VULSEEK_RESEARCH_DATABASE_URL`.
- Full and Delta scan containers do not receive it.
- the value is absent from Docker command logs and `acp-driver-input.json`.
- broker URL/token/token-file variables and mounts are absent.
- missing `VULSEEK_RESEARCH_DATABASE_URL` fails Research task launch with an explicit configuration error.

- [ ] **Step 2: Add `psycopg` to the tools image**

Add `psycopg[binary]>=3.2,<4` to `/opt/vulseek-venv` in `Dockerfile.scan-tools`.

- [ ] **Step 3: Replace Broker environment handling**

At service startup:

```text
VULSEEK_RESEARCH_DATABASE_URL=${VULSEEK_RESEARCH_DATABASE_URL:-$DATABASE_URL}
```

Pass the variable into a Research container by name, not by embedding its value in the Docker command. Keep Job and task IDs as ordinary non-secret values.

- [ ] **Step 4: Remove Broker token lifecycle**

Remove token generation, `.vulseek-secrets/research-broker-*.token` reads, Broker URL resolution, `NO_PROXY` Broker amendments, token-file mounts, and adapter environment serialization.

- [ ] **Step 5: Verify scripts and runtime tests**

```bash
bash -n dev.sh run.sh
pnpm --filter vulseek test -- run-single-turn-agent
```

- [ ] **Step 6: Build and smoke-test the dev tools image**

Inside a disposable dev tools container:

```bash
python3 -c 'import psycopg; print(psycopg.__version__)'
python3 /workspace/repo/.agents/skills/research-db/research_db.py list-tracks
```

The second command must return JSON using dev context and must not print the connection URL.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/services/dockerfiles/Dockerfile.scan-tools \
  packages/server/src/services/scan/runtime/run-single-turn-agent.ts \
  apps/vulseek/__test__/scan/runtime/run-single-turn-agent.test.ts \
  dev.sh run.sh
git rm packages/server/src/services/scan/runtime/research-broker-config.ts \
  apps/vulseek/__test__/scan/research-broker-config.test.ts \
  scripts/research-broker-token.sh \
  apps/vulseek/__test__/scan/research-broker-token.test.ts
git commit -m "feat(research): inject direct registry database access"
```

---

### Task 3: Reduce The Registry To Entity Tables

**Files:**
- Create: `apps/vulseek/drizzle/0220_agent_owned_research_registry.sql`
- Modify: `apps/vulseek/drizzle/meta/_journal.json`
- Modify: `packages/server/src/db/schema/research.ts`
- Modify: `packages/server/src/services/scan/persistence/research-finding-list.repo.ts`
- Modify: `apps/vulseek/server/api/routers/scan.ts`
- Modify: `apps/vulseek/components/dashboard/scanning/research-registry-panels.tsx`
- Modify: `apps/vulseek/__test__/server/migration-journal.test.ts`
- Modify: `apps/vulseek/__test__/scan/research-registry-list.test.ts`
- Modify: `apps/vulseek/__test__/scan/research-registry-ui-contract.test.ts`
- Delete: `packages/server/src/services/scan/persistence/research-entity-claim.repo.ts`
- Delete: `packages/server/src/services/scan/persistence/research-entity-claim.test.ts`
- Delete: `apps/vulseek/__test__/scan/research-entity-claim.test.ts`

**Interfaces:**
- Migration removes obsolete locking and event history while preserving current Registry entity state.

- [ ] **Step 1: Write migration/schema tests**

Assert:

- the Drizzle schema exports only `researchTracks`, `researchFindings`, `exploitPrimitives`, and `exploitChains` for Research Registry persistence;
- `researchEntityClaims` and all four event-table exports are absent;
- no Registry entity exposes `currentTaskId`;
- every retained entity exposes `revision`.

- [ ] **Step 2: Add migration**

```sql
DROP TABLE IF EXISTS "research_entity_claims";
DROP TABLE IF EXISTS "research_track_events";
DROP TABLE IF EXISTS "research_finding_events";
DROP TABLE IF EXISTS "exploit_primitive_events";
DROP TABLE IF EXISTS "exploit_chain_events";
ALTER TABLE "research_tracks" DROP COLUMN IF EXISTS "currentTaskId";
ALTER TABLE "research_findings" DROP COLUMN IF EXISTS "currentTaskId";
```

Do not edit or delete migration `0219`; add `0220` so already-migrated dev databases advance correctly.

- [ ] **Step 3: Remove event read paths and UI**

Remove:

- `researchFindingEvents` repository query and tRPC procedure;
- the event query and event timeline from Finding detail;
- all Track/Finding/Primitive/Chain event imports;
- `currentTaskId` from Finding repository selection and API results.

Finding detail continues to show the current entity state and `producerTaskId`; it does not reconstruct history from tasks.

- [ ] **Step 4: Apply only to dev and inspect**

```bash
DATABASE_URL='postgresql://vulseek:vulseek_dev_password@127.0.0.1:25432/vulseek' \
  pnpm --filter vulseek migration:run
```

Verify the four retained entity tables still exist and contain their latest historical state. Verify the claim table, four event tables, and two `currentTaskId` columns were removed.

- [ ] **Step 5: Commit**

```bash
git add apps/vulseek/drizzle/0220_agent_owned_research_registry.sql \
  apps/vulseek/drizzle/meta/_journal.json \
  packages/server/src/db/schema/research.ts \
  packages/server/src/services/scan/persistence/research-finding-list.repo.ts \
  apps/vulseek/server/api/routers/scan.ts \
  apps/vulseek/components/dashboard/scanning/research-registry-panels.tsx \
  apps/vulseek/__test__/server/migration-journal.test.ts \
  apps/vulseek/__test__/scan/research-registry-list.test.ts \
  apps/vulseek/__test__/scan/research-registry-ui-contract.test.ts
git rm packages/server/src/services/scan/persistence/research-entity-claim.repo.ts \
  packages/server/src/services/scan/persistence/research-entity-claim.test.ts \
  apps/vulseek/__test__/scan/research-entity-claim.test.ts
git commit -m "refactor(research): retain current registry state only"
```

---

### Task 4: Remove TypeScript Registry Mutation

**Files:**
- Modify: `packages/server/src/services/scan.ts`
- Modify: `packages/server/src/services/scan/pipeline/pipeline-runner.ts`
- Modify: `packages/server/src/services/scan/stages/generic-agent.stage.ts`
- Modify: `packages/server/src/services/scan/pipeline/scan-pipeline-definitions.ts`
- Modify: `packages/server/src/services/scan/pipeline/yaml-pipeline-runtime.ts`
- Delete: `packages/server/src/services/scan/persistence/research-registry.repo.ts`
- Delete: `packages/server/src/services/scan/persistence/research-finding.repo.ts`
- Delete: `packages/server/src/services/scan/persistence/research-finding-state.ts`
- Delete: `packages/server/src/services/scan/persistence/research-finding-state.test.ts`
- Delete: `packages/server/src/services/scan/persistence/research-registry-state.ts`
- Delete: `packages/server/src/services/scan/persistence/research-registry-state.test.ts`
- Delete: `packages/server/src/services/scan/pipeline/research-effect-consistency.ts`
- Delete: `packages/server/src/services/scan/pipeline/research-effect-consistency.test.ts`

**Interfaces:**
- TypeScript completion persists task output/route only; it does not mutate Research Registry.

- [ ] **Step 1: Write failing completion and launch tests**

Assert:

- two tasks for the same entity can both launch.
- task launch does not query or create a Research claim.
- success completion does not call `applyResearchRegistryEffect`.
- failure/cancel/recovery does not update claims.
- dispatch retry behavior remains unchanged.

- [ ] **Step 2: Remove claim lifecycle from runtime**

Delete claim imports and all acquire, busy-cancel, renew, reset, complete, fail, and cleanup branches from `scan.ts` and `pipeline-runner.ts`.

- [ ] **Step 3: Remove Registry effect execution**

Delete the Research Registry import and handler from `generic-agent.stage.ts`. Keep candidate effects unchanged.

- [ ] **Step 4: Remove mutation repositories and state machines**

Delete the TypeScript writers and transition validators listed above. Keep list/query repositories used by the UI.

- [ ] **Step 5: Preserve legacy snapshot decoding only**

Keep `research-registry` in the YAML/definition decoder as deprecated data so historical snapshots render. New stage YAML must not contain it, and Generic Agent must not execute it.

- [ ] **Step 6: Run focused tests**

```bash
pnpm --filter vulseek test -- pipeline-runner research-runtime-recovery research-dispatch-recovery
pnpm --filter @vulseek/server typecheck
```

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/services/scan.ts \
  packages/server/src/services/scan/pipeline/pipeline-runner.ts \
  packages/server/src/services/scan/stages/generic-agent.stage.ts \
  packages/server/src/services/scan/pipeline/scan-pipeline-definitions.ts \
  packages/server/src/services/scan/pipeline/yaml-pipeline-runtime.ts
git rm packages/server/src/services/scan/persistence/research-registry.repo.ts \
  packages/server/src/services/scan/persistence/research-finding.repo.ts \
  packages/server/src/services/scan/persistence/research-finding-state.ts \
  packages/server/src/services/scan/persistence/research-finding-state.test.ts \
  packages/server/src/services/scan/persistence/research-registry-state.ts \
  packages/server/src/services/scan/persistence/research-registry-state.test.ts \
  packages/server/src/services/scan/pipeline/research-effect-consistency.ts \
  packages/server/src/services/scan/pipeline/research-effect-consistency.test.ts
git commit -m "refactor(research): move registry ownership to agents"
```

---

### Task 5: Make Every Research Stage Own Its Database Effects

**Files:**
- Modify: `packages/server/src/services/scan/pipeline/definitions/stages/research.yaml`
- Modify:
  - `packages/server/src/services/scan/prompts/research-scope.prompt.md`
  - `packages/server/src/services/scan/prompts/track-plan.prompt.md`
  - `packages/server/src/services/scan/prompts/vulnerability-discovery.prompt.md`
  - `packages/server/src/services/scan/prompts/track-review.prompt.md`
  - `packages/server/src/services/scan/prompts/finding-validation.prompt.md`
  - `packages/server/src/services/scan/prompts/finding-review.prompt.md`
  - `packages/server/src/services/scan/prompts/chain-synthesis.prompt.md`
  - `packages/server/src/services/scan/prompts/chain-review.prompt.md`
  - `packages/server/src/services/scan/prompts/exploit-validation.prompt.md`
  - `packages/server/src/services/scan/prompts/exploit-review.prompt.md`
  - `packages/server/src/services/scan/prompts/research-report.prompt.md`
- Modify: `packages/server/src/services/scan/pipeline/definitions/schemas/research.yaml`
- Modify: `apps/vulseek/__test__/scan/research-pipeline-contract.test.ts`
- Modify: `apps/vulseek/__test__/scan/research-pipeline-artifacts.test.ts`

**Interfaces:**
- Each write-capable stage commits Registry state before writing final `output.json`.

- [ ] **Step 1: Write failing YAML/prompt contract tests**

Assert:

- no active Research stage contains a `research-registry` effect.
- every write-capable stage includes the `research-db` skill.
- every prompt names its required reads, direct CRUD commands, and conflict loop.
- prompts contain no raw SQL.
- prompts do not mention `apply-batch`, event append commands, event history, or `idempotencyKey`.
- `output.json` is written only after every required database command reports success/already-applied or the Agent records an explicit decision to abandon in task output.

- [ ] **Step 2: Assign Agent write responsibilities**

| Stage | Agent-owned database work |
|---|---|
| `research-scope` | create or update the `__scope__` Track |
| `surface-map` | no required Registry write; artifacts only |
| `track-plan` | create or update each planned Track with one command per Track |
| `vulnerability-discovery` | create each Finding, then update only its owning Track |
| `track-review` | update only the current Track |
| `finding-validation` | update only the current Finding |
| `finding-review` | update the current Finding, then create or update each supported Primitive |
| `chain-synthesis` | create or update each Chain |
| `chain-review` | update only the current Chain |
| `exploit-validation` | update only the current Chain |
| `exploit-review` | update only the current Chain |
| `research-report` | update only Chains whose current state changes during reporting |

Each command is independently atomic. Cross-entity stage work is intentionally not wrapped in a shared transaction. The Agent must execute dependencies first, reread after ambiguous failures, and repair partial progress with subsequent direct commands.

- [ ] **Step 3: Define conflict behavior in prompts**

Every stage must:

1. read the current entity;
2. reason without an open transaction;
3. invoke the relevant direct CRUD command with `expectedRevision`;
4. on conflict, read again and decide whether to merge, supersede, issue another absolute update, or abandon;
5. cap retries at three conflict-resolution rounds;
6. record the final decision in its output summary.

For create retries, an identical existing row is success (`alreadyExists`); a different row is conflict. For update retries, a current row that already matches every requested field is success (`alreadyApplied`). For delete retries, a missing row is success (`alreadyDeleted`).

- [ ] **Step 4: Preserve artifacts**

Discovery must still write Finding JSON files and `discovery-report.json` for Files/session audit, but it must also persist the same Finding content through Python. Remove TypeScript artifact ingestion; schema validation continues to validate output and artifact shape.

- [ ] **Step 5: Run contract tests**

```bash
pnpm --filter vulseek test -- research-pipeline-contract research-pipeline-artifacts
```

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/services/scan/pipeline/definitions/stages/research.yaml \
  packages/server/src/services/scan/pipeline/definitions/schemas/research.yaml \
  packages/server/src/services/scan/prompts \
  apps/vulseek/__test__/scan/research-pipeline-contract.test.ts \
  apps/vulseek/__test__/scan/research-pipeline-artifacts.test.ts
git commit -m "feat(research): let agents persist registry state"
```

---

### Task 6: Replace Broker And TypeScript Writer Tests With Python Integration Tests

**Files:**
- Rewrite: `apps/vulseek/__test__/scan/research-registry-db.integration.test.ts`
- Delete: `apps/vulseek/__test__/scan/research-broker-contract.test.ts`
- Modify: `apps/vulseek/__test__/vitest.config.ts`
- Keep: Registry list/API/UI tests.

**Interfaces:**
- Proves Python owns the complete Registry write lifecycle.

- [ ] **Step 1: Add CRUD integration cases**

Against an isolated dev test Job:

- create/get/update/delete each entity type;
- create Finding only for an existing Track;
- create Primitive referencing a Finding;
- create Chain referencing persisted Primitive/Finding IDs;
- verify timestamps, Scan Job scoping, Finding `producerTaskId`, and revision increments.

- [ ] **Step 2: Add retry and transaction cases**

- each command commits or rolls back one entity mutation as a unit;
- an identical create retry returns `alreadyExists` without changing revision;
- a conflicting create retry returns `conflict`;
- an update retry whose requested fields already match returns `alreadyApplied` without changing revision;
- an update retry whose requested fields differ returns `conflict`;
- deleting an already-missing row returns `alreadyDeleted`;
- delete with wrong revision returns conflict and preserves entity;
- foreign-key failure returns database error without inserting or updating the entity.

- [ ] **Step 3: Add real concurrency cases**

Start four Python processes against the same Track revision:

- all four tasks may run and read revision `0`;
- one CAS update succeeds;
- three return structured conflict;
- each losing Agent can read revision `1+`, issue a new absolute update, and eventually commit;
- final revision equals the number of successful state mutations;
- no update is lost and no retry increments revision when the desired state is already present.

- [ ] **Step 4: Verify UI readers**

Run existing Registry list/API/UI tests unchanged except for removal of `currentTaskId`. This proves direct Python writes appear in Tracks, Findings, Primitives, and Chains tabs without a projection/backfill step.

- [ ] **Step 5: Run tests**

```bash
VULSEEK_RESEARCH_DB_INTEGRATION=1 \
VULSEEK_RESEARCH_DATABASE_URL='postgresql://vulseek:vulseek_dev_password@127.0.0.1:25432/vulseek' \
pnpm --filter vulseek test -- research-registry-db.integration

pnpm --filter vulseek test -- \
  research-registry-list \
  research-registry-api \
  research-registry-ui-contract
```

- [ ] **Step 6: Commit**

```bash
git add apps/vulseek/__test__/scan/research-registry-db.integration.test.ts \
  apps/vulseek/__test__/vitest.config.ts
git rm apps/vulseek/__test__/scan/research-broker-contract.test.ts
git commit -m "test(research): verify agent-owned registry transactions"
```

---

### Task 7: Dev End-To-End Validation

**Files:**
- No release files or services are changed during execution.
- Update this plan's checkboxes with observed Job/task IDs and results.

- [x] **Step 1: Cancel incompatible dev Research Jobs**

Cancel `5iDSFoQFdMjdszz3U80AM` if it is still running. Confirm no active task containers remain before migration/restart.

- [x] **Step 2: Run complete static verification**

```bash
bash -n dev.sh run.sh
python3 -m unittest discover -s agents/skills/research-db/tests -v
pnpm --filter vulseek test
pnpm --filter @vulseek/server typecheck
pnpm --filter vulseek typecheck
git diff --check
```

- [x] **Step 3: Rebuild dev tools and restart dev only**

Build the dev tools image containing `psycopg`, then restart `vulseek-dev`. Do not build, update, restart, or inspect release.

- [x] **Step 4: Start one WordPress Research Job from dev UI**

Observe through at least:

```text
research-scope
-> surface-map
-> track-plan
-> vulnerability-discovery
-> track-review
```

- [x] **Step 5: Run the authenticated agent-browser UI matrix**

Use a persistent, isolated browser session and an already authenticated dev state. Do not put credentials, cookies, or tokens in command arguments, screenshots, HAR files, or the plan:

```bash
browser_session="$(agent-browser session id --scope worktree --prefix research-e2e)"
agent-browser --session "$browser_session" --restore open "$DEV_URL"
agent-browser wait --load networkidle
agent-browser snapshot -i --json > /tmp/research-home.snapshot.json
```

After every navigation, click, form submit, tab switch, or live update, take a new snapshot before using element references. Use `--session` and `--restore` for the whole run; close the session after cleanup.

Test the following cases against the newly created Job:

| Case | Browser actions | Assertions |
|---|---|---|
| Job creation | Open the dev scan form, select an existing Project/Profile, choose Research, submit, and open the created Job | URL identifies the Research Job; no Full Scan-only controls are shown; Overview loads without a console error or failed request |
| Tab contract | Open Overview, Tasks, Findings, Tracks, Primitives, Chains, Monitoring, and Files one by one | Each tab has the expected URL/selected state; Research tabs render only for Research Jobs; refresh preserves the selected tab |
| Task progression | Keep Tasks open while `research-scope`, `surface-map`, `track-plan`, and Discovery tasks run; resnapshot after each visible status change | Running badge, stage label, task name, queue counts, and finished-task counts agree; no duplicate task rows or stale running rows remain after refresh |
| Registry lists | For each of Findings, Tracks, Primitives, and Chains, use search, every enum/status filter, column sorting, next/previous page, and page-size control | Result rows match the active filter; sort direction changes; empty state is distinct from loading/error state; pagination totals and visible rows agree |
| Registry detail | Open a Track, Finding, Primitive, and Chain row, then return to the list | Detail content belongs to the selected Job; IDs and parent references are consistent; browser back/forward and refresh do not lose the Job context |
| Live monitoring | Open Monitoring in one tab and Tasks in another tab for the same Job; leave both open across at least two scheduler cycles | Counts, frontier/stage status, revision values, token/activity data, and running task list advance without duplicate SSE connections or React errors |
| Task evidence | Open a completed and a failed task from Finished Tasks; inspect Output, Session, and Files | Output and session remain readable; failed tasks show a diagnostic reason instead of an empty panel; files are scoped to the selected task |
| Cancellation | From the UI cancel the test Job while a task is active, then refresh Tasks, Monitoring, and every Registry tab | Job becomes canceled; no new child task appears; running list drains; Registry state stops changing; Files/Session remain readable |
| Responsive shell | Repeat the tab and registry-list checks at desktop and narrow mobile viewport sizes | No horizontal overflow hides controls; table headers, search, filters, pagination, and status badges remain usable |

Add these adversarial browser checks; run them against two dev Research Jobs when the first job has enough registry data. Keep the second Job in the same organization but use a separate browser tab and URL so cross-job leakage is observable:

| Case | Browser actions | Assertions |
|---|---|---|
| Refresh during mutation | Open a registry list and detail page while a Review task is completing; refresh repeatedly during loading, then use browser back/forward | No stale pre-refresh row replaces a newer revision; loading/error states settle; the URL retains `scanJobId`, tab, search, filters, sort, and page; no duplicate requests cause duplicate rows |
| SSE reconnect | Keep Tasks and Monitoring open, temporarily disconnect the dev browser network or close/reopen the page, then restore the network | The page reconnects at most once per view, resumes from current state without duplicated activity, and does not reset completed rows to running; console has no uncaught EventSource/React error |
| Concurrent tab edits | Open the same Track detail in two tabs, submit changes or trigger two same-entity task completions, then refresh both tabs | Each tab eventually reflects the committed revision; a conflict is shown as a recoverable state rather than a silent overwrite; no stale revision is displayed after reload |
| Duplicate submit | Double-click the Research Job submit action and repeat a registry mutation trigger if exposed in the UI | At most one Job/task is created; the second action is disabled or safely rejected; task and registry lists do not contain duplicate rows |
| Cross-job isolation | Open Findings, Tracks, Primitives, Chains, Files, and Session for Job A, then navigate directly to the equivalent URLs for Job B | Every list, detail, artifact, count, and task session belongs to the URL-selected Job; switching jobs never leaves rows from the previous Job in the page or browser cache |
| Authorization boundary | In a separate authenticated session without access to the test Job, open a copied Job URL and each registry endpoint through the UI | The UI shows a clear not-found/forbidden state; no registry row, task output, Session, or file name from the protected Job is rendered; failed requests are expected and documented, not retried indefinitely |
| Query edge cases | Search with empty text, mixed case, Unicode, punctuation, a very long string, and characters such as `%`, `_`, and quotes; combine each with filters and sorting | No malformed request or client exception; search is scoped to the selected Job; empty results are distinguishable from API failure; clearing search restores the original page |
| Long-field rendering | Open rows/details containing long titles, paths, descriptions, evidence, IDs, and multiline output | Columns do not overlap; long values wrap or truncate with an accessible affordance; horizontal scrolling is contained to the table/detail region; copying or expanding a value shows the complete text |
| Empty-to-populated transition | Open each registry tab before its first entity exists, leave it open while a task creates an entity, then paginate and refresh | Empty state changes to a populated state without a full-page reload; counts and pagination update once; no stale “no data” banner remains after the row appears |
| Failed-request recovery | With a tab open, force one registry or monitoring request to fail, then restore the dev service and retry from the UI | Error UI identifies the failed area and exposes retry/reload; retry succeeds without duplicating rows or SSE connections; unrelated tabs remain usable |
| Deep-link and cleanup | Open direct URLs for every Research tab and a task Session in a new tab, then cancel the Job and revisit those URLs | Direct links load the correct shell without relying on prior navigation; canceled state is reflected after reload; no new task, queue item, container, or registry revision appears after cleanup |

For each case record the browser URL, timestamp, selected Job ID, visible revision/counts, and request outcome. When a case fails, capture both the before and after snapshots plus a full screenshot, then correlate the failing request with the dev log and the corresponding DB row; do not treat a visually stale page as passed merely because the initial API response was successful.

Capture evidence for each failed case:

```bash
agent-browser snapshot -i --json > /tmp/research-failure.snapshot.json
agent-browser screenshot --full /tmp/research-failure.png
agent-browser console
agent-browser network requests --filter api
```

The browser run passes only when there are no unexpected 4xx/5xx responses, console errors, React errors, duplicate SSE streams, or stale UI values. Expected cancellation responses must be recorded separately from unexpected failures.

#### Executed supplemental browser checks

The following checks were executed against dev Job `pfxGg2BKb6yuxXVkFXAJR` at `http://127.0.0.1:23000`:

- Deep-link refresh retained `tab=tracks` and `tracksQuery=rest`; the selected tab, search value, and Research shell survived a full document reload.
- Findings search covered a real result, a no-match query, and a restored matching query. The result list and empty result state did not produce client errors.
- Primitives and Chains rendered their independent search/status/page-size controls while empty; Monitoring rendered all five metric panels; Files navigated from `scanning` to `full_scan`.
- Tasks rendered all 12 Research stages, queue counts, descriptive task names, running activity, finished rows, rerun controls, and cancel controls. Running rows did not use stage-name-only labels.
- Overview exposed the full Research graph and all expected routing edges. After UI cancellation, the page stopped showing active controls and refreshed to the canceled state.
- Dev API requests for `jobOverview`, `resultSummary`, `jobRunningTasks`, `jobQueueCounts`, `researchTracks`, and `listDirectory` returned 200 responses. No Broker 401/404, artifact-path validation error, or React error was observed. The only 403 was the development Next.js font request.
- Cancellation cleanup was checked in both UI and DB: the Job became `canceled`, no tasks remained `pending`, `starting`, or `running`, completed tasks had `downstreamDispatchStatus=completed`, and the task count did not change during a 20-second observation window.

Not executed in this run: narrow mobile viewport, a second Research Job for cross-job leakage, an unauthorized session, forced SSE/network interruption, and Primitive/Chain detail pages because this Job had no persisted rows for those entities. These remain required follow-up cases rather than passed cases.

- [ ] **Step 6: Validate parallel same-entity behavior**

Create or rerun two tasks targeting the same Track:

- both launch rather than one being canceled by a claim;
- both can read the same starting revision;
- one commits;
- the other receives a conflict from Python, rereads, and autonomously commits or abandons;
- no TypeScript `research.entity_claim_*` or `applyResearchRegistryEffect` logs exist.

- [ ] **Step 7: Validate Registry and artifacts**

Confirm:

- Tracks, Findings, Primitives, and Chains tabs read Agent-written rows.
- each entity revision increases only for committed state changes.
- retrying an already-applied absolute update does not increase revision.
- no event API request, event timeline, or event-table query remains.
- Discovery files remain available in Files and Session.
- a task that commits and then fails leaves its current entity state committed; task output/session provides the operational audit trail.
- no Broker 401/404/context errors occur.

- [ ] **Step 8: Validate performance and cleanup**

Confirm Registry list APIs remain below 500 ms p95 in dev. Cancel the test Job, verify no active containers, and verify no new database writes occur after cancellation.

---

## Acceptance Criteria

- Research Agents can read and mutate every retained Registry entity through Python.
- Every create/update/delete is invoked directly through a typed Python command; no generic mutation JSON or `apply-batch` exists.
- Each Python command is transactionally atomic for one entity and returns structured revision conflicts.
- The Agent, not TypeScript, decides retry, merge, supersede, repair partial cross-entity progress, or abandon.
- Same-entity tasks may execute concurrently.
- TypeScript does not acquire claims or write Research Registry entities.
- `research_entity_claims`, all four event tables, both `currentTaskId` columns, Broker runtime, and obsolete TypeScript writers are removed.
- Only current Track, Finding, Primitive, and Chain state remains queryable in the UI; Registry event history is intentionally removed.
- Retried absolute mutations use revision and current-state comparison; no `idempotencyKey` is stored.
- New Research Jobs contain no active `research-registry` effects.
- Dev end-to-end validation reaches Track Review without the previous `revision changed from 0 to 1` failure.
- Release remains untouched.
