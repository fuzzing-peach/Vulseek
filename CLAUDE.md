# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Vulseek** is a security-focused fork of Dokploy — a self-hostable Platform-as-a-Service (PaaS). Vulseek extends Dokploy with an AI-powered multi-stage vulnerability scanning pipeline that uses LLM agents inside sandbox containers to discover, analyze, and verify security vulnerabilities in source code repositories.

Core upstream: Next.js frontend + tRPC API backend + PostgreSQL + Redis + Docker.

**Deployment modes** — The system runs in two modes controlled by `IS_CLOUD` env var:
- **Self-hosted** (`IS_CLOUD !== "true"`): Dokploy manages its own Docker engine. Starts Traefik, networks, cron jobs, BullMQ workers, and auto-delta-scan polling on boot.
- **Cloud** (`IS_CLOUD === "true"`): Managed service mode. Only runs DB migration and env sync — no local Docker management. The `apps/api` service handles deployment via Inngest.

## Tech Stack

- **Runtime**: Node.js v20.16.0 (use `.nvmrc`)
- **Package Manager**: pnpm v9.12.0+
- **Monorepo**: pnpm workspaces (`apps/*`, `packages/*`)
- **Frontend**: Next.js 15 (pages router), React 18, Tailwind CSS, Radix UI
- **API**: tRPC v10, superjson transformer
- **Database**: PostgreSQL with Drizzle ORM
- **Authentication**: better-auth v1.2.8-beta.7 (session-based)
- **Formatting/Linting**: Biome (NOT Prettier), lefthook for git hooks
- **Testing**: Vitest with `vite-tsconfig-paths`
- **Deployment**: Docker, Docker Swarm
- **Queues**: BullMQ (Redis-backed)
- **AI**: Vercel AI SDK (`ai` v5); agent profiles support both **Codex** and **Claude Code** providers with configurable `api_key` or `host_home` auth modes

## Common Commands

```bash
# Development
pnpm run dokploy:dev          # Start development server (Next.js + API)
pnpm run dokploy:dev:turbopack # Start with Turbopack
pnpm run dokploy:setup         # Initial setup (creates .env, runs migrations)
pnpm run server:script         # Switch packages/server to dev mode (src imports)

# Building
pnpm run dokploy:build         # Build for production (esbuild server + next build)
pnpm run dokploy:start         # Start production server
pnpm run docker:build:canary   # Build Docker image

# Code Quality
pnpm run format-and-lint       # Check biome
pnpm run format-and-lint:fix   # Fix biome issues
pnpm run typecheck             # TypeScript type checking (all packages)

# Database (run from repo root)
pnpm --filter=dokploy run migration:generate  # Generate Drizzle migration
pnpm --filter=dokploy run migration:run        # Run migrations
pnpm --filter=dokploy run db:studio            # Open Drizzle Studio
pnpm --filter=dokploy run db:push              # Push schema directly to DB

# Testing
pnpm run test                    # Run all tests
pnpm --filter=dokploy run test   # Run tests in dokploy app only
pnpm vitest run __test__/compose/compose.test.ts  # Run a single test file
pnpm vitest __test__/compose/                     # Watch mode for a directory
```

## Architecture

### Monorepo Structure

```
apps/
├── dokploy/          # Main app (Next.js frontend + tRPC API + BullMQ workers)
├── api/              # Deployment API service (Hono + Inngest, event-driven)
├── monitoring/       # Monitoring service (Go + Fiber)
└── schedules/        # Scheduling service (Hono + BullMQ, cron backups)

packages/
└── server/           # @dokploy/server — business logic, DB schemas, scan pipeline, builders

agents/
└── skills/           # AI agent skill definitions (Markdown) for each scan stage
```

### Microservices Detail

