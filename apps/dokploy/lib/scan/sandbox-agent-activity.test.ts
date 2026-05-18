import assert from "node:assert/strict";
import test from "node:test";
import {
	deriveSandboxAgentActivity,
	type SandboxAgentActivityStreamMessage,
} from "./sandbox-agent-activity";

const makeMessage = (
	message: Record<string, unknown>,
): SandboxAgentActivityStreamMessage => ({
	line: 1,
	message,
});

test("deriveSandboxAgentActivity reports web searches as a short keyword", () => {
	const activity = deriveSandboxAgentActivity([
		makeMessage({
			method: "session/update",
			params: {
				update: {
					sessionUpdate: "tool_call",
					title: "search_query",
					rawInput: {
						tool: "web.search_query",
						arguments: {
							query: "wolfSSL TLS 1.3 handshake state machine",
						},
					},
				},
			},
		}),
	]);

	assert.equal(activity.kind, "web");
	assert.equal(activity.label, "Web Search");
	assert.equal(activity.detail, "wolfSSL TLS 1.3 handshake state machine");
});

test("deriveSandboxAgentActivity collapses long shell commands to Command", () => {
	const command =
		'cd /workspace/repo && rg -n "WOLFSSL_ERROR_WANT_WRITE" src wolfssl';
	const activity = deriveSandboxAgentActivity([
		makeMessage({
			method: "session/update",
			params: {
				update: {
					sessionUpdate: "tool_call",
					title: command,
					rawInput: {
						server: "terminal",
					},
				},
			},
		}),
	]);

	assert.equal(activity.kind, "command");
	assert.equal(activity.label, "Command");
	assert.equal(activity.detail, command);
});

test("deriveSandboxAgentActivity keeps search details out of the label", () => {
	const search = "search ^(static\\s+)?int\\s+DoTls13 src/tls13.c";
	const activity = deriveSandboxAgentActivity([
		makeMessage({
			method: "session/update",
			params: {
				update: {
					sessionUpdate: "tool_call",
					title: search,
					rawInput: {},
				},
			},
		}),
	]);

	assert.equal(activity.kind, "tool");
	assert.equal(activity.label, "Search");
	assert.equal(activity.detail, "^(static\\s+)?int\\s+DoTls13 src/tls13.c");
});
