import assert from "node:assert/strict";
import test from "node:test";
import { buildSandboxAgentManualReplayText } from "./sandbox-agent-manual-replay";

const makePromptEvent = (text: string) => ({
	payload: {
		jsonrpc: "2.0",
		id: 1,
		method: "session/prompt",
		params: {
			prompt: [{ type: "text", text }],
			sessionId: "parent-session",
			connectionId: "connection-1",
			eventIndex: 4,
		},
	},
	eventIndex: 4,
	connectionId: "connection-1",
});

test("buildSandboxAgentManualReplayText strips json-rpc envelope metadata", () => {
	const result = buildSandboxAgentManualReplayText([
		makePromptEvent("scan the repository"),
		{
			payload: {
				params: {
					update: {
						sessionUpdate: "agent_message_chunk",
						content: "done",
					},
				},
			},
		},
	]);

	assert.match(result.text, /scan the repository/);
	assert.match(result.text, /done/);
	assert.doesNotMatch(result.text, /jsonrpc/);
	assert.doesNotMatch(result.text, /session\/update/);
	assert.doesNotMatch(result.text, /eventIndex/);
	assert.doesNotMatch(result.text, /connectionId/);
	assert.equal(result.stats.promptContainsJsonRpcReplay, false);
});

test("buildSandboxAgentManualReplayText truncates tool output to short snippets", () => {
	const longOutput = "x".repeat(5000);
	const result = buildSandboxAgentManualReplayText([
		{
			payload: {
				params: {
					update: {
						sessionUpdate: "tool_call_update",
						title: "Bash",
						kind: "exec",
						status: "completed",
						rawInput: {
							command: "make test",
							cwd: "/repo",
						},
						rawOutput: {
							exit_code: 0,
							stdout: longOutput,
						},
					},
				},
			},
		},
	]);

	assert.match(result.text, /command: make test/);
	assert.match(result.text, /exit_code: 0/);
	assert.ok(result.stats.toolOutputCharsKept <= 2000);
	assert.ok(!result.text.includes(longOutput));
});

test("buildSandboxAgentManualReplayText keeps replay under the hard limit", () => {
	const events = [
		makePromptEvent("p".repeat(20000)),
		{
			payload: {
				params: {
					update: {
						sessionUpdate: "agent_message_chunk",
						content: "a".repeat(60000),
					},
				},
			},
		},
		...Array.from({ length: 40 }, (_, index) => ({
			payload: {
				params: {
					update: {
						sessionUpdate: "tool_call_update",
						title: `tool-${index}`,
						rawOutput: {
							status: "completed",
							stdout: "t".repeat(5000),
						},
					},
				},
			},
		})),
	];
	const result = buildSandboxAgentManualReplayText(events);

	assert.ok(result.text.length <= 80000);
	assert.equal(result.stats.manualReplayTextBytes, Buffer.byteLength(result.text));
	assert.ok(result.stats.manualReplayTruncatedBytes > 0);
});

test("buildSandboxAgentManualReplayText prioritizes VULSEEK return blocks", () => {
	const result = buildSandboxAgentManualReplayText([
		{
			payload: {
				params: {
					update: {
						sessionUpdate: "agent_message_chunk",
						content: [
							"noise ".repeat(10000),
							"<VULSEEK_RET>{\"ok\":true}</VULSEEK_RET>",
							"tail ".repeat(10000),
						].join(""),
					},
				},
			},
		},
	]);

	assert.match(result.text, /<VULSEEK_RET>\{"ok":true\}<\/VULSEEK_RET>/);
	assert.doesNotMatch(result.text, /noise noise noise/);
	assert.doesNotMatch(result.text, /tail tail tail/);
});
