# Checkout Tools Image Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extract the scan toolchain into a versioned local Docker image and add a checkout dialog that exposes its version, build time, rebuild action, and final checkout build action.

**Architecture:** Split the current scan Dockerfile into a stable tools image and a lightweight per-project checkout image. Compute the tools version from its build inputs, coordinate tools builds through a process-local single-flight manager, and persist recoverable metadata as Docker labels.

**Tech Stack:** TypeScript, tRPC, React, Next.js, Docker BuildKit, Dockerode/CLI, Vitest.

## Global Constraints

- Store tools images in the local Docker daemon; do not introduce GHCR integration.
- Do not add a database migration or Redis cache.
- Allow `owner` and `admin` to manually rebuild tools; members may use tools and trigger automatic bootstrap when the current tools image is missing.
- Manual tools rebuilds retain Docker layer and cache-mount reuse; do not pass `--no-cache`.
- Existing checkout and tools images must not be automatically deleted.
- Preserve unrelated changes in the dirty worktree.

---

## Summary

Move Clang, Rust, Node.js, Semgrep, CodeQL, sandbox-agent, Codex, Claude, Serena, and codex-acp out of the per-project checkout image into a shared image named `vulseek-scan-tools:<hash-prefix>`. Clicking Checkout opens a shared application/compose dialog that displays tools status and metadata before any build starts.

## Image Architecture

- Replace the combined scan template with:
  - `Dockerfile.scan-tools`, containing the complete toolchain and codex-acp builder.
  - `Dockerfile.scan-checkout.template`, containing repository checkout/local source handling, post-checkout execution, and the final project image based on the tools image.
- Compute SHA-256 from the exact bytes of:
  - The tools Dockerfile.
  - `sandbox-agent@0.4.2.patch`.
  - `codex-acp-fork-0.14.0.patch`.
- Use the first 16 hash characters in the image tag and retain the complete hash in image metadata.
- Add Docker labels for:
  - Full tools definition hash.
  - Build timestamp.
  - Tools image format version.
- Pass the build timestamp only to the final label layer. It must not affect the tools definition hash, allowing expensive layers to remain cached during a rebuild.
- Remove the unused `agents` directory copy from the checkout build context.
- Keep existing checkout image naming and `/workspace/repo` behavior.

## Build Lifecycle

- Introduce a process-local tools build manager with one active build at a time.
- A build record contains:

```ts
type CheckoutToolsBuild = {
	buildId: string;
	version: string;
	imageTag: string;
	status: "running" | "completed" | "failed";
	stdout: string;
	stderr: string;
	errorMessage: string | null;
	startedAt: string;
	finishedAt: string | null;
};
```

- Repeated rebuild requests while a build is running return the existing build instead of starting another process.
- A successful build atomically retags the new image as the current hash tag. A failed rebuild leaves the previous image usable.
- Image status is recovered with Docker inspect after server restart; active task state and historical logs remain process-local, matching the current checkout task behavior.
- Starting a checkout follows these rules:
  - Current tools image exists and no rebuild is running: start checkout immediately.
  - Current tools image exists and a manual rebuild is running: start checkout immediately using the existing image.
  - Current tools image is missing: create the checkout task in `waiting_tools`, start or join the tools build, then continue automatically.
  - Automatic tools build fails: mark the checkout task failed and expose the tools build ID and error.

## Public APIs

Add `scan.checkoutToolsStatus()`:

```ts
type CheckoutToolsStatus = {
	version: string;
	shortVersion: string;
	imageTag: string;
	imageId: string | null;
	exists: boolean;
	builtAt: string | null;
	state: "missing" | "ready" | "building" | "failed";
	activeBuildId: string | null;
	lastError: string | null;
	canRebuild: boolean;
};
```

Add `scan.rebuildCheckoutTools()`:

