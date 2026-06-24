import crypto from "node:crypto";
import { execAsync } from "../../../utils/process/execAsync";
import {
	ruleFindingSchema,
	rulePlanSchema,
	findingManifestSchema,
	type RuleFinding,
	type RulePlan,
	type FindingManifest,
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
	launchAgentStageRuntime,
	resolveAgentStageRuntime,
} from "./agent-stage-runtime";
import {
	type PipelineContext,
	resolveStageConcurrencySetting,
	type StageContext,
} from "./full-scan-stage.runtime";
import { buildRuleArtifactRelativePath } from "./rule-artifacts";

export type RuleScanStageInput = {
	scanJob: ScanJob;
	repositoryPath: string;
	modulePath: string;
	threatModelPath: string;
	rulePlanPath: string;
	moduleId: string;
	moduleName: string;
	priority: number | null;
};

export type RuleScanStageOutput = FindingManifest;

const sha1 = (value: string) =>
	crypto.createHash("sha1").update(value).digest("hex").slice(0, 12);

const sh = (value: string) => `'${value.replace(/'/g, `'\"'\"'`)}'`;

const normalizeScopes = (scopes: string[]) => {
	const normalized = scopes
		.map((scope) => scope.trim())
		.filter(Boolean)
		.map((scope) => scope.replace(/^\/+/, ""))
		.filter((scope) => !scope.startsWith(".."));
	return normalized.length > 0 ? normalized : ["."];
};

export const buildRuleScopeArgsPrelude = (scopes: string[]) => {
	const normalizedScopes = normalizeScopes(scopes);
	const lines = [
		"scope_args=()",
		"for rule_scope in " +
			normalizedScopes.map(sh).join(" ") +
			"; do",
		"  rule_scope_matches=()",
		"  if [[ \"$rule_scope\" == *\"*\"* || \"$rule_scope\" == *\"?\"* || \"$rule_scope\" == *\"[\"* ]]; then",
		"    while IFS= read -r rule_scope_match; do",
		"      rule_scope_matches+=(\"$rule_scope_match\")",
		"    done < <(compgen -G \"$rule_scope\" || true)",
		"  fi",
		"  if (( ${#rule_scope_matches[@]} > 0 )); then",
		"    scope_args+=(\"${rule_scope_matches[@]}\")",
		"  elif [[ -e \"$rule_scope\" ]]; then",
		"    scope_args+=(\"$rule_scope\")",
		"  else",
		"    echo \"[scan-rule] skipped missing scope: $rule_scope\" >&2",
		"  fi",
		"done",
		"if (( ${#scope_args[@]} == 0 )); then scope_args=(.); fi",
	];
	return lines.join("\n");
};

export const buildRipgrepCommand = (input: {
	rule: RulePlan["rules"][number];
	scopes: string[];
}) => {
	const patterns = input.rule.execution.patterns
		.map((pattern) => `-e ${sh(pattern)}`)
		.join(" ");
	const fixedStringFlag =
		input.rule.execution.patternMode === "regex" ? "" : "-F ";
	return `cd /workspace/repo
${buildRuleScopeArgsPrelude(input.scopes)}
rg ${fixedStringFlag}--json -n --column ${patterns} "\${scope_args[@]}"`;
};

const execDocker = async (containerName: string, command: string) => {
	try {
		const result = await execAsync(
			`docker exec ${sh(containerName)} bash -lc ${sh(command)}`,
			{ maxBuffer: 10 * 1024 * 1024 },
		);
		return {
			ok: true,
			stdout: result.stdout,
			stderr: result.stderr,
			exitCode: 0,
			errorMessage: null,
		};
	} catch (error) {
		const record = error as {
			stdout?: string;
			stderr?: string;
			code?: number;
			message?: string;
		};
		return {
			ok: false,
			stdout: record.stdout || "",
			stderr: record.stderr || "",
			exitCode: typeof record.code === "number" ? record.code : null,
			errorMessage: record.stderr || record.message || String(error),
		};
	}
};

