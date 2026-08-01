import { describe, expect, it } from "vitest";
import {
	buildPipelineStageTree,
	getStageSelectionState,
	toggleStageSelection,
} from "../components/dashboard/shared/scan-stage-settings-tree";

const stages = [
	{ stageName: "repository-profile", label: "Repository Profile" },
	{ stageName: "scan-target", label: "Scan Target" },
	{ stageName: "delta-scope", label: "Delta Scope" },
	{ stageName: "research-scope", label: "Research Scope" },
];

const pipelines = [
	{
		id: "full",
		name: "Full Scan",
		stageIds: ["repository-profile", "scan-target"],
	},
	{
		id: "delta",
		name: "Delta Scan",
		stageIds: ["delta-scope", "scan-target"],
	},
	{
		id: "research",
		name: "Research Scan",
		stageIds: ["research-scope"],
	},
];

describe("buildPipelineStageTree", () => {
	it("keeps pipeline order and repeats shared stages", () => {
		const tree = buildPipelineStageTree(pipelines, stages);

		expect(tree.map((pipeline) => pipeline.id)).toEqual([
			"full",
			"delta",
			"research",
		]);
		expect(tree[0]?.stages.map((stage) => stage.stageName)).toEqual([
			"repository-profile",
			"scan-target",
		]);
		expect(tree[1]?.stages.map((stage) => stage.stageName)).toEqual([
			"delta-scope",
			"scan-target",
		]);
	});
});

describe("pipeline stage selection", () => {
	it("selects a pipeline without clearing stages selected elsewhere", () => {
		const selected = toggleStageSelection(
			new Set(["research-scope"]),
			pipelines[0]?.stageIds ?? [],
			true,
		);

		expect([...selected].sort()).toEqual([
			"repository-profile",
			"research-scope",
			"scan-target",
		]);
	});

	it("derives checked and indeterminate state from the shared set", () => {
		expect(
			getStageSelectionState(
				new Set(["scan-target"]),
				pipelines[0]?.stageIds ?? [],
			),
		).toEqual({ checkedCount: 1, allChecked: false, someChecked: true });
	});
});