- **`apps/api`** — Hono REST service. Receives deployment requests and dispatches them via Inngest (event-driven, concurrency 1 per serverId, supports cancellation, no retries).
- **`apps/monitoring`** — **Go** (Fiber HTTP) service. Collects system/container metrics on configurable intervals, stores in embedded DB, sends threshold-violation callbacks to Dokploy.
- **`apps/schedules`** — Hono REST service. Manages cron-scheduled backup jobs via BullMQ repeatable jobs (3 workers × 100 concurrency).

### Server Entrypoints

- **Dev**: `apps/dokploy/server/server.ts` (run via `tsx`)
- **Prod**: `apps/dokploy/dist/server.mjs` (built via esbuild)
- Startup sequence: Next.js → WebSocket server → (self-hosted: Traefik config, network, cron, BullMQ workers, auto-delta-scan)

### API Layer (tRPC)

tRPC routers in `apps/dokploy/server/api/routers/` delegate to services in `packages/server/src/services/`. Routers handle HTTP concerns; services contain business logic.

**Procedure types** (`apps/dokploy/server/api/trpc.ts`):
- `publicProcedure` — unauthenticated
- `protectedProcedure` — valid session + user required
- `adminProcedure` / `cliProcedure` — `role === "owner"`
- `uploadProcedure` — multipart form data (2GB max)

Context: `session`, `user` (with `role`, `ownerId`), `db`, `req`, `res`.

### Database

PostgreSQL + Drizzle ORM. Schemas in `packages/server/src/db/schema/`, migrations in `apps/dokploy/drizzle/`. Key Vulseek schema additions: `scan_jobs` (with `status`, `paused`/`failed`/`canceled` support), `tasks` (with `scanStage` metadata), `scanStageSettings`, `agentProfiles`.

### Authentication & Multi-Tenancy

`better-auth` session-based auth. Roles: `owner`, `admin`, `member`. Multi-tenant via `activeOrganizationId` session field.

### Docker Integration & Traefik

