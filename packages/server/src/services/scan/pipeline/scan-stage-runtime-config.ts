import {
	createStageRuntimeConfigWithDeps,
	type StageRuntimeConfigDeps,
} from "./scan-pipeline-definitions";
import { loadScanJobPipelineDefinitionSnapshotRepo } from "../persistence/scan-job.repo";

export type StageRuntimeConfig = ReturnType<
	typeof createStageRuntimeConfigWithDeps
>;

export const createStageRuntimeConfig = (
	scanJobId: string,
	stageName: string,
	deps: StageRuntimeConfigDeps = {
		loadScanJobPipelineDefinitionSnapshot: loadScanJobPipelineDefinitionSnapshotRepo,
	},
) =>
	createStageRuntimeConfigWithDeps({
		scanJobId,
		stageName,
		loadScanJobPipelineDefinitionSnapshot: deps.loadScanJobPipelineDefinitionSnapshot,
	});