- Permit only users whose organization role is `owner` or `admin`.
- Do not use the existing owner-only `adminProcedure` without extending the role check.
- Return `{ buildId, version, imageTag, status: "running" }`.

Add `scan.checkoutToolsBuildStatus({ buildId })`:

- Permit authenticated users to inspect tools build progress and logs.
- Return the build record or `null` when the process no longer retains it.

Extend existing checkout status with:

```ts
{
	phase: "waiting_tools" | "building_checkout";
	toolsVersion: string;
	toolsBuildId: string | null;
}
```

Keep the existing `scan.checkout` input and primary return fields compatible.

## Frontend

- Add one shared `CheckoutImageDialog` and checkout-state hook for application and compose pages.
- Clicking Checkout opens the dialog and does not immediately trigger a build.
- Render two full-width sections separated by a divider, without nested cards:
  - Tools section: status, short hash, full hash, image tag, and build time.
  - Checkout section: target checkout image state and final build action.
- Show the tools rebuild button only when `canRebuild` is true.
- Label the tools action `Build Tools Image` when missing and `Rebuild Tools Image` when present.
- Keep the checkout button enabled during a manual rebuild when an old tools image exists.
- When tools are missing, clicking checkout shows `waiting_tools` and allows automatic bootstrap.
- Poll tools status every 1.5-2 seconds only while a tools build is active, then stop polling.
- Open tools logs in a separate terminal log dialog. Continue using the existing checkout log dialog for the final image build.
- Reuse the shared component from both application and compose actions, removing their duplicated checkout confirmation and polling logic.

## Failure Handling

- A failed manual tools rebuild displays the failure while retaining `exists: true`, the previous build timestamp, and the usable old image.
- A failed first-time tools build leaves `exists: false` and fails every checkout waiting on that build.
- Missing build logs after a server restart are reported as unavailable; image status still comes from Docker labels.
- Docker command failures preserve stderr and the original error message.
- Do not expose proxy credentials or secret build arguments in API responses or rendered logs.

## Test Plan

### Hash and Metadata

- Identical Dockerfile and patch contents produce the same version.
- Changing any one build input changes the version.
- Proxy values and build timestamps do not change the version.
- Docker labels round-trip the full hash and build timestamp.

### Build Manager

- Concurrent rebuild requests start one Docker process and share the build ID.
- Cached rebuild updates `builtAt` without passing `--no-cache`.
- Successful build status is recoverable with Docker inspect.
- Failed rebuild preserves an existing image.
- Completed, failed, and missing build records return the expected API state.

### Checkout Coordination

- Existing tools image starts checkout without a tools build.
- Missing tools image automatically builds tools and then starts checkout.
- Multiple waiting checkouts share one tools build.
- Automatic tools failure marks waiting checkouts failed.
- Manual rebuild with an existing image does not block checkout.

### Permissions and UI

- Owner and admin can manually rebuild; member receives `UNAUTHORIZED` from the mutation.
- Members can view status/logs and trigger checkout bootstrap when tools are missing.
- Application and compose render the same dialog behavior.
- Dialog states correctly represent missing, ready, building, and failed tools images.
- Tools and checkout logs open in their respective terminal dialogs.

### Verification Commands

- Run focused Vitest suites for hash, build manager, API, and checkout coordination.
- Run server and Vulseek typechecks.
- Run Biome checks without rewriting unrelated files.
- Run the server build and Next production build.
- Exercise build orchestration with a minimal fixture Dockerfile.
- Perform one real tools image build and one checkout smoke test; verify the final checkout image is based on the expected tools hash and contains `/workspace/repo`.

## Acceptance Criteria

- The tools image is built once per definition hash and reused by unrelated projects.
- The modal shows the current tools hash and build time before checkout begins.
- Owner/admin can rebuild tools with cache reuse.
- Ordinary checkout automatically bootstraps a missing tools image.
- A manual rebuild does not block checkout when the previous tools image exists.
- No database schema, Redis state, or remote registry is required.