const parseRipgrepFindings = (input: {
	stdout: string;
	rule: RulePlan["rules"][number];
}): RuleFinding[] => {
	const findings: RuleFinding[] = [];
	for (const line of input.stdout.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as Record<string, unknown>;
			if (parsed.type !== "match") continue;
			const data = parsed.data as Record<string, unknown> | undefined;
			const pathRecord = data?.path as Record<string, unknown> | undefined;
			const linesRecord = data?.lines as Record<string, unknown> | undefined;
			const submatches = Array.isArray(data?.submatches)
				? (data.submatches as Array<Record<string, unknown>>)
				: [];
			const filePath =
				typeof pathRecord?.text === "string" ? pathRecord.text : null;
			const lineNumber =
				typeof data?.line_number === "number" ? data.line_number : null;
			const matchedText =
				typeof linesRecord?.text === "string" ? linesRecord.text.trim() : null;
			const column =
				typeof submatches[0]?.start === "number"
					? (submatches[0].start as number) + 1
					: null;
			findings.push(
				ruleFindingSchema.parse({
					findingId: `${input.rule.ruleId}-${sha1(
						`${filePath}:${lineNumber}:${column}:${matchedText}`,
					)}`,
					ruleId: input.rule.ruleId,
					engine: "ripgrep",
					riskClass: input.rule.riskClass,
					priority: input.rule.priority,
					location: {
						filePath,
						line: lineNumber,
						column,
						symbolName: null,
					},
					message: input.rule.intent,
					matchedText,
					metadata: {},
				}),
			);
		} catch {
			continue;
		}
	}
	return findings;
};

const parseSemgrepFindings = (input: {
	stdout: string;
	rule: RulePlan["rules"][number];
}): RuleFinding[] => {
	try {
		const parsed = JSON.parse(input.stdout) as {
			results?: Array<Record<string, unknown>>;
		};
		return (parsed.results || []).map((result) => {
			const start = result.start as Record<string, unknown> | undefined;
			const extra = result.extra as Record<string, unknown> | undefined;
			const filePath = typeof result.path === "string" ? result.path : null;
			const line = typeof start?.line === "number" ? start.line : null;
			const column = typeof start?.col === "number" ? start.col : null;
			const matchedText =
				typeof extra?.lines === "string" ? extra.lines.trim() : null;
			return ruleFindingSchema.parse({
				findingId: `${input.rule.ruleId}-${sha1(
					`${filePath}:${line}:${column}:${matchedText}`,
				)}`,
				ruleId: input.rule.ruleId,
				engine: "semgrep",
				riskClass: input.rule.riskClass,
				priority: input.rule.priority,
				location: {
					filePath,
					line,
					column,
					symbolName: null,
				},
				message:
					(typeof extra?.message === "string" && extra.message) ||
					input.rule.intent,
				matchedText,
				metadata: {},
			});
		});
	} catch {
		return [];
	}
};

const parsePatternArtifact = (value: unknown) =>
	Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];

const parseSemgrepArtifact = (value: unknown) => {
	const record = value as { rule?: unknown } | null;
	return record && typeof record.rule === "string" ? record.rule : null;
};

export const createRuleScanStageDefinition = <
	TPipelineContext extends PipelineContext,
