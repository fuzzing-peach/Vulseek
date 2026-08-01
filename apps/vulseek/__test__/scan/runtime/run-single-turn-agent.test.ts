import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
	buildCodexConfigToml,
	buildResearchContainerEnvPairs,
	requireResearchDatabaseContext,
	buildStructuredOutputPromptSuffix,
} from "../../../../../packages/server/src/services/scan/runtime/run-single-turn-agent";

const schema = z.object({
	value: z.string(),
});

describe("buildStructuredOutputPromptSuffix", () => {
	test("uses stable task output paths for non-routed stages", () => {
		const suffix = buildStructuredOutputPromptSuffix(
			schema,
			"/task/output.schema.json",
			"/task/output.json",
		);

		expect(suffix).toMatch(
			/Write the final structured result to \/task\/output\.json/,
		);
		expect(suffix).toMatch(
			/JSON Schema for the complete output\.json envelope is written to \/task\/output\.schema\.json/,
		);
		expect(suffix).toMatch(
			/Load \/task\/output\.json, load \/task\/output\.schema\.json/,
		);
		expect(suffix).toMatch(
			/This stage has no dynamic route; set output\.json route to null/,
		);
		expect(suffix).not.toMatch(/\/scan-context\//);
		expect(suffix).not.toMatch(/\/workspace\/repo/);
		expect(suffix).toMatch(
		/FINAL CHECK BEFORE ENDING THIS TURN:[\s\S]*Only then end the turn\./,
		);
	});

	test("keeps dynamic route instructions with stable task paths", () => {
		const suffix = buildStructuredOutputPromptSuffix(
			schema,
			"/task/output.schema.json",
			"/task/output.json",
			[
				{
					routeKey: "build",
					description: "Build a fuzzer",
					schema,
					default: true,
				},
				{
					routeKey: "critic",
					description: "Criticize analysis",
					schema,
				},
			],
		);

		expect(suffix).toMatch(
			/Write the final structured result to \/task\/output\.json/,
		);
		expect(suffix).toMatch(/Dynamic route requirement:/);
		expect(suffix).toMatch(/- build \(default\): Build a fuzzer/);
		expect(suffix).toMatch(/- critic: Criticize analysis/);
		expect(suffix).not.toMatch(/\/scan-context\//);
		expect(suffix).not.toMatch(/\/workspace\/repo/);
	});
});

const codexProfile = (authMode: "api_key" | "host_home") => ({
	agentProfileId: "profile-123",
	name: "Codex",
	provider: "codex" as const,
	authMode,
	homePath: "/home/test/.codex",
	baseUrl: "https://api.openai.com/v1",
	apiKey: "test-api-key",
	model: "gpt-5.6-luna",
	thinkingLevel: "medium",
	thinkingLevelEnabled: true,
	envs: "",
	isEnabled: true,
});

describe("buildCodexConfigToml", () => {
	test("uses the native Codex auth provider for host-home OAuth credentials", () => {
		const config = buildCodexConfigToml(codexProfile("host_home"));

		expect(config).toContain('model = "gpt-5.6-luna"');
		expect(config).not.toContain('preferred_auth_method = "apikey"');
		expect(config).not.toContain('model_provider = "profile-123"');
		expect(config).not.toContain("[model_providers.profile-123]");
	});

	test("keeps the configured API-key provider for API-key credentials", () => {
		const config = buildCodexConfigToml(codexProfile("api_key"));

		expect(config).toContain('preferred_auth_method = "apikey"');
		expect(config).toContain('model_provider = "profile-123"');
		expect(config).toContain("[model_providers.profile-123]");
	});
});

describe("buildResearchContainerEnvPairs", () => {
	test("passes the database URL by inherited environment name only", () => {
		expect(
			buildResearchContainerEnvPairs("research", "job-a", "task-a"),
		).toEqual([
			"VULSEEK_SCAN_JOB_ID=job-a",
			"VULSEEK_TASK_ID=task-a",
			"VULSEEK_RESEARCH_DATABASE_URL",
		]);
	});

	test("does not add Research database context to Full or Delta scans", () => {
			expect(buildResearchContainerEnvPairs("full", "job-a", "task-a")).toEqual(
			[],
		);
			expect(buildResearchContainerEnvPairs("delta", "job-a", "task-a")).toEqual(
			[],
		);
	});

	test("rejects a Research launch without database context", () => {
		expect(() =>
			requireResearchDatabaseContext("research", {}),
		).toThrow(/VULSEEK_RESEARCH_DATABASE_URL/);
		expect(() =>
				requireResearchDatabaseContext("full", {}),
		).not.toThrow();
	});
});
