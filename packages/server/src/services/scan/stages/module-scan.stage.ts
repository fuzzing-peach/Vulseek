import path from "node:path";
import {
	validateModuleScanArtifacts,
} from "../artifacts/contracts/module-scan.contract";
import type {
	Function,
	Module,
	Repository,
	ScanJob,
} from "../types";
import {
	type StageQueueBinding,
	type StageDefinition,
} from "../pipeline/stage-definition";
import {
	updateScanModuleTaskRepo,
} from "../persistence/scan-module-task.repo";
import {
	buildModuleScannerPrompt,
} from "../prompts/module-scanner.prompt";
import {
	removeContainer,
	runSingleTurnAgentInContainer,
	startContainer,
} from "../runtime/run-single-turn-agent";
import {
	resolveModuleStageRuntime,
	resolveStageAgentProfile,
	type StageRuntimeTarget,
} from "./full-scan-stage.runtime";

export type ModuleScanningStageInput = {
	taskId: string;
	scanJob: ScanJob;
	repository: Repository;
	module: Module;
};

export type ModuleScanningStageOutput = {
	taskId: string;
	functions: Function[];
};

type ModuleStageContext = StageRuntimeTarget & {
	executionContext?: { fullScanModuleConcurrency?: number };
};

const executeModuleScanStage = async (
	ctx: StageRuntimeTarget,
	stageInput: ModuleScanningStageInput,
) => {
	const scanAgentProfile = await resolveStageAgentProfile(
		stageInput.scanJob,
		"scan",
	);
	const runtime = await resolveModuleStageRuntime({
		scanJobId: stageInput.scanJob.scanJobId,
		moduleId: stageInput.module.moduleId,
		artifactDir: stageInput.module.artifactDir,
	});
	const containerName = [
		ctx.projectName
			.toLowerCase()
			.replace(/[^a-z0-9_.-]/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "") || "x",
		ctx.serviceName
			.toLowerCase()
			.replace(/[^a-z0-9_.-]/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "") || "x",
		"module-scan",
		(stageInput.module.moduleId
			.toLowerCase()
			.replace(/[^a-z0-9_.-]/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "") || "x").slice(0, 24),
		stageInput.taskId.slice(0, 6),
	].join("-");

	await updateScanModuleTaskRepo(stageInput.taskId, { containerName });
	await startContainer({
		scanJob: stageInput.scanJob,
		agentProfile: scanAgentProfile,
		containerName,
		codexHome: `${runtime.runtimeRootInContainer}/.codex`,
		runtimeDirHost: runtime.runtimeDirHost,
		runtimeRootInContainer: runtime.runtimeRootInContainer,
	});
	try {
		return await runSingleTurnAgentInContainer({
		scanJob: stageInput.scanJob,
		agentProfile: scanAgentProfile,
		containerName,
		codexHome: `${runtime.runtimeRootInContainer}/.codex`,
		runtimeDirHost: runtime.runtimeDirHost,
		runtimeRootInContainer: runtime.runtimeRootInContainer,
		cwd: "/workspace/repo",
		prompt: buildModuleScannerPrompt({
			scanJobId: stageInput.scanJob.scanJobId,
			moduleId: stageInput.module.moduleId,
			moduleName: stageInput.module.name,
			moduleRoot: runtime.runtimeRootInContainer,
			repositoryRoot: path.posix.join(
				"/scan-context",
				"jobs",
				stageInput.scanJob.scanJobId,
				"scanning",
				"full_scan",
				"repository",
			),
			pathListFileInContainer: stageInput.module.pathListFile,
			thinkingLevel: scanAgentProfile?.thinkingLevel || "medium",
		}),
		setupMarkdownPathInContainer: runtime.setupMarkdownPathInContainer,
		setupMarkdown: [
			"# Module Scanner Setup",
			"",
			`- scan_job_id: ${stageInput.scanJob.scanJobId}`,
			`- module_id: ${stageInput.module.moduleId}`,
			`- module_name: ${stageInput.module.name}`,
		].join("\n"),
		onThreadId: async (threadId) => {
			await updateScanModuleTaskRepo(stageInput.taskId, { threadId });
		},
		});
	} finally {
		await removeContainer(containerName);
	}
};

const validateModuleStageOutput = async (
	stageInput: ModuleScanningStageInput,
): Promise<ModuleScanningStageOutput> => {
	await updateScanModuleTaskRepo(stageInput.taskId, {
		moduleScanMdPath: `${stageInput.module.artifactDir}/module_scan.md`,
		moduleScanJsonPath: `${stageInput.module.artifactDir}/module_scan.json`,
		errorMessage: undefined,
	});
	const artifacts = await validateModuleScanArtifacts(
		stageInput.module.artifactDir,
	);
	return {
		taskId: stageInput.taskId,
		functions: artifacts.moduleScan.functions.map((functionEntry) => ({
			id: functionEntry.functionId,
			moduleId: stageInput.module.moduleId,
			moduleName: stageInput.module.name,
			functionId: functionEntry.functionId,
			functionName: functionEntry.functionName,
			filePath: functionEntry.filePath || null,
			line: functionEntry.line ?? null,
			priority: functionEntry.priority,
			summary: functionEntry.summary || null,
			riskType: functionEntry.riskType || null,
			score: functionEntry.score ?? null,
		})),
	};
};

export const createModuleScanningStageDefinition = <
	TContext extends ModuleStageContext,
>(input: {
	name?: string;
	mode?: "serial" | "fanout";
	queue?: StageQueueBinding<TContext, ModuleScanningStageInput>;
	getDesiredConcurrency?: (ctx: TContext) => Promise<number>;
}): StageDefinition<TContext, ModuleScanningStageInput, ModuleScanningStageOutput> => ({
	name: input.name || "ModuleScanningStage",
	mode: input.mode || "fanout",
	queue: input.queue,
	run: async (ctx, stageInput) => {
		const result = await executeModuleScanStage(ctx, stageInput);
		return result.rawOutput;
	},
	validateOutput: async (_ctx, stageInput) =>
		await validateModuleStageOutput(stageInput),
	getDesiredConcurrency:
		input.getDesiredConcurrency ||
		(async (ctx) =>
			Math.max(1, ctx.executionContext?.fullScanModuleConcurrency || 1)),
});
