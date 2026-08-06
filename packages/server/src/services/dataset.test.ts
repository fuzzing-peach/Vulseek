import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateDatasetManifest } from "./dataset-manifest";

test("dataset manifests reject duplicate ids and paths outside the profile", async () => {
	const root = await mkdtemp(
		path.join(os.tmpdir(), "vulseek-dataset-manifest-"),
	);
	try {
		await mkdir(path.join(root, ".vulseek", "sample-a"), { recursive: true });
		await writeFile(
			path.join(root, ".vulseek", "samples.json"),
			JSON.stringify({
				version: 1,
				samples: [{ id: "a", repositoryPath: ".vulseek/sample-a" }],
			}),
		);
		const manifest = await validateDatasetManifest(root);
		assert.equal(manifest.samples[0]?.id, "a");

		await writeFile(
			path.join(root, ".vulseek", "samples.json"),
			JSON.stringify({
				version: 1,
				samples: [
					{ id: "a", repositoryPath: ".vulseek/sample-a" },
					{ id: "a", repositoryPath: ".vulseek/sample-a" },
				],
			}),
		);
		await assert.rejects(validateDatasetManifest(root), /Duplicate dataset id/);

		await writeFile(
			path.join(root, ".vulseek", "samples.json"),
			JSON.stringify({
				version: 1,
				samples: [{ id: "escape", repositoryPath: "../outside" }],
			}),
		);
		await assert.rejects(
			validateDatasetManifest(root),
			/escapes the profile root/,
		);

		const outside = await mkdtemp(
			path.join(os.tmpdir(), "vulseek-dataset-outside-"),
		);
		try {
			await symlink(
				outside,
				path.join(root, ".vulseek", "linked-sample"),
				"dir",
			);
			await writeFile(
				path.join(root, ".vulseek", "samples.json"),
				JSON.stringify({
					version: 1,
					samples: [{ id: "link", repositoryPath: ".vulseek/linked-sample" }],
				}),
			);
			await assert.rejects(
				validateDatasetManifest(root),
				/resolves outside the profile root/,
			);
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
