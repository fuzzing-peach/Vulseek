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
			path.join(root, ".vulseek", "manifest.json"),
			JSON.stringify({
				version: 1,
				samples: [{ id: "a", repositoryPath: ".vulseek/sample-a" }],
			}),
		);
		const manifest = await validateDatasetManifest(root);
		assert.equal(manifest.samples[0]?.id, "a");
		assert.deepEqual(manifest.samples[0]?.groundTruthArtifacts, []);

		await writeFile(
			path.join(root, ".vulseek", "manifest.json"),
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
			path.join(root, ".vulseek", "manifest.json"),
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
				path.join(root, ".vulseek", "manifest.json"),
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

test("dataset manifests validate ground-truth artifact files", async () => {
	const root = await mkdtemp(
		path.join(os.tmpdir(), "vulseek-dataset-ground-truth-"),
	);
	try {
		await mkdir(path.join(root, ".vulseek"), { recursive: true });
		await mkdir(path.join(root, "samples", "sample-a"), { recursive: true });
		await mkdir(path.join(root, "ground-truth"), { recursive: true });
		await writeFile(
			path.join(root, "ground-truth", "description.txt"),
			"Vulnerability description",
		);
		await writeFile(
			path.join(root, "ground-truth", "patch.diff"),
			"--- vulnerable\n+++ fixed\n",
		);
		await writeFile(
			path.join(root, "ground-truth", "evidence.bin"),
			Buffer.from([0, 1, 2, 3]),
		);

		const writeManifest = (groundTruthArtifacts: string[]) =>
			writeFile(
				path.join(root, ".vulseek", "manifest.json"),
				JSON.stringify({
					version: 1,
					samples: [
						{
							id: "a",
							repositoryPath: "samples/sample-a",
							groundTruthArtifacts,
						},
					],
				}),
			);

		const artifacts = [
			"ground-truth/description.txt",
			"ground-truth/patch.diff",
			"ground-truth/evidence.bin",
		];
		await writeManifest(artifacts);
		const manifest = await validateDatasetManifest(root);
		assert.deepEqual(manifest.samples[0]?.groundTruthArtifacts, artifacts);

		await writeManifest(["ground-truth"]);
		await assert.rejects(
			validateDatasetManifest(root),
			/groundTruth artifact must be a file/,
		);

		await writeManifest(["../outside.txt"]);
		await assert.rejects(
			validateDatasetManifest(root),
			/groundTruthArtifacts entry escapes the profile root/,
		);

		await writeManifest(["ground-truth/missing.json"]);
		await assert.rejects(
			validateDatasetManifest(root),
			/groundTruth artifact does not exist/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