- Uses `dockerode` library. Supports local Docker (`/var/run/docker.sock`) and remote servers (SSH via `ssh2`).
- Traefik handles reverse proxy, SSL (Let's Encrypt ACME), HTTP/3. Two modes: standalone container (single-node) and Swarm Service (cluster). Dynamic YAML config in `/etc/dokploy/traefik/dynamic/`.

### Application Builders

Five strategies in `packages/server/src/utils/builders/`: Nixpacks, Dockerfile, Herokuish, Paketo, Static.

---

## Vulseek Scan Pipeline

This is the primary Vulseek contribution — an AI-driven multi-stage vulnerability scanning system.

### Scan Job Lifecycle

Scan jobs progress through states: `pending` → `running` → `completed` / `failed` / `paused` / `canceled`. Jobs support **pause**, **resume**, and **cancel** operations. Two scan modes:
- **Full scan** — complete repository analysis from scratch
- **Delta scan** — incremental re-scan of changed modules since the last scan

The `auto-delta-scan` utility (`apps/dokploy/server/utils/auto-delta-scan.ts`) periodically polls for new commits and triggers delta scans.

### Full Scan Pipeline — Two Parallel Branches

The full scan pipeline (`packages/server/src/services/scan/stages/`) has two independent branches that run in parallel, connected at the verify/triage stage:

#### Rule-Based Branch (pattern matching approach)

```
delta-scope → repository-scan → module-scan → module-threat-model
                                                       │
                                          ┌────────────┴────────────┐
                                          ▼                         ▼
                                    design-rule              attack-surface-model
                                          │                         │
                                          ▼                         ▼
                                      scan-rule              identify-target
                                          │                         │
                                          ▼                         ▼
                                    scan-pattern               scan-target
                                          │                         │
                                          └──────────┬──────────────┘
                                                     ▼
                                              sink-pre-analyze
                                                     │
                                                     ▼
                                               function-scan
```

#### Function-Based Branch (deep analysis approach)

```
attack-surface-model → identify-target → scan-target → function-scan
                                                             │
                                      ┌──────────────────────┘
                                      ▼
                                   analyze ──(loop)──► criticize
                                      │
                                      ▼
                                    verify → triage
```

#### Stage Summary

| Stage | AI Agent? | Purpose |
|-------|:---------:|---------|
| `delta-scope` | ✓ | Determine which modules changed since last scan |
| `repository-scan` | ✓ | Profile repository structure, identify modules |
| `module-scan` | ✓ | Deep-dive into a single module |
| `module-threat-model` | ✗ | Algorithmically infer threat model from module metadata (sink classes, trust boundaries, entrypoints) |
| `attack-surface-model` | ✓ | AI-driven attack surface analysis for a module |
| `design-rule` | ✓ | Design custom scan rules (semgrep-like patterns) for the module based on threat model |
| `scan-rule` | ✓ | Execute rule-based scanning using generated rules |
| `scan-pattern` | ✗ | Run structured grep/pattern matching based on rule plans |
| `identify-target` | ✓ | Identify high-value vulnerability targets within a module |
| `scan-target` | ✓ | Deep vulnerability scan on a specific target (file/function/API) |
| `sink-pre-analyze` | ✗ | Convert rule findings into structured candidates, normalize candidate IDs, deduplicate |
| `function-scan` | ✓ | Function-level vulnerability discovery |
| `analyze` / `analyze-finding` | ✓ | In-depth analysis with CodeQL, path tracing, critic review loop |
| `criticize` | ✓ | Adversarial critic that challenges or confirms analysis findings |
| `verify` / `verify-finding` | ✓ | Final verification of analyzed vulnerabilities |
| `triage` | ✗ | Classify, score (CVSS, EPSS), and prioritize verified findings |

### Agent Runtime Architecture

Each AI-powered stage runs an agent inside a **Docker sandbox container**:
- Container orchestrated via `agent-stage-runtime.ts` — handles launch, reuse, persistence, thread management
- Agent communicates via structured JSON output (Zod schemas validated at each stage)
- Supports **persistent containers** across related stages (e.g., attack-surface-model → identify-target → scan-target share a container via `laneThreadId`)
- `codexHome` and `host_home` modes for agent auth
- `runSingleTurnAgentInContainer` (`runtime/run-single-turn-agent.ts`) — the core agent invocation primitive
- `runAgentStageRuntime` — manages container lifecycle, task directories, stage input/output

### Agent Skills

23 agent skill definitions in `agents/skills/` — each is a Markdown file with detailed instructions for a specific scan stage. Key skills: `analyze`, `verify`, `scan-function`, `scan-target`, `identify-target`, `attack-surface-model`, `design-rule`, `full-scan`, `delta-scan`, `semgrep`, `codeql`, `serena`, `tree-sitter`, `libafl`, `address-sanitizer`, etc.

### Candidate Management

Vulnerability **candidates** flow through the pipeline as structured JSON artifacts:
- `candidate-id.ts` — deterministic candidate ID generation
- `candidate-manifest-normalizer.ts` — rewrites candidate IDs in manifests after stage outputs, deduplicates against seen IDs
- Artifact contracts (`artifacts/contracts/domain-object.contract.ts`) — Zod schemas for all domain objects (Candidate, RuleFinding, Module, Target, Analysis, Verification, Triage, etc.)
- Task artifacts read/written via `artifacts/task-artifact-paths.ts`

### Queue Architecture

| Queue | Worker | Purpose | Concurrency |
|-------|--------|---------|-------------|
| `deployments` | `deploymentWorker` | App/Compose/Preview deployment (local + remote) | — |
| `scans` | `scansWorker` | Full & delta scan job execution | 16 (plus semaphore for scan-level limit) |
| `scan-evaluations` | `scanEvaluationsWorker` | Post-scan evaluation | 2 |

The scans-queue uses a **semaphore** (`acquireScanExecutionSlot`) that allows fine-grained concurrency beyond the worker count — limits concurrent scan *executions* (not just BullMQ jobs).

Stage-level concurrency is further controllable via `resolveStageConcurrencySetting`, which respects per-stage defaults (e.g., `analyze` = 2, `verify` = 1, module stages = 4).

**Queue job deduplication** (`queue-job-ids.ts`): Maps stage names to deduplication keys so that related tasks share queue slots instead of competing independently. Groups stages: `repository:scanJobId`, `module:taskId`, `function:taskId`, `analysis:taskId`, `verification:taskId`, etc.

### WebSocket System

Handlers in `apps/dokploy/server/wss/`:
- `docker-container-terminal.ts` — interactive Docker container terminals (xterm.js)
- `docker-container-logs.ts` — streaming container logs
- `docker-stats.ts` — real-time resource stats (self-hosted only)
- `listen-deployment.ts` — deployment status updates
- `scan-stats.ts` — live token throughput, scan progress, task status streaming (self-hosted only)
- `terminal.ts` + `drawer-logs.ts` — server-side terminal/log streaming

### UI — Scan-Specific Pages

- `pages/dashboard/scanning/` — scan job listing, creation, detail views
- `pages/dashboard/scan-review-terminal.tsx` — scan review terminal for agent interaction (new in Vulseek)
- `show-scan-stage-graph.tsx` — interactive scan pipeline DAG visualization
- `show-scan-candidate-detail.tsx` — vulnerability candidate drill-down
- Agent profile configuration (`show-agent-profile.tsx`)
- Local file directory provider selector for source input

### Key Vulseek Schema Additions

- `scanStageSettings` — per-stage agent profile + concurrency configuration
- `scanRuntimeSettings` — runtime stage toggling (enable/disable stages)
- `agentProfiles` — Codex/Claude Code agent configurations (model, provider, auth mode, thinking level, envs)
- `ruleScanType` — distinguishes rule-based from function-based scan approaches
- `applicationTargetTag` — tagging for scan targets
- `autoDeltaScan` — per-application auto-delta-scan toggle (default `false`)
- `localSourceType` — local directory-based source provider

### i18n

Uses `next-i18next`. Locale files: `apps/dokploy/public/locales/{en,zh-Hans}/`. Scan-related strings in `scan.json`.

### Key Package Exports (`@dokploy/server`)

```json
{
  ".": "./src/index.ts",
  "./db": "./src/db/index.ts",
  "./db/schema": "./src/db/schema/index.ts",
  "./db/schema/*": "./src/db/schema/*.ts",
  "./setup/*": "./src/setup/*.ts",
  "./constants": "./src/constants/index.ts"
}
```

Dev mode (`pnpm run server:script`): imports resolve to `src/`. Production: resolve to `dist/`.

### Patched Dependencies

`sandbox-agent@0.4.2` patch at `packages/server/src/services/dockerfiles/sandbox-agent@0.4.2.patch`.

## Development Setup

```bash
# 1. Install dependencies
pnpm install

# 2. Copy environment file
cp apps/dokploy/.env.example apps/dokploy/.env

# 3. Setup
pnpm run dokploy:setup

# 4. Switch to dev mode (src imports for @dokploy/server)
pnpm run server:script

# 5. Start development
pnpm run dokploy:dev
```

## Testing

Tests in `apps/dokploy/__test__/`. Uses Vitest with `vite-tsconfig-paths` and `pool: "forks"`. Test config at `apps/dokploy/__test__/vitest.config.ts`. Vulseek has scan-specific contract tests in `packages/server/src/services/scan/` (e.g., `rule-scan.contract.test.ts`, `retry-failed-tasks.test.ts`, `scan-state-machine.test.ts`, `fuzz-run.stage.test.ts`).

```bash
pnpm run test
pnpm vitest run __test__/compose/compose.test.ts
pnpm vitest __test__/compose/
pnpm vitest run __test__/ -t "test name pattern"
```
