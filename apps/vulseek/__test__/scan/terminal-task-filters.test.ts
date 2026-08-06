import { normalizeTerminalTaskFilters } from "@vulseek/server/services/scan/terminal-task-filters";
import { describe, expect, it } from "vitest";

describe("terminal task filters", () => {
	it("passes every supported terminal status through to persistence", () => {
		for (const status of [
			"completed",
			"failed",
			"exited",
			"canceled",
		] as const) {
			expect(normalizeTerminalTaskFilters({ stage: "all", status })).toEqual({
				stageName: undefined,
				status,
			});
		}
	});

	it("maps a public stage name and drops all filters", () => {
		expect(
			normalizeTerminalTaskFilters({
				stage: "analyze-finding",
				status: "all",
			}),
		).toEqual({
			stageName: "analyze-finding",
			status: undefined,
		});
	});
});
