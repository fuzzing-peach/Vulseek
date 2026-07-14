import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeCodexAcpConfigToml } from "./codex-config-compat";

test("removes the unsupported default service tier from copied Codex config", () => {
	const source = [
		'model = "gpt-5.4-mini"',
		'service_tier = "default"',
		'',
		'[projects."/workspace/repo"]',
		'trust_level = "trusted"',
		'',
	].join("\n");

	assert.equal(
		sanitizeCodexAcpConfigToml(source),
		[
			'model = "gpt-5.4-mini"',
			'',
			'[projects."/workspace/repo"]',
			'trust_level = "trusted"',
			'',
		].join("\n"),
	);
});

test("preserves supported service tiers and nested keys", () => {
	const source = [
		'service_tier = "fast"',
		'',
		'[model_providers.default]',
		'service_tier = "default"',
		'',
	].join("\n");

	assert.equal(sanitizeCodexAcpConfigToml(source), source);
});
