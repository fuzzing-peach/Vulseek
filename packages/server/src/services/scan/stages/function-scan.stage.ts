import path from "node:path";
import {
	validateFunctionResultFile,
} from "../artifacts/contracts/function-result.contract";
import type {
	Candidate,
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
	updateScanFunctionTaskRepo,
} from "../persistence/scan-function-task.repo";
import {
	buildFunctionScannerPrompt,
} from "../prompts/function-scanner.prompt";
import {
	removeContainer,
	runSingleTurnAgentInContainer,
	startContainer,
} from "../runtime/run-single-turn-agent";
import {
	resolveFunctionStageRuntime,
	resolveStageAgentProfile,
	type StageRuntimeTarget,
} from "./full-scan-stage.runtime";

export type FunctionScanningStageInput = {
	taskId: string;
	scanJob: ScanJob;
	repository: Repository;
	module: Module;
	function: Function;
};

export type FunctionScanningStageOutput = {
	taskId: string;
	candidates: Candidate[];
};

type FunctionStageContext = StageRuntimeTarget & {
	executionContext?: { fullScanFunctionConcurrency?: number };
};

const executeFunctionScanStage = async (
	ctx: StageRuntimeTarget,
	stageInput: FunctionScanningStageInput,
) => {
	const scanAgentProfile = await resolveStageAgentProfile(
		stageInput.scanJob,
		"scan",
	);
	const runtime = await resolveFunctionStageRuntime({
		scanJobId: stageInput.scanJob.scanJobId,
		moduleId: stageInput.module.moduleId,
		functionId: stageInput.function.functionId,
		moduleArtifactDir: stageInput.module.artifactDir,
	});
	const functionRoot = path.posix.join(
		"/scan-context",
		"jobs",
		stageInput.scanJob.scanJobId,
		"scanning",
		"full_scan",
		"modules",
		(stageInput.module.moduleId
			.replace(/[\\/]+/g, "-")
			.replace(/[^a-zA-Z0-9._-]/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "") || "unknown"),
		"functions",
		(stageInput.function.functionId
			.replace(/[\\/]+/g, "-")
			.replace(/[^a-zA-Z0-9._-]/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "") || "unknown"),
	);
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
		"function-scan",
		(stageInput.function.functionId
			.toLowerCase()
			.replace(/[^a-z0-9_.-]/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "") || "x").slice(0, 24),
		stageInput.taskId.slice(0, 6),
	].join("-");

	await updateScanFunctionTaskRepo(stageInput.taskId, { containerName });
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
		prompt: buildFunctionScannerPrompt({
			scanJobId: stageInput.scanJob.scanJobId,
			moduleId: stageInput.module.moduleId,
			moduleName: stageInput.module.name,
			functionId: stageInput.function.functionId,
			functionName: stageInput.function.functionName,
			filePath: stageInput.function.filePath || undefined,
			line: stageInput.function.line ?? undefined,
			summary: stageInput.function.summary || undefined,
			riskType: stageInput.function.riskType || undefined,
			functionRoot,
			repositoryRoot: path.posix.join(
				"/scan-context",
				"jobs",
				stageInput.scanJob.scanJobId,
				"scanning",
				"full_scan",
				"repository",
			),
			moduleRoot: runtime.runtimeRootInContainer.replace(/\/functions\/[^/]+$/, ""),
			functionResultPath: `${functionRoot}/function_result.json`,
			thinkingLevel: scanAgentProfile?.thinkingLevel || "medium",
		}),
		setupMarkdownPathInContainer: runtime.setupMarkdownPathInContainer,
		setupMarkdown: [
			"# Function Scanner Setup",
			"",
			`- scan_job_id: ${stageInput.scanJob.scanJobId}`,
			`- module_id: ${stageInput.module.moduleId}`,
			`- function_id: ${stageInput.function.functionId}`,
			`- function_name: ${stageInput.function.functionName}`,
		].join("\n"),
		onThreadId: async (threadId) => {
			await updateScanFunctionTaskRepo(stageInput.taskId, { threadId });
		},
		});
	} finally {
		await removeContainer(containerName);
	}
};

const validateFunctionStageOutput = async (
	stageInput: FunctionScanningStageInput,
): Promise<FunctionScanningStageOutput> => {
	const functionRuntimeDir = path.join(
		stageInput.module.artifactDir,
		"functions",
		stageInput.function.functionId
			.replace(/[\\/]+/g, "-")
			.replace(/[^a-zA-Z0-9._-]/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "") || "unknown",
	);
	const functionResult = await validateFunctionResultFile(
		path.join(functionRuntimeDir, "function_result.json"),
	);
	return {
		taskId: stageInput.taskId,
		candidates: functionResult.candidates
			.filter((candidate) => Boolean(candidate.title))
			.map((candidate, index) => ({
				id: `${stageInput.taskId}:candidate:${index}`,
				functionId: stageInput.function.functionId,
				title: candidate.title,
				description: candidate.description || "",
				filePath: candidate.filePath || null,
				line: candidate.line ?? null,
				confidence: candidate.confidence ?? null,
				score: candidate.score ?? null,
				status: "queued",
				currentStage: "analyzing",
			})),
	};
};

export const createFunctionScanningStageDefinition = <
	TContext extends FunctionStageContext,
>(input: {
	name?: string;
	mode?: "serial" | "fanout";
	queue?: StageQueueBinding<TContext, FunctionScanningStageInput>;
	getDesiredConcurrency?: (ctx: TContext) => Promise<number>;
}): StageDefinition<
	TContext,
	FunctionScanningStageInput,
	FunctionScanningStageOutput
> => ({
	name: input.name || "FunctionScanningStage",
	mode: input.mode || "fanout",
	queue: input.queue,
	run: async (ctx, stageInput) => {
		const result = await executeFunctionScanStage(ctx, stageInput);
		return result.rawOutput;
	},
	validateOutput: async (_ctx, stageInput) =>
		await validateFunctionStageOutput(stageInput),
	getDesiredConcurrency:
		input.getDesiredConcurrency ||
		(async (ctx) =>
			Math.max(1, ctx.executionContext?.fullScanFunctionConcurrency || 1)),
	onSuccess: async (_ctx, stageInput) => {
		const runtime = await resolveFunctionStageRuntime({
			scanJobId: stageInput.scanJob.scanJobId,
			moduleId: stageInput.module.moduleId,
			functionId: stageInput.function.functionId,
			moduleArtifactDir: stageInput.module.artifactDir,
		});
		await updateScanFunctionTaskRepo(stageInput.taskId, {
			functionScanMdPath: `${runtime.runtimeDirHost}/function_scan.md`,
			functionScanJsonPath: `${runtime.runtimeDirHost}/function_result.json`,
			errorMessage: undefined,
		});
	},
});
