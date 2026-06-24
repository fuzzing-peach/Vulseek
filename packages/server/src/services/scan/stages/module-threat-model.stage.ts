import {
	moduleSchema,
	moduleThreatModelManifestSchema,
	type Module,
	type ModuleThreatModel,
	type ModuleThreatModelManifest,
} from "../artifacts/contracts/domain-object.contract";
import {
	readTaskJsonArtifact,
	writeTaskJsonArtifact,
} from "../artifacts/task-artifact-paths";
import {
	createStageDefinition,
	type StageDefinition,
	type StageQueueBinding,
} from "../pipeline/stage-definition";
import type { ScanJob } from "../types";
import {
	type PipelineContext,
	resolveStageConcurrencySetting,
	type StageContext,
} from "./full-scan-stage.runtime";

export type ModuleThreatModelStageInput = {
	scanJob: ScanJob;
	repositoryPath: string;
	modulePath: string;
	moduleId: string;
	moduleName: string;
	priority: number | null;
};

export type ModuleThreatModelStageOutput = ModuleThreatModelManifest;

const unique = (values: Array<string | null | undefined>) =>
	[...new Set(values.map((value) => value?.trim()).filter(Boolean))] as string[];

const inferSinkClasses = (module: Module) => {
	const text = [
		module.name,
		module.summary,
		...module.files,
		...module.attackSurfaces,
		...module.vulnerabilityThemes,
		...module.runtimeComponents,
	].join("\n").toLowerCase();
	const sinks = new Set<string>();
	if (/sql|database|query|postgres|mysql|sqlite/.test(text)) {
		sinks.add("sql-injection");
	}
	if (/command|shell|exec|process|spawn|child_process/.test(text)) {
		sinks.add("command-injection");
	}
	if (/file|path|upload|download|archive|tar|zip|fs\//.test(text)) {
		sinks.add("path-traversal");
	}
	if (/url|http|fetch|request|proxy|webhook/.test(text)) {
		sinks.add("ssrf");
	}
	if (/template|html|markdown|render|xss/.test(text)) {
		sinks.add("xss");
	}
	return [...sinks];
};

const buildThreatModel = (input: {
	module: Module;
	modulePath: string;
}): ModuleThreatModel => {
	const sinkClasses = inferSinkClasses(input.module);
	return {
		moduleId: input.module.moduleId,
		moduleName: input.module.name,
		modulePath: input.modulePath,
		assets: unique([
			...input.module.runtimeComponents,
			...input.module.files.slice(0, 20),
		]),
		entrypoints: unique(input.module.entryPoints).slice(0, 50),
		trustBoundaries: unique(input.module.trustBoundaries).slice(0, 50),
		attackerInputs: unique([
			...input.module.attackSurfaces,
			...input.module.entryPoints,
		]).slice(0, 50),
		sinkClasses:
			sinkClasses.length > 0
				? sinkClasses
				: unique(input.module.vulnerabilityThemes).slice(0, 20),
		likelyVulnerabilityClasses: unique([
			...sinkClasses,
			...input.module.vulnerabilityThemes,
		]).slice(0, 20),
		rulePriorities: unique([
			...sinkClasses,
			...input.module.vulnerabilityThemes,
		]).slice(0, 20),
		securityAssumptions: [
			"Module-level threat model is inferred from repository metadata and module source scope.",
		],
		assumptions: [
			"Rule Scan uses module-level repository metadata and does not enumerate every function.",
		],
		limitations: [
			"Rule scan rules are intentionally broad and require downstream analysis to confirm data flow and exploitability.",
		],
		summary:
			input.module.summary ||
			`Rule scan threat model for ${input.module.name}.`,
	};
};

export const createModuleThreatModelStageDefinition = <
	TPipelineContext extends PipelineContext,
>(input: {
	id: string;
	name: string;
	mode?: "serial" | "fanout";
	persistent?: boolean;
	reuseContainer?: boolean;
	queue?: StageQueueBinding<TPipelineContext, ModuleThreatModelStageInput>;
}): StageDefinition<
	TPipelineContext,
	ModuleThreatModelStageInput,
	ModuleThreatModelStageOutput,
	StageContext
> =>
	createStageDefinition({
		id: input.id,
		name: input.name,
		mode: input.mode || "fanout",
		persistent: input.persistent,
		reuseContainer: input.reuseContainer,
		queue: input.queue,
		getDesiredConcurrency: async (ctx) =>
			await resolveStageConcurrencySetting(ctx.scanJobId, input.id, () => 4),
		run: async (ctx, stageInput) => {
			const taskDir = await (ctx as unknown as StageContext).taskDir();
			const module = moduleSchema.parse(
				await readTaskJsonArtifact({
					taskDir,
					containerPath: stageInput.modulePath,
				}),
			);
			const threatModel = buildThreatModel({
				module,
				modulePath: stageInput.modulePath,
			});
			const threatModelPath = await writeTaskJsonArtifact({
				taskDir,
				relativePath: "outputs/module-threat-model.json",
				value: threatModel,
			});
			const manifest = moduleThreatModelManifestSchema.parse({
				repository: stageInput.repositoryPath,
				module: stageInput.modulePath,
				threatModel: threatModelPath,
			});
			await writeTaskJsonArtifact({
				taskDir,
				relativePath: "outputs/manifest.json",
				value: manifest,
			});
			return {
				completion: "immediate",
				rawOutput: JSON.stringify(manifest),
			};
		},
		validateOutput: async (_ctx, _stageInput, rawOutput) =>
			moduleThreatModelManifestSchema.parse(JSON.parse(rawOutput)),
	});
