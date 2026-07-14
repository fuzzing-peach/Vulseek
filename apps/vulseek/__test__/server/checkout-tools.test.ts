import { readFile } from "node:fs/promises";
import path from "node:path";
import {
	buildCheckoutToolsImageTag,
	buildCheckoutToolsStatus,
	canRebuildCheckoutTools,
	computeCheckoutToolsVersion,
	createCheckoutToolsBuildManager,
} from "@vulseek/server/services/scan/checkout-tools";
import { describe, expect, it, vi } from "vitest";

const definitionInputs = {
	dockerfile: "FROM ubuntu:24.04\nRUN echo tools\n",
	sandboxAgentPatch: "sandbox patch",
	codexAcpPatch: "codex patch",
};

const deferred = <T>() => {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
};

describe("checkout tools definition", () => {
	it("allows owner and admin roles to rebuild tools", () => {
		expect(canRebuildCheckoutTools("owner")).toBe(true);
		expect(canRebuildCheckoutTools("admin")).toBe(true);
		expect(canRebuildCheckoutTools("member")).toBe(false);
	});

	it("uses all immutable build inputs for a stable version", () => {
		const version = computeCheckoutToolsVersion(definitionInputs);

		expect(version).toMatch(/^[a-f0-9]{64}$/);
		expect(computeCheckoutToolsVersion(definitionInputs)).toBe(version);
		expect(
			computeCheckoutToolsVersion({
				...definitionInputs,
				codexAcpPatch: "changed patch",
			}),
		).not.toBe(version);
		expect(buildCheckoutToolsImageTag(version)).toBe(
			`vulseek-scan-tools:${version.slice(0, 16)}`,
		);
	});

	it("keeps tools and repository checkout in separate Dockerfiles", async () => {
		const dockerfilesDir = path.resolve(
			process.cwd(),
			"../../packages/server/src/services/dockerfiles",
		);
		const [toolsDockerfile, checkoutDockerfile] = await Promise.all([
			readFile(path.join(dockerfilesDir, "Dockerfile.scan-tools"), "utf8"),
			readFile(
				path.join(dockerfilesDir, "Dockerfile.scan-checkout.template"),
				"utf8",
			),
		]);

		expect(toolsDockerfile).toContain(
			'LABEL com.fuzzing-peach.vulseek.scan-tools.version="${VULSEEK_TOOLS_VERSION}"',
		);
		expect(toolsDockerfile).not.toContain("# syntax=docker/dockerfile:1");
		expect(toolsDockerfile).not.toContain("AS repository-source");
		expect(checkoutDockerfile).toContain("ARG VULSEEK_TOOLS_IMAGE");
		expect(checkoutDockerfile).not.toContain("# syntax=docker/dockerfile:1");
		expect(checkoutDockerfile).toContain(
			"FROM ${VULSEEK_TOOLS_IMAGE} AS repository-source",
		);
		expect(checkoutDockerfile).toContain(
			"FROM ${VULSEEK_TOOLS_IMAGE} AS final",
		);
		expect(checkoutDockerfile).not.toContain("codeql pack download");
	});

	it("reports a failed rebuild while preserving the previous image", () => {
		const version = "c".repeat(64);
		const imageTag = buildCheckoutToolsImageTag(version);
		const status = buildCheckoutToolsStatus({
			definition: { version, imageTag },
			image: {
				version,
				imageTag,
				imageId: "sha256:old-image",
				builtAt: "2026-07-14T09:00:00.000Z",
			},
			activeBuild: null,
			latestBuild: {
				buildId: "failed-build",
				version,
				imageTag,
				status: "failed",
				stdout: "",
				stderr: "network failed",
				errorMessage: "network failed",
				startedAt: "2026-07-14T10:00:00.000Z",
				finishedAt: "2026-07-14T10:01:00.000Z",
			},
			canRebuild: true,
		});

		expect(status.exists).toBe(true);
		expect(status.state).toBe("failed");
		expect(status.builtAt).toBe("2026-07-14T09:00:00.000Z");
		expect(status.lastError).toBe("network failed");
	});
});

