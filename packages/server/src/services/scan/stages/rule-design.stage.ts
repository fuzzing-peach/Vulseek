import {
	rulePlanManifestSchema,
	rulePlanSchema,
	moduleSchema,
	type RulePlan,
	type RulePlanManifest,
	type Module,
} from "../artifacts/contracts/domain-object.contract";
import {
	readTaskJsonArtifact,
	writeTaskJsonArtifact,
} from "../artifacts/task-artifact-paths";
import { bindTaskRuntimeRepo } from "../persistence/task.repo";
import {
	createStageDefinition,
	type StageDefinition,
	type StageQueueBinding,
} from "../pipeline/stage-definition";
import { buildRuleDesignerPrompt } from "../prompts/rule-designer.prompt";
import { runSingleTurnAgentInContainer } from "../runtime/run-single-turn-agent";
import type { ScanJob } from "../types";
import {
	classifyRuleFileScope,
	classifyRuleModuleScope,
	filterValuableRuleFileScopes,
} from "../rule-file-scope-filter";
import {
	launchAgentStageRuntime,
	resolveAgentStageRuntime,
} from "./agent-stage-runtime";
import {
	type PipelineContext,
	resolveStageConcurrencySetting,
	type StageContext,
} from "./full-scan-stage.runtime";
import {
	buildRuleArtifactPath,
	buildRuleArtifactRelativePath,
	buildRuleArtifactValue,
} from "./rule-artifacts";

export type RuleDesignStageInput = {
	scanJob: ScanJob;
	repositoryPath: string;
	modulePath: string;
	threatModelPath: string;
	moduleId: string;
	moduleName: string;
	priority: number | null;
};

export type RuleDesignStageOutput = RulePlanManifest;

export const getRuleModuleScopes = (module: Module) => {
	const fileScopeFilter = filterValuableRuleFileScopes(
		module.files.slice(0, 80),
	);
	if (classifyRuleModuleScope(module).action === "exclude") {
		return {
			includedScopes: [],
			excludedScopes: fileScopeFilter.classifications,
			classifications: fileScopeFilter.classifications,
		};
	}
	return fileScopeFilter;
};

