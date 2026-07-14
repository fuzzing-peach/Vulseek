# Canonical Scan Stage Names

## Goal

Use one vocabulary for scan stages across the database, server, API, frontend,
runtime sessions, source filenames, symbols, prompts, and current documentation.

## Canonical Names

| Legacy name | Canonical name |
| --- | --- |
| `repository-profile` / `repository-profile` | `repository-profile` |
| `identify-target` / `identify-target` | `identify-target` |
| `scan-target` / `scan-target` | `scan-target` |

Runtime-facing values use the canonical hyphenated stage IDs directly. The UI
does not translate them into a second snake_case enum.

## Implementation

- Remove compatibility branches for legacy stage IDs.
- Delete the superseded identify-target and scan-target stage implementations and
  their scanner prompts. Their canonical implementations already exist.
- Rename the active repository implementation, prompt, functions, types, queue
  helpers, and metadata keys to repository-profile terminology.
- Rename module/function queue and runtime helpers to identify-target and
  scan-target terminology.
- Update live sessions, JSON-RPC streaming, task filters, and frontend labels to
  carry canonical IDs end to end.
- Add a migration that rewrites historical task stage IDs to canonical IDs.
- Update current documentation and repository guidance.

## Boundaries

- Existing Drizzle migration files are immutable and retain legacy strings.
- Generated `dist*` output is rebuilt, not manually edited.
- Scanner concepts that are not stage identities are renamed when they refer to
  these stage implementations; unrelated source-code notions of modules and
  functions remain unchanged.

## Verification

- Unit tests cover canonical mapping and reject legacy stage IDs.
- A source scan fails if legacy identifiers remain outside immutable migrations.
- Historical task rows are verified after migration.
- Server tests, server typecheck, Vulseek tests, and relevant builds run after
  the rename.