>(input: {
	id: string;
	name: string;
	mode?: "serial" | "fanout";
	persistent?: boolean;
	reuseContainer?: boolean;
	queue?: StageQueueBinding<TPipelineContext, RuleScanStageInput>;
}): StageDefinition<
	TPipelineContext,
	RuleScanStageInput,
	RuleScanStageOutput,
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
			const plan = rulePlanSchema.parse(
				await readTaskJsonArtifact({
					taskDir,
					containerPath: stageInput.rulePlanPath,
				}),
			);
			const runtime = await resolveAgentStageRuntime({
				ctx: stageCtx,
				containerNameParts: [stageInput.moduleId.slice(0, 24)],
			});
			const rawFindings: string[] = [];
			const executionReports: FindingManifest["executionReports"] = [];
			for (const rule of plan.rules) {
				const scopes = normalizeScopes(rule.fileScopes);
				const artifactPath =
					rule.artifactPath || `/task/${buildRuleArtifactRelativePath(rule)}`;
				if (rule.engine === "ripgrep") {
					const patterns = parsePatternArtifact(
						await readTaskJsonArtifact({
							taskDir,
							containerPath: artifactPath,
						}),
					);
					const executableRule = {
						...rule,
						execution: {
							...rule.execution,
							patterns,
						},
					};
					const command = buildRipgrepCommand({ rule: executableRule, scopes });
					const result = patterns.length > 0
						? await execDocker(runtime.containerName, command)
						: {
								ok: false,
								stdout: "",
								stderr: "",
								exitCode: null,
								errorMessage: "No ripgrep patterns configured",
							};
					const findings = parseRipgrepFindings({
						stdout: result.stdout,
						rule: executableRule,
					});
					const completed =
						result.ok || result.exitCode === 1 || findings.length > 0;
					for (const finding of findings) {
						rawFindings.push(
							await writeTaskJsonArtifact({
								taskDir,
								relativePath: `findings/${finding.findingId}.json`,
								value: finding,
							}),
						);
					}
					executionReports.push({
						ruleId: rule.ruleId,
						engine: rule.engine,
						status: completed ? "completed" : "failed",
						command,
						exitCode: result.exitCode,
						findings: findings.length,
						errorMessage: completed ? null : result.errorMessage,
						artifactPath,
					});
					continue;
				}
				const semgrepRule = parseSemgrepArtifact(
					await readTaskJsonArtifact({
						taskDir,
						containerPath: artifactPath,
					}),
				);
				if (!semgrepRule) {
					executionReports.push({
						ruleId: rule.ruleId,
						engine: rule.engine,
						status: "failed",
						command: null,
						exitCode: null,
						findings: 0,
						errorMessage: `Invalid semgrep rule artifact at ${artifactPath}`,
						artifactPath,
					});
					continue;
				}
				await execDocker(
					runtime.containerName,
					`cat > /tmp/${rule.ruleId}.yaml <<'EOF'\n${semgrepRule}\nEOF`,
				);
				const command = `cd /workspace/repo
${buildRuleScopeArgsPrelude(rule.fileScopes)}
semgrep --json --config /tmp/${rule.ruleId}.yaml "\${scope_args[@]}"`;
				const result = await execDocker(runtime.containerName, command);
				const findings = parseSemgrepFindings({
					stdout: result.stdout,
					rule,
				});
				const completed = result.ok || findings.length > 0;
				for (const finding of findings) {
					rawFindings.push(
						await writeTaskJsonArtifact({
							taskDir,
							relativePath: `findings/${finding.findingId}.json`,
							value: finding,
						}),
					);
				}
				executionReports.push({
					ruleId: rule.ruleId,
					engine: rule.engine,
					status: completed ? "completed" : "failed",
					command,
					exitCode: result.exitCode,
					findings: findings.length,
					errorMessage: completed ? null : result.errorMessage,
					artifactPath,
				});
			}
			const failedReports = executionReports.filter(
				(report) => report.status === "failed",
			).length;
			const manifest = findingManifestSchema.parse({
				rawFindings,
				executionReports,
				summary: `Rule scan produced ${rawFindings.length} raw findings. ${failedReports} rule executions failed.`,
			});
			return {
				completion: "immediate",
				rawOutput: JSON.stringify(manifest),
			};
		},
		validateOutput: async (_ctx, _stageInput, rawOutput) =>
			findingManifestSchema.parse(JSON.parse(rawOutput)),
	});
