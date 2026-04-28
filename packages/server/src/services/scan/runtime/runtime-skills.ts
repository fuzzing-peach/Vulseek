import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execAsync } from "../../../utils/process/execAsync";

const escapeSingleQuotes = (value: string) => value.replace(/'/g, `'"'"'`);

export const installRuntimeSkillsInContainer = async (input: {
  containerName: string;
  agentsDir: string | null;
  skillNames: readonly string[];
}) => {
  if (!input.agentsDir) {
    return [] as string[];
  }

  const hostTempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dokploy-runtime-skills-"));
  const hostRepoRoot = path.join(hostTempDir, "repo");
  const hostSkillsRoot = path.join(hostRepoRoot, "skills");
  const copiedSkills: string[] = [];

  try {
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
      return [];
    }

    const containerRepoRoot = "/tmp/dokploy-runtime-skills";
    await execAsync(
      `docker exec ${input.containerName} bash -lc "rm -rf '${containerRepoRoot}' && mkdir -p '${containerRepoRoot}'"`,
    );
    await execAsync(
      `docker cp "${hostRepoRoot}/." ${input.containerName}:"${containerRepoRoot}/"`,
    );

    const skillFlags = copiedSkills
      .map((skillName) => `--skill '${escapeSingleQuotes(skillName)}'`)
      .join(" ");

    await execAsync(
      `docker exec ${input.containerName} bash -lc "mkdir -p /workspace/repo/.agents && cd /workspace/repo && npx -y skills add '${containerRepoRoot}' ${skillFlags} -a claude-code -a codex --copy -y"`,
    );

    return copiedSkills;
  } finally {
    await fs.rm(hostTempDir, { recursive: true, force: true }).catch(() => {});
  }
};
