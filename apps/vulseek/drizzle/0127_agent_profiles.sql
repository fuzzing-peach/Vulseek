DO $$ BEGIN
 CREATE TYPE "public"."agentProvider" AS ENUM('codex', 'claude_code');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "agent_profiles" (
	"agentProfileId" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"provider" "agentProvider" DEFAULT 'codex' NOT NULL,
	"baseUrl" text NOT NULL,
	"apiKey" text NOT NULL,
	"thinkingLevel" text DEFAULT 'medium' NOT NULL,
	"isEnabled" boolean DEFAULT true NOT NULL,
	"organizationId" text NOT NULL,
	"createdAt" text NOT NULL
);

DO $$ BEGIN
 ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "application" ADD COLUMN IF NOT EXISTS "agentProfileId" text;

DO $$ BEGIN
 ALTER TABLE "application" ADD CONSTRAINT "application_agentProfileId_agent_profiles_agentProfileId_fk" FOREIGN KEY ("agentProfileId") REFERENCES "public"."agent_profiles"("agentProfileId") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
