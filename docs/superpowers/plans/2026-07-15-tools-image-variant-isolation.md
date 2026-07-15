# Scan Tools Image Variant Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Isolate development and release scan-tools images on a shared Docker daemon.

**Architecture:** Resolve one strict `dev | release` variant at the server
boundary and include it in the scan-tools repository name and image metadata.
Startup scripts explicitly provide the variant; `NODE_ENV` is only the
deterministic fallback.

**Tech Stack:** TypeScript, Vitest, Bash, Docker.

## Global Constraints

- Dev image: `vulseek-scan-tools-dev:<content-hash>`.
- Release image: `vulseek-scan-tools-release:<content-hash>`.
- Do not reuse or delete legacy `vulseek-scan-tools:<hash>` images.
- Reject invalid explicit variants.

---

### Task 1: Variant Contract And Tagging

**Files:**
- Modify: `packages/server/src/services/scan/checkout-tools.ts`
- Modify: `apps/vulseek/__test__/server/checkout-tools.test.ts`

- [ ] Add failing tests for explicit/default/invalid variant resolution and
  distinct repository names for the same content hash.
- [ ] Implement `resolveCheckoutToolsImageVariant` and make
  `buildCheckoutToolsImageTag` require a variant.
- [ ] Run the focused Vitest test and confirm it passes.

### Task 2: Runtime Build And Inspection

**Files:**
- Modify: `packages/server/src/services/scan.ts`
- Modify: `packages/server/src/services/dockerfiles/Dockerfile.scan-tools`
- Modify: `apps/vulseek/__test__/server/checkout-tools.test.ts`

- [ ] Resolve the variant once when building the tools definition.
- [ ] Pass `VULSEEK_TOOLS_VARIANT` as a build argument and persist its label.
- [ ] Require matching version and variant labels during image inspection.

### Task 3: Environment Boundaries

**Files:**
- Modify: `dev.sh`
- Modify: `run.sh`

- [ ] Pass `VULSEEK_TOOLS_IMAGE_VARIANT=dev` to the development service.
- [ ] Pass `VULSEEK_TOOLS_IMAGE_VARIANT=release` to the release service.
- [ ] Assert both scripts contain the correct explicit values.

### Task 4: Verification

- [ ] Run checkout-tools tests.
- [ ] Run server and Vulseek typechecks.
- [ ] Run `bash -n dev.sh run.sh`, Biome, and `git diff --check`.
- [ ] Audit all scan-tools tag construction sites and confirm no generic
  repository remains in active runtime code.
