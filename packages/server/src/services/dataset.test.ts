import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	resolveDatasetHostRoot,
	validateDatasetManifest,
} from "./dataset-contracts";

test("dataset host roots are deterministic and use the dataset namespace", () => {
	assert.equal(
		resolveDatasetHostRoot("dataset/one", "profile/one", {
			VULSEEK_DATASET_HOST_PATH: "/var/lib/vulseek",
		} as NodeJS.ProcessEnv),
		"/var/lib/vulseek/datasets/dataset-one/profiles/profile-one",
	);
});

test("dataset manifests reject duplicate keys and paths outside the profile", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "vulseek-dataset-manifest-"));
	try {
		await mkdir(path.join(root, ".vulseek", "sample-a"), { recursive: true });
		await writeFile(
			path.join(root, ".vulseek", "samples.json"),
			JSON.stringify({
				version: 1,
				samples: [{ sampleKey: "a", repositoryPath: ".vulseek/sample-a" }],
			}),
		);
		const manifest = await validateDatasetManifest(root);
		assert.equal(manifest.samples[0]?.sampleKey, "a");

		await writeFile(
			path.join(root, ".vulseek", "samples.json"),
			JSON.stringify({
				version: 1,
				samples: [
					{ sampleKey: "a", repositoryPath: ".vulseek/sample-a" },
					{ sampleKey: "a", repositoryPath: ".vulseek/sample-a" },
				],
			}),
		);
		await assert.rejects(validateDatasetManifest(root), /Duplicate dataset sampleKey/);

		await writeFile(
			path.join(root, ".vulseek", "samples.json"),
			JSON.stringify({ version: 1, samples: [{ sampleKey: "escape", repositoryPath: "../outside" }] }),
		);
		await assert.rejects(validateDatasetManifest(root), /escapes the profile root/);

		const outside = await mkdtemp(path.join(os.tmpdir(), "vulseek-dataset-outside-"));
		try {
			await symlink(outside, path.join(root, ".vulseek", "linked-sample"), "dir");
			await writeFile(
				path.join(root, ".vulseek", "samples.json"),
				JSON.stringify({ version: 1, samples: [{ sampleKey: "link", repositoryPath: ".vulseek/linked-sample" }] }),
			);
			await assert.rejects(validateDatasetManifest(root), /resolves outside the profile root/);
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