describe("checkout tools build manager", () => {
	it("single-flights concurrent rebuild requests", async () => {
		const build = deferred<void>();
		const executeBuild = vi.fn(() => build.promise);
		const manager = createCheckoutToolsBuildManager({
			resolveDefinition: async () => ({
				version: "a".repeat(64),
				imageTag: `vulseek-scan-tools:${"a".repeat(16)}`,
			}),
			inspectImage: async () => null,
			executeBuild,
			createBuildId: () => "tools-build-1",
			now: () => new Date("2026-07-14T10:00:00.000Z"),
		});

		const [first, second] = await Promise.all([
			manager.startBuild(),
			manager.startBuild(),
		]);

		expect(first.buildId).toBe("tools-build-1");
		expect(second.buildId).toBe(first.buildId);
		expect(executeBuild).toHaveBeenCalledTimes(1);

		build.resolve();
		await manager.waitForBuild(first.buildId);
		expect(manager.findBuild(first.buildId)?.status).toBe("completed");
	});

	it("builds a missing image before returning it to checkout", async () => {
		let imageExists = false;
		const executeBuild = vi.fn(async () => {
			imageExists = true;
		});
		const manager = createCheckoutToolsBuildManager({
			resolveDefinition: async () => ({
				version: "b".repeat(64),
				imageTag: `vulseek-scan-tools:${"b".repeat(16)}`,
			}),
			inspectImage: async ({ version, imageTag }) =>
				imageExists
					? {
							version,
							imageTag,
							imageId: "sha256:image",
							builtAt: "2026-07-14T10:00:00.000Z",
						}
					: null,
			executeBuild,
			createBuildId: () => "tools-build-2",
		});

		const image = await manager.ensureImage();

		expect(executeBuild).toHaveBeenCalledTimes(1);
		expect(image.imageId).toBe("sha256:image");
	});

	it("keeps checkout available while an existing tools image is rebuilding", async () => {
		const build = deferred<void>();
		const version = "d".repeat(64);
		const imageTag = buildCheckoutToolsImageTag(version);
		const manager = createCheckoutToolsBuildManager({
			resolveDefinition: async () => ({ version, imageTag }),
			inspectImage: async () => ({
				version,
				imageTag,
				imageId: "sha256:existing-image",
				builtAt: "2026-07-14T09:00:00.000Z",
			}),
			executeBuild: () => build.promise,
			createBuildId: () => "tools-build-3",
		});

		const rebuilding = await manager.startBuild();
		const image = await manager.ensureImage();

		expect(rebuilding.status).toBe("running");
		expect(image.imageId).toBe("sha256:existing-image");
		expect(manager.findBuild(rebuilding.buildId)?.status).toBe("running");

		build.resolve();
		await manager.waitForBuild(rebuilding.buildId);
	});

	it("shares a failed bootstrap across concurrent waiting checkouts", async () => {
		const build = deferred<void>();
		const executeBuild = vi.fn(() => build.promise);
		const manager = createCheckoutToolsBuildManager({
			resolveDefinition: async () => ({
				version: "e".repeat(64),
				imageTag: `vulseek-scan-tools:${"e".repeat(16)}`,
			}),
			inspectImage: async () => null,
			executeBuild,
			createBuildId: () => "tools-build-4",
		});

		const firstCheckout = manager.ensureImage();
		const secondCheckout = manager.ensureImage();
		await vi.waitFor(() => expect(executeBuild).toHaveBeenCalledTimes(1));
		build.reject(new Error("tools bootstrap failed"));

		await expect(firstCheckout).rejects.toThrow("tools bootstrap failed");
		await expect(secondCheckout).rejects.toThrow("tools bootstrap failed");
		expect(manager.findBuild("tools-build-4")?.status).toBe("failed");
	});
});
