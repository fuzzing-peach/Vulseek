ALTER TABLE "application"
ADD COLUMN "scanAgentProfileId" text;

ALTER TABLE "application"
ADD COLUMN "analysisAgentProfileId" text;

ALTER TABLE "compose"
ADD COLUMN "scanAgentProfileId" text;

ALTER TABLE "compose"
ADD COLUMN "analysisAgentProfileId" text;

ALTER TABLE "application"
ADD CONSTRAINT "application_scanAgentProfileId_agent_profiles_agentProfileId_fk"
FOREIGN KEY ("scanAgentProfileId") REFERENCES "public"."agent_profiles"("agentProfileId")
ON DELETE set null ON UPDATE no action;

ALTER TABLE "application"
ADD CONSTRAINT "application_analysisAgentProfileId_agent_profiles_agentProfileId_fk"
FOREIGN KEY ("analysisAgentProfileId") REFERENCES "public"."agent_profiles"("agentProfileId")
ON DELETE set null ON UPDATE no action;

ALTER TABLE "compose"
ADD CONSTRAINT "compose_scanAgentProfileId_agent_profiles_agentProfileId_fk"
FOREIGN KEY ("scanAgentProfileId") REFERENCES "public"."agent_profiles"("agentProfileId")
ON DELETE set null ON UPDATE no action;

ALTER TABLE "compose"
ADD CONSTRAINT "compose_analysisAgentProfileId_agent_profiles_agentProfileId_fk"
FOREIGN KEY ("analysisAgentProfileId") REFERENCES "public"."agent_profiles"("agentProfileId")
ON DELETE set null ON UPDATE no action;

UPDATE "application"
SET
	"scanAgentProfileId" = "agentProfileId",
	"analysisAgentProfileId" = "agentProfileId"
WHERE "agentProfileId" IS NOT NULL;
