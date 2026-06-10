import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execAsync } from "../../../utils/process/execAsync";

const escapeSingleQuotes = (value: string) => value.replace(/'/g, `'"'"'`);

export const installRuntimeSkillsInContainer = async (input: {
  containerName: string;
  agentsDir: string | null;
  skillNames: readonly string[];
  logPath?: string | null;
}) => {
  const log = async (message: string) => {
    if (!input.logPath) {
      return;
    }
    await fs
      .appendFile(
        input.logPath,
        `[sandbox-agent-bootstrap] ${new Date().toISOString()} runtime_skills ${message}\n`,
        "utf-8",
      )
      .catch(() => {});
  };
  const timed = async <T>(label: string, action: () => Promise<T>) => {
    const startedAt = Date.now();
    await log(`${label}_start`);
    try {
      const result = await action();
      await log(`${label}_done elapsed_ms=${Date.now() - startedAt}`);
      return result;
    } catch (error) {
      await log(
        `${label}_error elapsed_ms=${Date.now() - startedAt} error=${JSON.stringify(
          error instanceof Error ? error.message : String(error),
        )}`,
      );
      throw error;
    }
  };

  if (!input.agentsDir) {
    await log("skip reason=no_agents_dir");
    return [] as string[];
  }

  const hostTempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dokploy-runtime-skills-"));
  const hostRepoRoot = path.join(hostTempDir, "repo");
  const hostSkillsRoot = path.join(hostRepoRoot, "skills");
  const copiedSkills: string[] = [];

  try {
    await log(
      `prepare_start agents_dir=${JSON.stringify(input.agentsDir)} skills=${JSON.stringify(
        input.skillNames,
      )}`,
    );
    await fs.mkdir(hostSkillsRoot, { recursive: true });

    for (const skillName of input.skillNames) {
      const sourceDir = path.join(input.agentsDir, "skills", skillName);
      try {
        await fs.stat(sourceDir);
      } catch {
        continue;
      }

      await fs.cp(sourceDir, path.join(hostSkillsRoot, skillName), {
        recursive: true,
      });
      copiedSkills.push(skillName);
    }

    const cacheSchemaSourceDir = path.join(input.agentsDir, "cache-schema");
    try {
      await fs.stat(cacheSchemaSourceDir);
      await fs.cp(cacheSchemaSourceDir, path.join(hostRepoRoot, "cache-schema"), {
        recursive: true,
      });
    } catch {}

    if (copiedSkills.length === 0) {
      await log("skip reason=no_copied_skills");
      return [];
    }
    await log(`prepare_done copied_skills=${JSON.stringify(copiedSkills)}`);

    const containerRepoRoot = "/tmp/dokploy-runtime-skills";
    await timed("container_prepare", () =>
      execAsync(
        `docker exec ${input.containerName} bash -lc "rm -rf '${containerRepoRoot}' && mkdir -p '${containerRepoRoot}'"`,
      ),
    );
    await timed("docker_cp", () =>
      execAsync(
        `docker cp "${hostRepoRoot}/." ${input.containerName}:"${containerRepoRoot}/"`,
      ),
    );

    const skillFlags = copiedSkills
      .map((skillName) => `--skill '${escapeSingleQuotes(skillName)}'`)
      .join(" ");

    await timed("skills_add", () =>
      execAsync(
        `docker exec ${input.containerName} bash -lc "mkdir -p /workspace/repo/.agents && cd /workspace/repo && skills add '${containerRepoRoot}' ${skillFlags} -a claude-code -a codex --copy -y"`,
      ),
    );

    return copiedSkills;
  } finally {
    await fs.rm(hostTempDir, { recursive: true, force: true }).catch(() => {});
  }
};
