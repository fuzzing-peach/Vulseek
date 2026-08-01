export type StageSettingsPipeline = {
	id: string;
	name: string;
	stageIds: string[];
};

export const buildPipelineStageTree = <Stage extends { stageName: string }>(
	pipelines: StageSettingsPipeline[],
	stages: Stage[],
) => {
	const stageByName = new Map(stages.map((stage) => [stage.stageName, stage]));
	return pipelines.map((pipeline) => ({
		...pipeline,
		stages: pipeline.stageIds.flatMap((stageName) => {
			const stage = stageByName.get(stageName);
			return stage ? [stage] : [];
		}),
	}));
};

export const getStageSelectionState = (
	selectedStageNames: Set<string>,
	stageNames: string[],
) => {
	const checkedCount = stageNames.filter((stageName) =>
		selectedStageNames.has(stageName),
	).length;
	return {
		checkedCount,
		allChecked: checkedCount === stageNames.length && stageNames.length > 0,
		someChecked: checkedCount > 0 && checkedCount < stageNames.length,
	};
};

export const toggleStageSelection = (
	selectedStageNames: Set<string>,
	stageNames: string[],
	checked: boolean,
) => {
	const next = new Set(selectedStageNames);
	for (const stageName of stageNames) {
		if (checked) {
			next.add(stageName);
		} else {
			next.delete(stageName);
		}
	}
	return next;
};
