import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderPipelineTemplate } from "../../../../packages/server/src/services/scan/pipeline/scan-pipeline-edge-transform";
import {
	copyTaskJsonArtifact,
	readTaskJsonArtifact,
	taskArtifactHostPath,
	writeTaskJsonArtifact,
	writeTaskTextArtifact,
} from "../../../../packages/server/src/services/scan/artifacts/task-artifact-paths";
import { loadDiscoveryFindingArtifacts } from "../../../../packages/server/src/services/scan/persistence/research-artifact-reader";

describe("research task artifact contract", () => {
	it("writes, reads, and copies JSON artifacts using /task paths", async () => {
		const root = await mkdtemp(join(tmpdir(), "vulseek-research-artifacts-"));
		const sourceTask = join(root, "source");
		const targetTask = join(root, "target");
		try {
			const sourcePath = await writeTaskJsonArtifact({
				taskDir: sourceTask,
				relativePath: "outputs/scope.json",
				value: { trustedDomain: "example.test", assets: ["db"] },
			});
			expect(sourcePath).toBe("/task/outputs/scope.json");
			expect(await readTaskJsonArtifact({ taskDir: sourceTask, containerPath: sourcePath })).toEqual({
				trustedDomain: "example.test",
				assets: ["db"],
			});

			const copiedPath = await copyTaskJsonArtifact({
				fromTaskDir: sourceTask,
				fromContainerPath: sourcePath,
				toTaskDir: targetTask,
				toRelativePath: "inputs/scope.json",
			});
			expect(copiedPath).toBe("/task/inputs/scope.json");
			expect(await readTaskJsonArtifact({ taskDir: targetTask, containerPath: copiedPath })).toEqual({
				trustedDomain: "example.test",
				assets: ["db"],
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("keeps report text and JSON artifacts inside the task directory", async () => {
		const taskDir = await mkdtemp(join(tmpdir(), "vulseek-research-report-"));
		try {
			const reportPath = await writeTaskTextArtifact({
				taskDir,
				relativePath: "reports/final-report.md",
				value: "# Research report\n",
			});
			expect(reportPath).toBe("/task/reports/final-report.md");
			expect(await readFile(taskArtifactHostPath({ taskDir, containerPath: reportPath }), "utf8")).toBe(
				"# Research report\n",
			);
			expect(() => taskArtifactHostPath({ taskDir, containerPath: "/task/../outside.json" })).toThrow();
			expect(() => taskArtifactHostPath({ taskDir, containerPath: "/tmp/outside.json" })).toThrow();
		} finally {
			await rm(taskDir, { recursive: true, force: true });
		}
	});

	it("materializes a structured review output as the downstream review artifact", async () => {
		const root = await mkdtemp(join(tmpdir(), "vulseek-review-artifact-"));
		const sourceTask = join(root, "source");
		const targetTask = join(root, "target");
		const output = {
			trackKey: "track-a",
			decision: "continue",
			summary: "Continue tracing the current track.",
			findingIds: [],
			coverageGaps: ["missing trust boundary evidence"],
			nextStep: "Inspect the next sink.",
			blockReason: null,
			reopenCondition: null,
		};
		try {
			const fromValue = await renderPipelineTemplate("$output", {
				ctx: {},
				stageInput: {},
				stageOutput: output,
			});
			const sourcePath = await writeTaskJsonArtifact({
				taskDir: sourceTask,
				relativePath: "outputs/review.json",
				value: fromValue,
			});
			const reviewPath = await copyTaskJsonArtifact({
				fromTaskDir: sourceTask,
				fromContainerPath: sourcePath,
				toTaskDir: targetTask,
				toRelativePath: "inputs/track-review.json",
			});
			const downstreamInput = { reviewPath };
			expect(downstreamInput.reviewPath).toBe("/task/inputs/track-review.json");
			expect(await readTaskJsonArtifact({ taskDir: targetTask, containerPath: reviewPath })).toEqual(output);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("loads one strict Finding object from each Discovery Report path", async () => {
		const artifacts = new Map<string, unknown>([
			["/task/findings/one.json", { findingId: "track:one" }],
			["/task/findings/two.json", { findingId: "track:two" }],
		]);

		await expect(
			loadDiscoveryFindingArtifacts({
				report: {
					findingPaths: [
						"/task/findings/one.json",
						"/task/findings/two.json",
					],
				},
				readArtifactJson: async (path) => artifacts.get(path),
			}),
		).resolves.toEqual([
			{ findingId: "track:one" },
			{ findingId: "track:two" },
		]);
	});

	it("rejects legacy inline Findings and invalid Finding paths", async () => {
		await expect(
			loadDiscoveryFindingArtifacts({
				report: { findings: [{ findingId: "track:legacy" }] },
				readArtifactJson: async () => ({}),
			}),
		).rejects.toThrow(/findingPaths/);

		await expect(
			loadDiscoveryFindingArtifacts({
				report: { findingPaths: ["/task/findings/one.json", 42] },
				readArtifactJson: async () => ({}),
			}),
		).rejects.toThrow(/Finding artifact paths/);
	});
});
