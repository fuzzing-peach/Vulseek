-- Change token count columns from integer (int4) to bigint (int8)
-- to prevent integer overflow when cumulative token counts exceed 2,147,483,647

ALTER TABLE "scan_jobs"
  ALTER COLUMN "input_tokens" TYPE bigint,
  ALTER COLUMN "output_tokens" TYPE bigint,
  ALTER COLUMN "thought_tokens" TYPE bigint,
  ALTER COLUMN "total_tokens" TYPE bigint,
  ALTER COLUMN "cached_read_tokens" TYPE bigint,
  ALTER COLUMN "cached_write_tokens" TYPE bigint;

ALTER TABLE "tasks"
  ALTER COLUMN "input_tokens" TYPE bigint,
  ALTER COLUMN "output_tokens" TYPE bigint,
  ALTER COLUMN "thought_tokens" TYPE bigint,
  ALTER COLUMN "total_tokens" TYPE bigint,
  ALTER COLUMN "cached_read_tokens" TYPE bigint,
  ALTER COLUMN "cached_write_tokens" TYPE bigint;
