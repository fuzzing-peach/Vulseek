import assert from "node:assert/strict";
import test from "node:test";
import {
	extractPayloadText,
	hasEndTurnInJsonlContent,
	renderSandboxAgentEvent,
} from "./sandbox-agent-shared";

const makeEventLine = (payload: unknown) =>
	JSON.stringify({
		payload,
	});

test("hasEndTurnInJsonlContent detects an end_turn stop reason", () => {
	const content = [
		makeEventLine({
			params: {
				update: {
					sessionUpdate: "agent_message_chunk",
					content: "done",
				},
			},
		}),
		makeEventLine({
			result: {
				stopReason: "end_turn",
			},
		}),
	].join("\n");

	assert.equal(hasEndTurnInJsonlContent(content), true);
});

test("hasEndTurnInJsonlContent ignores malformed and non-end-turn lines", () => {
	const content = [
		"{not-json",
		makeEventLine({
			result: {
				stopReason: "max_tokens",
			},
		}),
		makeEventLine({
			params: {
				update: {
					sessionUpdate: "agent_message_chunk",
					content: "not finished",
				},
			},
		}),
	].join("\n");

	assert.equal(hasEndTurnInJsonlContent(content), false);
});

test("renderSandboxAgentEvent renders visible agent text", () => {
	const event = {
		payload: {
			params: {
				update: {
					sessionUpdate: "agent_message_chunk",
					content: [{ type: "text", text: "hello" }],
				},
			},
		},
	};

	assert.equal(renderSandboxAgentEvent(event), "hello");
});

test("extractPayloadText reads nested text payloads", () => {
	assert.equal(
		extractPayloadText({
			message: {
				content: [{ text: "nested" }],
			},
		}),
		"nested",
	);
});
