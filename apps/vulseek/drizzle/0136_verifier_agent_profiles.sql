ALTER TABLE "application"
ADD COLUMN "verifierAgentProfileId" text;

ALTER TABLE "compose"
ADD COLUMN "verifierAgentProfileId" text;

ALTER TABLE "application"
ADD CONSTRAINT "application_verifierAgentProfileId_agent_profiles_agentProfileId_fk"
FOREIGN KEY ("verifierAgentProfileId") REFERENCES "public"."agent_profiles"("agentProfileId")
ON DELETE set null ON UPDATE no action;

ALTER TABLE "compose"
ADD CONSTRAINT "compose_verifierAgentProfileId_agent_profiles_agentProfileId_fk"
FOREIGN KEY ("verifierAgentProfileId") REFERENCES "public"."agent_profiles"("agentProfileId")
ON DELETE set null ON UPDATE no action;

UPDATE "application"
SET "verifierAgentProfileId" = "analysisAgentProfileId"
WHERE "analysisAgentProfileId" IS NOT NULL;

UPDATE "compose"
SET "verifierAgentProfileId" = "analysisAgentProfileId"
WHERE "analysisAgentProfileId" IS NOT NULL;
