import {
	mapRunningTaskStage,
	RUNNING_TASK_VIEW_STATUSES,
} from "@vulseek/server/services/scan/running-task-stage";
import { describe, expect, it } from "vitest";

describe("mapRunningTaskStage", () => {
	it("returns canonical stage IDs without aliases", () => {
		expect(mapRunningTaskStage("repository-profile")).toBe(
			"repository-profile",
		);
		expect(mapRunningTaskStage("identify-target")).toBe("identify-target");
		expect(mapRunningTaskStage("scan-target")).toBe("scan-target");
	});

	it("rejects legacy stage IDs", () => {
		for (const stageName of [
			"delta_scoping",
			"repository-scan",
			"repository_scanning",
			"attack_surface_modeling",
			"module-scan",
			"module_scanning",
			"function-scan",
			"function_scanning",
			"analyzing",
			"analysis-critic",
			"criticizing",
			"verifying",
			"triaging",
		]) {
			expect(mapRunningTaskStage(stageName)).toBeNull();
		}
	});

	it("includes every active task status in the running task view", () => {
		expect(RUNNING_TASK_VIEW_STATUSES).toEqual([
			"launching",
			"launched",
			"starting",
			"running",
		]);
	});

	it("drops unknown stages", () => {
		expect(mapRunningTaskStage("unknown-stage")).toBeNull();
	});
});
