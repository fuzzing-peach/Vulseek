DO $$ BEGIN
  ALTER TYPE "scanType" ADD VALUE IF NOT EXISTS 'research';
EXCEPTION
  WHEN undefined_object THEN
    CREATE TYPE "scanType" AS ENUM ('delta', 'full', 'research');
END $$;

ALTER TABLE "scan_jobs"
  ALTER COLUMN "scanType" TYPE "scanType"
  USING "scanType"::text::"scanType";

CREATE TABLE IF NOT EXISTS "research_tracks" (
  "trackId" text PRIMARY KEY NOT NULL,
  "scanJobId" text NOT NULL REFERENCES "scan_jobs"("scanJobId") ON DELETE CASCADE,
  "trackKey" text NOT NULL,
  "approachFamily" text NOT NULL,
  "researchIdea" text NOT NULL,
  "scope" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "mechanisms" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "status" text NOT NULL DEFAULT 'queued',
  "coverage" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "evidenceRefs" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "candidateFindingIds" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "blockReason" text,
  "reopenCondition" text,
  "nextStep" text,
  "iteration" integer NOT NULL DEFAULT 0,
  "currentTaskId" text REFERENCES "tasks"("taskId") ON DELETE SET NULL,
  "revision" integer NOT NULL DEFAULT 0,
  "createdAt" text NOT NULL,
  "updatedAt" text NOT NULL
);
CREATE INDEX IF NOT EXISTS "research_tracks_scan_job_idx" ON "research_tracks" ("scanJobId", "updatedAt");
CREATE INDEX IF NOT EXISTS "research_tracks_key_idx" ON "research_tracks" ("scanJobId", "trackKey");
CREATE UNIQUE INDEX IF NOT EXISTS "research_tracks_scan_job_key_unique" ON "research_tracks" ("scanJobId", "trackKey");

CREATE TABLE IF NOT EXISTS "research_track_events" (
  "eventId" text PRIMARY KEY NOT NULL,
  "scanJobId" text NOT NULL REFERENCES "scan_jobs"("scanJobId") ON DELETE CASCADE,
  "trackId" text NOT NULL REFERENCES "research_tracks"("trackId") ON DELETE CASCADE,
  "eventType" text NOT NULL,
  "actorTaskId" text REFERENCES "tasks"("taskId") ON DELETE SET NULL,
  "sourceStage" text NOT NULL,
  "expectedRevision" integer,
  "resultingRevision" integer NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "evidenceRefs" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "idempotencyKey" text NOT NULL UNIQUE,
  "createdAt" text NOT NULL
);
CREATE INDEX IF NOT EXISTS "research_track_events_track_idx" ON "research_track_events" ("trackId", "createdAt");
CREATE INDEX IF NOT EXISTS "research_track_events_job_idx" ON "research_track_events" ("scanJobId", "createdAt");

CREATE TABLE IF NOT EXISTS "exploit_primitives" (
  "primitiveId" text PRIMARY KEY NOT NULL,
  "scanJobId" text NOT NULL REFERENCES "scan_jobs"("scanJobId") ON DELETE CASCADE,
  "candidateId" text NOT NULL,
  "name" text NOT NULL,
  "capability" text NOT NULL,
  "requiredInput" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "producedCapability" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "trustLevel" text NOT NULL,
  "status" text NOT NULL DEFAULT 'confirmed',
  "evidenceRefs" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "revision" integer NOT NULL DEFAULT 0,
  "createdAt" text NOT NULL,
  "updatedAt" text NOT NULL
);
CREATE INDEX IF NOT EXISTS "exploit_primitives_scan_job_idx" ON "exploit_primitives" ("scanJobId", "updatedAt");
CREATE INDEX IF NOT EXISTS "exploit_primitives_candidate_idx" ON "exploit_primitives" ("scanJobId", "candidateId");

CREATE TABLE IF NOT EXISTS "exploit_primitive_events" (
  "eventId" text PRIMARY KEY NOT NULL,
  "scanJobId" text NOT NULL REFERENCES "scan_jobs"("scanJobId") ON DELETE CASCADE,
  "primitiveId" text NOT NULL REFERENCES "exploit_primitives"("primitiveId") ON DELETE CASCADE,
  "eventType" text NOT NULL,
  "actorTaskId" text REFERENCES "tasks"("taskId") ON DELETE SET NULL,
  "sourceStage" text NOT NULL,
  "expectedRevision" integer,
  "resultingRevision" integer NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "evidenceRefs" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "idempotencyKey" text NOT NULL UNIQUE,
  "createdAt" text NOT NULL
);
CREATE INDEX IF NOT EXISTS "exploit_primitive_events_idx" ON "exploit_primitive_events" ("primitiveId", "createdAt");

CREATE TABLE IF NOT EXISTS "exploit_chains" (
  "chainId" text PRIMARY KEY NOT NULL,
  "scanJobId" text NOT NULL REFERENCES "scan_jobs"("scanJobId") ON DELETE CASCADE,
  "chainKey" text NOT NULL,
  "status" text NOT NULL DEFAULT 'candidate',
  "steps" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "entrypoint" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "requiredCapabilities" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "producedCapabilities" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "trustBoundaryCrossings" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "deploymentConditions" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "primitiveGaps" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "successTarget" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "revision" integer NOT NULL DEFAULT 0,
  "createdAt" text NOT NULL,
  "updatedAt" text NOT NULL
);
CREATE INDEX IF NOT EXISTS "exploit_chains_scan_job_idx" ON "exploit_chains" ("scanJobId", "updatedAt");
CREATE INDEX IF NOT EXISTS "exploit_chains_key_idx" ON "exploit_chains" ("scanJobId", "chainKey");

CREATE TABLE IF NOT EXISTS "exploit_chain_events" (
  "eventId" text PRIMARY KEY NOT NULL,
  "scanJobId" text NOT NULL REFERENCES "scan_jobs"("scanJobId") ON DELETE CASCADE,
  "chainId" text NOT NULL REFERENCES "exploit_chains"("chainId") ON DELETE CASCADE,
  "eventType" text NOT NULL,
  "actorTaskId" text REFERENCES "tasks"("taskId") ON DELETE SET NULL,
  "sourceStage" text NOT NULL,
  "expectedRevision" integer,
  "resultingRevision" integer NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "evidenceRefs" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "idempotencyKey" text NOT NULL UNIQUE,
  "createdAt" text NOT NULL
);
CREATE INDEX IF NOT EXISTS "exploit_chain_events_idx" ON "exploit_chain_events" ("chainId", "createdAt");
