import { describe, expect, test } from "vitest";
import { z } from "zod";
import { buildStructuredOutputPromptSuffix } from "../../../../../packages/server/src/services/scan/runtime/run-single-turn-agent";

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
