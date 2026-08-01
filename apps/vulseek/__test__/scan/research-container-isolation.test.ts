import { describe, expect, test } from "vitest";
import {
	resolveStageContainerNameParts,
	resolveStageReuseContainer,
} from "../../../../packages/server/src/services/scan/stages/generic-agent.stage";

describe("Research task container isolation", () => {
	test("disables reuse for Research without changing Full or Delta behavior", () => {
		expect(resolveStageReuseContainer("research", true)).toBe(false);
		expect(resolveStageReuseContainer("full_scan", true)).toBe(true);
		expect(resolveStageReuseContainer("delta_scan", false)).toBe(false);
	});

	test("adds task identity to Research container names", () => {
		expect(
			resolveStageContainerNameParts("research", "task-b", ["track-review"]),
		).toEqual(["track-review", "task-b"]);
		expect(
			resolveStageContainerNameParts("full_scan", "task-b", ["track-review"]),
		).toEqual(["track-review"]);
	});
});
