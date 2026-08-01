import { mkdtemp, rm, appendFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { DriverStdoutTailReader } from "./driver-stdout-tail-reader";

const activityLine = (label: string) =>
	JSON.stringify({
		type: "activity",
		activity: { kind: "tool", label },
	});

test("reads appended JSONL incrementally and preserves a half line", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "vulseek-tail-"));
	const filePath = path.join(directory, "stdout");
	const reader = new DriverStdoutTailReader();
	try {
		await writeFile(filePath, `${activityLine("first")}\n`);
		const first = await reader.read(filePath);
		assert.equal((first.latestActivity as { label: string }).label, "first");

		const secondLine = activityLine("second");
		await appendFile(filePath, secondLine.slice(0, -2));
		const half = await reader.read(filePath);
		assert.equal((half.latestActivity as { label: string }).label, "first");

		await appendFile(filePath, `${secondLine.slice(-2)}\n`);
		const second = await reader.read(filePath);
		assert.equal((second.latestActivity as { label: string }).label, "second");
		assert.strictEqual(await reader.read(filePath), second);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("resets the parser when stdout is truncated and rebuilt", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "vulseek-tail-"));
	const filePath = path.join(directory, "stdout");
	const reader = new DriverStdoutTailReader();
	try {
		await writeFile(filePath, `${activityLine("old")}\n`);
		await reader.read(filePath);
		await writeFile(filePath, `${activityLine("new")}\n`);
		const rebuilt = await reader.read(filePath);
		assert.equal(
			(rebuilt.latestActivity as { label: string }).label,
			"new",
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
