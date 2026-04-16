# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Dokploy is a self-hostable Platform-as-a-Service (PaaS) for deploying applications and managing databases. The main application is a Next.js frontend with a tRPC API backend, using PostgreSQL, Redis, and Docker for container management.

## Tech Stack

- **Runtime**: Node.js v20.16.0 (use `.nvmrc`)
- **Package Manager**: pnpm v9.12.0+
- **Monorepo**: pnpm workspaces (`apps/*`, `packages/*`)
- **Frontend**: Next.js 15, React 18, Tailwind CSS, Radix UI
- **API**: tRPC v10, superjson transformer
- **Database**: PostgreSQL with Drizzle ORM
- **Authentication**: better-auth
- **Formatting/Linting**: Biome (NOT Prettier)
- **Testing**: Vitest
- **Deployment**: Docker, Docker Swarm

## Common Commands

```bash
# Development
pnpm run dokploy:dev          # Start development server (Next.js + API)
pnpm run dokploy:dev:turbopack # Start with Turbopack
pnpm run dokploy:setup         # Initial setup (creates .env, runs migrations)
pnpm run server:script         # Switch to dev mode for packages/server

# Building
pnpm run dokploy:build         # Build for production
pnpm run dokploy:start         # Start production server
pnpm run docker:build:canary   # Build Docker image

# Code Quality
pnpm run format-and-lint       # Check biome
pnpm run format-and-lint:fix   # Fix biome issues
pnpm run typecheck             # TypeScript type checking

# Database
pnpm --filter=dokploy run migration:generate  # Generate Drizzle migration
pnpm --filter=dokploy run migration:run        # Run migrations
pnpm --filter=dokploy run db:studio            # Open Drizzle Studio

# Testing
pnpm run test                  # Run all tests (vitest)
pnpm --filter=dokploy run test  # Run tests in dokploy app only
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
└── server/           # Shared server code, services, DB schemas
```

### Key Directories in `apps/dokploy`

- `server/api/routers/` - tRPC routers for each domain (application, postgres, mysql, docker, etc.)
- `server/api/trpc.ts` - tRPC context and procedure definitions (publicProcedure, protectedProcedure, adminProcedure)
- `server/db/schema/` - Drizzle ORM schema definitions
- `server/queues/` - BullMQ queues for deployment processing
- `server/wss/` - WebSocket handlers for logs, terminals, stats
- `__test__/` - Vitest tests organized by domain

### Key Directories in `packages/server`

- `src/services/` - Business logic services consumed by tRPC routers
- `src/db/schema/` - Database schemas shared across apps
- `src/utils/` - Utility functions (Docker, backups, notifications, Traefik config)
- `src/setup/` - Server initialization logic

### API Pattern

tRPC routers in `apps/dokploy/server/api/routers/` delegate to services in `packages/server/src/services/`. Routers handle HTTP concerns (validation, error mapping), services contain business logic.

## Development Setup

```bash
# 1. Install dependencies
pnpm install

# 2. Copy environment file
cp apps/dokploy/.env.example apps/dokploy/.env

# 3. Setup (creates config, runs migrations)
pnpm run dokploy:setup

# 4. Switch server package to dev mode
pnpm run server:script

# 5. Start development
pnpm run dokploy:dev
```

## Testing

Tests are in `apps/dokploy/__test__/` organized by domain (compose, deploy, etc.). Tests use Vitest with `vite-tsconfig-paths` for path aliases.

```bash
# Run all tests
pnpm run test

# Run specific test file
pnpm vitest run __test__/compose/compose.test.ts

# Watch mode
pnpm vitest __test__/compose/
```

## Authentication

Uses `better-auth` with session-based authentication. The `validateRequest` function from `@dokploy/server/lib/auth` is used in tRPC context creation. User roles: `owner`, `admin`, `member`.

## Database

Drizzle ORM is used for database access. Schemas are in `packages/server/src/db/schema/` and exposed via `packages/server/src/db/index.ts`. Migrations are managed with `drizzle-kit`.

## Build Tools

- **esbuild**: Used in `packages/server` for building
- **tsx**: For running TypeScript files directly during development
- **Biome**: Code formatter and linter (configured in `biome.json` or similar)

## Deployment

The `docker/` directory contains build scripts. Production builds use multi-stage Dockerfiles. The application can be deployed standalone or with Docker Swarm for clustering.