const normalizeScopePath = (scope: string) =>
	scope.trim().replace(/\\/g, "/").replace(/^\.?\//, "").replace(/^\/+/, "");

const isPathWithinAllowedScopes = (path: string, allowedScopes: string[]) => {
	const normalizedPath = normalizeScopePath(path);
	return allowedScopes.some((scope) => {
		const normalizedScope = normalizeScopePath(scope);
		return (
			normalizedPath === normalizedScope ||
			normalizedPath.startsWith(`${normalizedScope.replace(/\/+$/, "")}/`)
		);
	});
};

export const validateRulePlanForModule = (input: {
	plan: RulePlan;
	module: Module;
	stageInput: Pick<RuleDesignStageInput, "modulePath" | "threatModelPath">;
}): RulePlan => {
	const scopeFilter = getRuleModuleScopes(input.module);
	const allowedScopes = scopeFilter.includedScopes.map(normalizeScopePath);
	const allowedScopeSet = new Set(allowedScopes);
	const moduleClassification = classifyRuleModuleScope(input.module);
	const plan = rulePlanSchema.parse(input.plan);

	if (plan.module.moduleId !== input.module.moduleId) {
		throw new Error(
			`Rule plan moduleId mismatch: expected ${input.module.moduleId}, got ${plan.module.moduleId}`,
		);
	}
	if (plan.module.moduleName !== input.module.name) {
		throw new Error(
			`Rule plan moduleName mismatch: expected ${input.module.name}, got ${plan.module.moduleName}`,
		);
	}
	if (plan.module.modulePath !== input.stageInput.modulePath) {
		throw new Error(
			`Rule plan modulePath mismatch: expected ${input.stageInput.modulePath}, got ${plan.module.modulePath}`,
		);
	}
	if (plan.threatModelPath !== input.stageInput.threatModelPath) {
		throw new Error(
			`Rule plan threatModelPath mismatch: expected ${input.stageInput.threatModelPath}, got ${plan.threatModelPath}`,
		);
	}

	if (allowedScopes.length === 0 && plan.rules.length > 0) {
		throw new Error(
			`Rule plan generated executable rules for a module with no allowed runtime source scopes (${moduleClassification.reason})`,
		);
	}
	if (
		allowedScopes.length > 0 &&
		plan.rules.length === 0 &&
		plan.abstractPatterns.length === 0
	) {
		throw new Error(
			"Rule plan must include at least one executable rule or abstract pattern when runtime source scopes are available",
		);
	}

	for (const rule of plan.rules) {
		if (rule.fileScopes.length === 0) {
			throw new Error(
				`Rule ${rule.ruleId} must include at least one allowed fileScope`,
			);
		}
		for (const scope of rule.fileScopes) {
			const normalizedScope = normalizeScopePath(scope);
			if (!allowedScopeSet.has(normalizedScope)) {
				throw new Error(
					`Rule ${rule.ruleId} uses disallowed fileScope ${scope}`,
				);
			}
		}
		if (rule.engine === "ripgrep") {
			if (!rule.execution.patternMode) {
				throw new Error(
					`Ripgrep rule ${rule.ruleId} must explicitly set execution.patternMode`,
				);
			}
			const patterns = rule.execution.patterns
				.map((pattern) => pattern.trim())
				.filter(Boolean);
			if (patterns.length === 0) {
				throw new Error(
					`Ripgrep rule ${rule.ruleId} must include non-empty execution.patterns`,
				);
			}
			if (patterns.some((pattern) => pattern === "../")) {
				throw new Error(
					`Ripgrep rule ${rule.ruleId} uses the forbidden high-noise bare "../" pattern`,
				);
			}
			if (rule.execution.patternMode === "regex") {
				for (const pattern of patterns) {
					try {
						new RegExp(pattern);
					} catch (error) {
						throw new Error(
							`Ripgrep rule ${rule.ruleId} has invalid regex pattern ${JSON.stringify(
								pattern,
							)}: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
				}
			}
		}
	}

	for (const target of plan.abstractPatterns) {
		const filePath = target.location.filePath;
		if (!filePath) continue;
		const classification = classifyRuleFileScope(filePath);
		if (
			classification.action !== "include" ||
			!isPathWithinAllowedScopes(filePath, allowedScopes)
		) {
			throw new Error(
				`Abstract pattern ${target.patternId} uses disallowed low-value location ${filePath}`,
			);
		}
	}

	return rulePlanSchema.parse({
		...plan,
		rules: plan.rules.map((rule) => ({
			...rule,
			fileScopes: rule.fileScopes.map(normalizeScopePath),
			artifactPath: buildRuleArtifactPath(rule),
			execution: {
				...rule.execution,
				patterns: rule.execution.patterns
					.map((pattern) => pattern.trim())
					.filter(Boolean),
			},
		})),
	});
};

export const createRuleDesignStageDefinition = <
	TPipelineContext extends PipelineContext,
>(input: {
	id: string;
	name: string;
	mode?: "serial" | "fanout";
	persistent?: boolean;
	reuseContainer?: boolean;
	queue?: StageQueueBinding<TPipelineContext, RuleDesignStageInput>;
}): StageDefinition<
	TPipelineContext,
	RuleDesignStageInput,
	RuleDesignStageOutput,
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
		launch: async (ctx, stageInput) => {
			await launchAgentStageRuntime({
				ctx: ctx as unknown as StageContext,
				scanJob: stageInput.scanJob,
				containerNameParts: [stageInput.moduleId.slice(0, 24)],
			});
		},
		run: async (ctx, stageInput) => {
			const stageCtx = ctx as unknown as StageContext;
			const taskDir = await stageCtx.taskDir();
			const module = moduleSchema.parse(
				await readTaskJsonArtifact({
					taskDir,
					containerPath: stageInput.modulePath,
				}),
			);
			const scopeFilter = getRuleModuleScopes(module);
			const runtime = await resolveAgentStageRuntime({
				ctx: stageCtx,
				containerNameParts: [stageInput.moduleId.slice(0, 24)],
			});
			const result = await runSingleTurnAgentInContainer({
				scanJob: stageInput.scanJob,
				agentProfile: runtime.agentProfile,
				containerName: runtime.containerName,
				codexHome: runtime.codexHome,
				stageDirPath: runtime.stageDirPath,
				stageRootInContainer: runtime.stageRootInContainer,
				taskId: stageCtx.taskId,
				taskStageDirPath: runtime.taskStageDirPath,
				taskStageRootInContainer: runtime.taskStageRootInContainer,
				taskRealRootInContainer: runtime.taskRealRootInContainer,
				persistent: stageCtx.persistent,
				reuseContainer: stageCtx.reuseContainer,
				groupedPersistent: stageCtx.groupedPersistent,
				allowAgentExit: stageCtx.allowAgentExit,
				laneThreadId: stageCtx.laneThreadId,
				cwd: "/workspace/repo",
				sessionMode: stageCtx.sessionMode,
				parentSessionId: stageCtx.parentSessionId,
				parentTaskId: stageCtx.parentTaskId,
				prompt: buildRuleDesignerPrompt({
					scanJobId: stageInput.scanJob.scanJobId,
					moduleId: stageInput.moduleId,
					moduleName: stageInput.moduleName,
					repositoryJsonPath: stageInput.repositoryPath,
					moduleJsonPath: stageInput.modulePath,
					threatModelJsonPath: stageInput.threatModelPath,
					includedScopes: scopeFilter.includedScopes,
					excludedScopes: scopeFilter.excludedScopes.map((scope) => ({
						path: scope.path,
						category: scope.category,
						reason: scope.reason,
					})),
					thinkingLevel: runtime.agentProfile?.thinkingLevelEnabled
						? runtime.agentProfile.thinkingLevel
						: null,
				}),
				outputSchema: rulePlanSchema,
				onThreadId: async (threadId) => {
					await bindTaskRuntimeRepo({ taskId: stageCtx.taskId, threadId });
				},
			});
			return {
				completion: "deferred",
				threadId: result.threadId,
			};
		},
		validateOutput: async (ctx, stageInput, rawOutput) => {
			const stageCtx = ctx as unknown as StageContext;
			const taskDir = await stageCtx.taskDir();
			const module = moduleSchema.parse(
				await readTaskJsonArtifact({
					taskDir,
					containerPath: stageInput.modulePath,
				}),
			);
			const plan = validateRulePlanForModule({
				plan: rulePlanSchema.parse(JSON.parse(rawOutput)),
				module,
				stageInput,
			});
			const planPath = await writeTaskJsonArtifact({
				taskDir,
				relativePath: "outputs/rule-plan.json",
				value: plan,
			});
			for (const rule of plan.rules) {
				await writeTaskJsonArtifact({
					taskDir,
					relativePath: buildRuleArtifactRelativePath(rule),
					value: buildRuleArtifactValue(rule),
				});
			}
			const manifest = rulePlanManifestSchema.parse({
				repository: stageInput.repositoryPath,
				module: stageInput.modulePath,
				threatModel: stageInput.threatModelPath,
				rulePlan: planPath,
			});
			await writeTaskJsonArtifact({
				taskDir,
				relativePath: "outputs/manifest.json",
				value: manifest,
			});
			return manifest;
		},
	});
