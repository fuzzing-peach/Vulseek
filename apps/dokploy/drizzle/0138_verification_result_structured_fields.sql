ALTER TABLE "verification_results"
ADD COLUMN IF NOT EXISTS "isBug" boolean,
ADD COLUMN IF NOT EXISTS "isSecurity" boolean,
ADD COLUMN IF NOT EXISTS "confidence" real;
