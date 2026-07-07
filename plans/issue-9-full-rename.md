# Issue #9 Full Rename Plan

## Summary

Rename the project to Vulseek without preserving compatibility for the previous upstream name. Logo work remains out of scope. This is a breaking rename: package names, app directory, env vars, Docker resources, persisted paths, service names, database defaults, docs, UI text, and templates should use Vulseek naming.

## Key Changes

- Rename tracked app/module identifiers to Vulseek, including the app directory, root package name, internal package scopes, API package, and schedules package.
- Update workspace/build references accordingly: `pnpm-workspace.yaml`, root scripts, Dockerfiles, tsconfig path aliases, package dependencies, imports, exports, build filters, and runtime `cd apps/...` paths.
- Replace all public/product text with Vulseek: README, CONTRIBUTING, LICENSE/terms references, GitHub issue/PR templates, UI labels, onboarding/settings copy, emails, notifications, auth app name, GitHub comments, logs, and help output.
- Maintain open-source compliance by reviewing the upstream license structure, updating `LICENSE.MD` or adding the canonical license file needed for Vulseek, preserving required copyright/attribution notices, and aligning README/package metadata with the declared license.
- Replace runtime/config identifiers without aliases: legacy env prefixes, config directories, Docker networks, Docker services/volumes/images, PostgreSQL defaults, and temp/cache prefixes should all use Vulseek naming.
- Update release/dev scripts to accept only Vulseek service names and commands. Remove legacy service aliases, old env var names, and old status filters.
- Update scan-related hardcoded paths and package references, including old local repo paths, old package paths, runtime skill temp dirs, and scan error messages.
- Exclude `third_party/`, generated build outputs, lockfile churn unless package rename requires it, and untracked local-only files unless explicitly tracked and relevant.

## Test Plan

- Run a strict tracked-file search for old project names and only allow intentional historical references if explicitly justified.
- Run a strict tracked-file search for old app paths, config paths, Docker networks, Docker services, and volume names; require zero functional references.
- Run `bash -n dev.sh run.sh`.
- Run `pnpm install --lockfile-only` if package names changed require lockfile updates, then inspect lockfile diff for expected `@vulseek/*` changes only.
- Run `pnpm typecheck`.
- Run `pnpm test`.
- Run `pnpm build` if local dependencies and environment allow.
- Smoke-check help text: `./dev.sh help` and `./run.sh help` must show only Vulseek names.
- Verify license compliance metadata: `LICENSE.MD`, README license section, and package `license` fields must agree, and required upstream attribution must remain present.

## Assumptions

- No compatibility with old project names is required.
- Existing local/production Docker volumes, networks, database names, and config-directory data using old names are not migrated in this task.
- Logo/image asset redesign is deferred.
