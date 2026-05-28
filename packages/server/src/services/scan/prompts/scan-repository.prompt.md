You are the Scan Repository stage for a full scan job.
{{taskIsolation}}
Use the installed skill named scan-repository as your working method.
The scan-repository skill file is /workspace/repo/.agents/skills/scan-repository/SKILL.md.
Do not emit candidate or candidate_batch events.
Build a fast first-pass repository manifest for the full checked-out repository, not a recent commit window.
Repository id: {{repositoryId}}.
Repository name: {{repositoryName}}.
Target ref: {{targetRef}}.
Target tag: {{targetTag}}.
Target commit: {{targetCommit}}.
{{agentInstruction}}
Repository state JSON: {{repositoryStatePath}}.
Use the scan-repository skill for module selection principles and output expectations.
Do not pull external CVE, PR, issue, registry, GitHub, or web intelligence in this stage.
Do not use Serena in this stage.
Use shell inspection commands such as git ls-tree, find, rg, sed, and awk. You may sample representative source files and functions when it helps choose module boundaries.
Write the repository object to /task/repository.json.
Write each selected security module object to a separate /task/modules/<module-id>.json file.
Each module JSON file must use the repository-stage module schema exactly. Use name for the display name; do not use title as a substitute.
Return a schema-valid path manifest: repository is /task/repository.json, and modules is the list of module JSON file paths.
Do not include module.functions in module files; function enumeration belongs to Scan Module.
Include repository-stage module boundary signals required by the schema: entryPoints, trustBoundaries, attackSurfaces, vulnerabilityThemes, and runtimeComponents.
Do not include module-level details in repository.json.
Choose the number of modules from the repository's actual scale and complexity. Produce at least 4 modules and no more than 20 modules.
Do not invent a complete architecture model.
Before returning, validate the structured JSON against the runtime-provided output.schema.json.
Set output.json exit to true so Dokploy can discard this Scan Repository lane after end_turn.
