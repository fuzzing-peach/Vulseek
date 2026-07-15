import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
	buildNativeAgentTranscriptRoots,
	findNativeAgentTranscript,
} from "./native-agent-transcript";

const makeRoot = async () =>
	mkdtemp(path.join(os.tmpdir(), "vulseek-agent-stream-"));

describe("findNativeAgentTranscript", () => {
	it("keeps ordinary task lookup inside the task runtime", () => {
		assert.deepEqual(
			buildNativeAgentTranscriptRoots({
				runtimeDir: "/scan/jobs/job-1/stages/scan-target/tasks/task-1",
				laneIndex: null,
			}),
			["/scan/jobs/job-1/stages/scan-target/tasks/task-1"],
		);
	});

	it("adds the persistent lane agent home to transcript lookup roots", () => {
		assert.deepEqual(
			buildNativeAgentTranscriptRoots({
				runtimeDir: "/scan/jobs/job-1/stages/scan-target/tasks/task-1",
				laneIndex: 3,
			}),
			[
				"/scan/jobs/job-1/stages/scan-target/tasks/task-1",
				"/scan/jobs/job-1/stages/scan-target/lanes/lane-3",
			],
		);
	});

	it("finds a Codex rollout by the exact thread id", async () => {
		const root = await makeRoot();
		const sessions = path.join(
			root,
			"agent-home",
			"sessions",
			"2026",
			"07",
			"15",
		);
		await mkdir(sessions, { recursive: true });
		const expected = path.join(
			sessions,
			"rollout-2026-07-15T01-02-03-thread-123.jsonl",
		);
		await writeFile(expected, "{}\n");

		assert.equal(
			await findNativeAgentTranscript({
				roots: [root],
				provider: "codex",
				threadId: "thread-123",
			}),
			expected,
		);
	});

	it("finds a Claude Code transcript under the project directory", async () => {
		const root = await makeRoot();
		const projects = path.join(
			root,
			"agent-home",
			"projects",
			"-workspace-repo",
		);
		await mkdir(projects, { recursive: true });
		const expected = path.join(projects, "claude-thread-456.jsonl");
		await writeFile(expected, "{}\n");

		assert.equal(
			await findNativeAgentTranscript({
				roots: [root],
				provider: "claude-code",
				threadId: "claude-thread-456",
			}),
			expected,
		);
	});

	it("does not match a partial or unrelated thread id", async () => {
		const root = await makeRoot();
		const sessions = path.join(root, "agent-home", "sessions");
		await mkdir(sessions, { recursive: true });
		await writeFile(path.join(sessions, "rollout-thread-12.jsonl"), "{}\n");

		assert.equal(
			await findNativeAgentTranscript({
				roots: [root],
				provider: "codex",
				threadId: "thread-1",
			}),
			null,
		);
	});

	it("selects the forked transcript rather than the parent transcript", async () => {
		const root = await makeRoot();
		const sessions = path.join(root, "agent-home", "sessions", "2026", "07");
		await mkdir(sessions, { recursive: true });
		await writeFile(
			path.join(sessions, "rollout-2026-07-parent-thread.jsonl"),
			"{}\n",
		);
		const expected = path.join(sessions, "rollout-2026-07-forked-thread.jsonl");
		await writeFile(expected, "{}\n");

		assert.equal(
			await findNativeAgentTranscript({
				roots: [root],
				provider: "codex",
				threadId: "forked-thread",
			}),
			expected,
		);
	});
});
