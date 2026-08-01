DROP TABLE IF EXISTS "research_track_events";
DROP TABLE IF EXISTS "research_finding_events";
DROP TABLE IF EXISTS "exploit_primitive_events";
DROP TABLE IF EXISTS "exploit_chain_events";
DROP TABLE IF EXISTS "research_entity_claims";

ALTER TABLE "research_tracks" DROP COLUMN IF EXISTS "currentTaskId";
ALTER TABLE "research_findings" DROP COLUMN IF EXISTS "currentTaskId";
