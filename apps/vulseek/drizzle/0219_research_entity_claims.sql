CREATE TABLE IF NOT EXISTS "research_entity_claims" (
  "scanJobId" text NOT NULL,
  "stageName" text NOT NULL,
  "entityType" text NOT NULL,
  "entityKey" text NOT NULL,
  "expectedRevision" integer NOT NULL,
  "taskId" text NOT NULL,
  "status" text NOT NULL DEFAULT 'claimed',
  "claimedAt" text NOT NULL,
  "leaseExpiresAt" text NOT NULL,
  "completedAt" text,
  "updatedAt" text NOT NULL,
  PRIMARY KEY ("scanJobId", "stageName", "entityType", "entityKey", "expectedRevision")
);

CREATE INDEX IF NOT EXISTS "research_entity_claims_task_idx"
  ON "research_entity_claims" ("taskId");
CREATE INDEX IF NOT EXISTS "research_entity_claims_active_idx"
  ON "research_entity_claims" ("scanJobId", "stageName", "status");
