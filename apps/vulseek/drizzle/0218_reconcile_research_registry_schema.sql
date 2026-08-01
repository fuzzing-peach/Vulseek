DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'research_tracks' AND column_name = 'candidateFindingIds'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'research_tracks' AND column_name = 'findingIds'
  ) THEN
    ALTER TABLE "research_tracks"
      RENAME COLUMN "candidateFindingIds" TO "findingIds";
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'exploit_primitives' AND column_name = 'candidateId'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'exploit_primitives' AND column_name = 'findingId'
  ) THEN
    ALTER TABLE "exploit_primitives"
      RENAME COLUMN "candidateId" TO "findingId";
  END IF;
END $$;

DROP INDEX IF EXISTS "exploit_primitives_candidate_idx";
CREATE INDEX IF NOT EXISTS "exploit_primitives_finding_idx"
  ON "exploit_primitives" ("scanJobId", "findingId");

CREATE TABLE IF NOT EXISTS "research_findings" (
  "scanJobId" text NOT NULL REFERENCES "scan_jobs"("scanJobId") ON DELETE CASCADE,
  "findingId" text NOT NULL,
  "trackId" text NOT NULL REFERENCES "research_tracks"("trackId") ON DELETE CASCADE,
  "producerTaskId" text REFERENCES "tasks"("taskId") ON DELETE SET NULL,
  "content" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'discovered',
  "latestValidationVerdict" text,
  "latestReviewDecision" text,
  "requiredEvidence" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "currentTaskId" text REFERENCES "tasks"("taskId") ON DELETE SET NULL,
  "revision" integer NOT NULL DEFAULT 0,
  "createdAt" text NOT NULL,
  "updatedAt" text NOT NULL,
  PRIMARY KEY ("scanJobId", "findingId")
);

CREATE INDEX IF NOT EXISTS "research_findings_scan_job_idx"
  ON "research_findings" ("scanJobId", "updatedAt");
CREATE INDEX IF NOT EXISTS "research_findings_status_idx"
  ON "research_findings" ("scanJobId", "status");
CREATE INDEX IF NOT EXISTS "research_findings_track_idx"
  ON "research_findings" ("scanJobId", "trackId");

CREATE TABLE IF NOT EXISTS "research_finding_events" (
  "eventId" text PRIMARY KEY NOT NULL,
  "scanJobId" text NOT NULL REFERENCES "scan_jobs"("scanJobId") ON DELETE CASCADE,
  "findingId" text NOT NULL,
  "eventType" text NOT NULL,
  "actorTaskId" text REFERENCES "tasks"("taskId") ON DELETE SET NULL,
  "sourceStage" text NOT NULL,
  "expectedRevision" integer,
  "resultingRevision" integer NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "evidenceRefs" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "idempotencyKey" text NOT NULL UNIQUE,
  "createdAt" text NOT NULL,
  CONSTRAINT "research_finding_events_finding_fk"
    FOREIGN KEY ("scanJobId", "findingId")
    REFERENCES "research_findings" ("scanJobId", "findingId")
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "research_finding_events_finding_idx"
  ON "research_finding_events" ("scanJobId", "findingId", "createdAt");
