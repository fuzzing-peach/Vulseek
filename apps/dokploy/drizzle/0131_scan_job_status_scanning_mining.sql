ALTER TYPE "scanJobStatus" RENAME VALUE 'running' TO 'scanning';
ALTER TYPE "scanJobStatus" ADD VALUE IF NOT EXISTS 'mining';
