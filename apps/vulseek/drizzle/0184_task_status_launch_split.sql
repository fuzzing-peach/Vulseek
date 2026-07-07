ALTER TYPE "public"."taskStatus" ADD VALUE IF NOT EXISTS 'launched';
--> statement-breakpoint
ALTER TYPE "public"."taskStatus" ADD VALUE IF NOT EXISTS 'starting';
