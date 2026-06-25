# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Dokploy is a self-hostable Platform-as-a-Service (PaaS) for deploying applications and managing databases. The main application is a Next.js frontend with a tRPC API backend, using PostgreSQL, Redis, and Docker for container management.

## Tech Stack

- **Runtime**: Node.js v20.16.0 (use `.nvmrc`)
- **Package Manager**: pnpm v9.12.0+
- **Monorepo**: pnpm workspaces (`apps/*`, `packages/*`)
- **Frontend**: Next.js 15 (pages router, not app router), React 18, Tailwind CSS, Radix UI
- **API**: tRPC v10, superjson transformer
- **Database**: PostgreSQL with Drizzle ORM
- **Authentication**: better-auth v1.2.8-beta.7 (session-based)
- **Formatting/Linting**: Biome (NOT Prettier), lefthook for git hooks
- **Testing**: Vitest with `vite-tsconfig-paths`
- **Deployment**: Docker, Docker Swarm
- **Queues**: BullMQ (Redis-backed)
- **AI**: Vercel AI SDK (`ai` v5) with multiple providers (Anthropic, OpenAI, Azure, etc.)

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
├── dokploy/          # Main application (Next.js frontend + tRPC API)
├── api/              # Deployment API service (Inngest-based)
├── monitoring/       # Monitoring service
└── schedules/        # Scheduling service

packages/
└── server/           # Shared server code (@dokploy/server)
```

### Server Entrypoints

- **Dev**: `apps/dokploy/server/server.ts` (run via `tsx`)
- **Prod**: `apps/dokploy/dist/server.mjs` (built via esbuild)
- The server sets up: Next.js, WebSocket server, BullMQ workers, scheduled tasks

### API Layer (tRPC)

tRPC routers in `apps/dokploy/server/api/routers/` delegate to services in `packages/server/src/services/`. Routers handle HTTP concerns (validation, error mapping), services contain business logic.

**Procedure types** (defined in `apps/dokploy/server/api/trpc.ts`):
- `publicProcedure` — unauthenticated access
- `protectedProcedure` — requires valid session + user
- `adminProcedure` / `cliProcedure` — requires `role === "owner"`
- `uploadProcedure` — handles multipart form data (2GB max)

tRPC context includes: `session`, `user` (with `role`, `ownerId`), `db`, `req`, `res`.

### Database

Drizzle ORM with PostgreSQL. Schemas are defined in `packages/server/src/db/schema/` and re-exported via `packages/server/src/db/index.ts`. Migrations are in `apps/dokploy/drizzle/`. The `apps/dokploy/server/db/schema/index.ts` just re-exports from `@dokploy/server/db/schema`.

### BullMQ Queues

Defined in `apps/dokploy/server/queues/`:
- `deployments-queue` — application/deployment processing
- `scans-queue` — security scan job execution
- `scan-evaluations-queue` — scan evaluation processing

Redis connection is managed in `redis-connection.ts`.

### WebSocket System

WebSocket handlers in `apps/dokploy/server/wss/`:
- `docker-container-terminal.ts` — interactive Docker container terminals
- `docker-container-logs.ts` — streaming container logs
- `docker-stats.ts` — real-time resource stats
- `listen-deployment.ts` — deployment status updates
- `scan-stats.ts` — scan progress
- `terminal.ts` + `drawer-logs.ts` — server-side terminal/log streaming

### Scan Pipeline

The scan system (`packages/server/src/services/scan/`) is a multi-stage pipeline for security analysis:
- `stages/` — individual pipeline stages (function-scan, candidate-analysis, sink-pre-analyze, etc.)
- `pipeline/` — pipeline orchestration
- `api/` — external scan API integration
- `prompts/` — AI prompts for each stage
- `runtime/` — runtime/sandbox execution
- `state/` — scan state management
- `persistence/` — result persistence

### Pages and Routing

Uses Next.js **pages router** (not app router). Key page directories in `apps/dokploy/pages/dashboard/`:
- `application/`, `compose/`, `docker/`, `project/`, `monitoring/`
- `database/` (postgres, mysql, mongo, mariadb, redis)
- `settings/`, `scanning/`, `swarm/`

### i18n

Uses `next-i18next` with locale files in `apps/dokploy/public/locales/{lang}/` (e.g., `en/`, `zh-Hans/`).

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

Note: in dev mode (`server:script`), imports resolve to `src/` directly. In production, they resolve to `dist/`.

### Patched Dependencies

`sandbox-agent@0.4.2` has a patch at `packages/server/src/services/dockerfiles/sandbox-agent@0.4.2.patch`.

## Authentication

Uses `better-auth` with session-based authentication. The `validateRequest` function from `@dokploy/server/lib/auth` is used in tRPC context creation. User roles: `owner`, `admin`, `member`. Each user belongs to an organization (multi-tenant).

## Development Setup

```bash
# 1. Install dependencies
pnpm install

# 2. Copy environment file
cp apps/dokploy/.env.example apps/dokploy/.env

# 3. Setup (creates config, runs migrations)
pnpm run dokploy:setup

# 4. Switch server package to dev mode (resolves @dokploy/server imports to src/)
pnpm run server:script

# 5. Start development
pnpm run dokploy:dev
```

## Testing

Tests are in `apps/dokploy/__test__/` organized by domain. Uses Vitest with `vite-tsconfig-paths` for path aliases and `pool: "forks"`. Test config at `apps/dokploy/__test__/vitest.config.ts`.

```bash
# Run all tests
pnpm run test

# Run specific test file
pnpm vitest run __test__/compose/compose.test.ts

# Watch mode
pnpm vitest __test__/compose/

# Run tests with filter by name
pnpm vitest run __test__/ -t "test name pattern"
```
