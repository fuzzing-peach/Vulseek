ALTER TABLE "application"
ADD COLUMN "verifyImmediately" boolean NOT NULL DEFAULT false;

ALTER TABLE "compose"
ADD COLUMN "verifyImmediately" boolean NOT NULL DEFAULT false;
