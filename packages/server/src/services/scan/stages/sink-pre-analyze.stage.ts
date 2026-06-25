import crypto from "node:crypto";
import {
	candidateSchema,
	ruleFindingSchema,
	findingManifestSchema,
	functionSchema,
	moduleSchema,
	sinkPreAnalyzeManifestSchema,
	sinkReviewTargetSchema,
	type Candidate,
	type RuleFinding,
	type Function,
	type SinkPreAnalyzeManifest,
	type SinkReviewTarget,
} from "../artifacts/contracts/domain-object.contract";
import {
	readTaskJsonArtifact,
	writeTaskJsonArtifact,
} from "../artifacts/task-artifact-paths";
import { createCandidateId } from "../candidate-id";
import {
	classifyRuleFileScope,
	classifyRuleModuleScope,
} from "../rule-file-scope-filter";
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

export type SinkPreAnalyzeStageInput = {
	scanJob: ScanJob;
	repositoryPath: string;
	modulePath: string;
	threatModelPath: string;
	findingManifestPath: string;
	moduleId: string;
	moduleName: string;
	priority: number | null;
};

export type SinkPreAnalyzeStageOutput = SinkPreAnalyzeManifest;

const sha1 = (value: string) =>
	crypto.createHash("sha1").update(value).digest("hex").slice(0, 16);

const targetKey = (input: {
	moduleId: string;
	riskClass: string;
	filePath: string | null;
	line: number | null;
	symbolName: string | null;
	findingId: string;
}) =>
	[
		input.moduleId,
		input.riskClass.toLowerCase(),
		input.filePath || "-",
		input.line ?? "-",
		input.symbolName || "-",
		input.findingId,
	].join(":");

const priorityRank = { high: 0, medium: 1, low: 2 } as const;

const stringArrayMetadata = (
	metadata: Record<string, unknown>,
	key: string,
): string[] => {
	const value = metadata[key];
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
};

const buildCandidate = (target: SinkReviewTarget, candidateId: string): Candidate =>
	candidateSchema.parse({
		id: candidateId,
		functionId: target.targetId,
		title: `${target.riskClass}: ${target.summary}`.slice(0, 180),
		description: [
			target.summary,
			target.ruleEvidence.length > 0
				? `Rule evidence: ${target.ruleEvidence.join("; ")}`
				: "",
		]
			.filter(Boolean)
			.join("\n"),
		filePath: target.location.filePath,
		line: target.location.line,
		vulnerabilityType: target.riskClass,
		confidence: target.targetType === "rule_finding" ? 0.45 : 0.25,
		score:
			target.priority === "high" ? 7 : target.priority === "medium" ? 5 : 3,
		claim: target.summary,
		rootCauseKey: target.normalization.key,
		evidence: [
			{
				id: `${target.targetId}-evidence`,
				kind: "code",
				summary: target.ruleEvidence.join("; ") || target.summary,
				filePath: target.location.filePath,
				line: target.location.line,
				symbol: target.location.symbolName,
				command: null,
				artifactPath: null,
				observation: target.normalization.snippet,
				supports: [target.riskClass],
				contradicts: [],
				confidenceImpact: "Rule pre-analyze seed evidence only.",
			},
		],
		attackerControl: null,
		affectedSink: target.location.symbolName || target.riskClass,
		preconditions: target.reviewQuestions,
		quickDisproofAttempt: target.discardIf.join("; ") || null,
		needsFuzzing: false,
		needsManualAnalysis: true,
		status: "pending",
		currentStage: "analyzing",
	});

const buildSyntheticFunction = (input: {
	target: SinkReviewTarget;
	moduleName: string;
}): Function =>
	functionSchema.parse({
		id: input.target.targetId,
		moduleId: input.target.moduleId,
		moduleName: input.moduleName,
		functionId: input.target.targetId,
		functionName:
			input.target.location.symbolName ||
			input.target.summary.slice(0, 80) ||
			input.target.targetId,
		filePath: input.target.location.filePath,
		line: input.target.location.line,
		priority: priorityRank[input.target.priority] + 1,
		summary: input.target.summary,
		vulnerabilityType: input.target.riskClass,
		score:
			input.target.priority === "high"
				? 7
				: input.target.priority === "medium"
					? 5
					: 3,
		role: "rule-target",
		reachability: "Requires downstream analysis from rule evidence.",
		sourceToSinkHint: input.target.summary,
		excludeReason: null,
		priorityReason: `Selected by ${input.target.targetType} pre-analyze.`,
		securityModelRelation: "Rule target context",
		attackSurface: null,
		trustBoundary: null,
		likelyVulnerabilityTypes: [input.target.riskClass],
	});

const buildDiscardedTarget = (input: {
	finding: RuleFinding;
	moduleId: string;
	moduleName: string;
	key: string;
	reason: string;
	category: string;
}): SinkReviewTarget =>
	sinkReviewTargetSchema.parse({
		targetId: `discarded-${sha1(`${input.key}:${input.finding.findingId}`)}`,
		moduleId: input.moduleId,
		targetType: "rule_finding",
		riskClass: input.finding.riskClass,
		priority: "low",
		location: input.finding.location,
		ruleEvidence: [
			`${input.finding.engine}:${input.finding.ruleId}: ${input.finding.message}`,
			`discarded: ${input.reason}`,
		],
		reviewQuestions: [],
		evidenceToCollect: [],
		discardIf: [input.reason],
		normalization: {
			key: `${input.key}:discarded:${input.category}`,
			snippet: input.finding.matchedText
				? `${input.reason}\n${input.finding.matchedText}`
				: input.reason,
			mergedFindingIds: [input.finding.findingId],
		},
		summary: `Discarded low-value ${input.finding.riskClass} rule target in ${
			input.finding.location.filePath || input.moduleName
		}${input.finding.location.line ? `:${input.finding.location.line}` : ""}: ${
			input.reason
		}`,
	});

export const createSinkPreAnalyzeStageDefinition = <
	TPipelineContext extends PipelineContext,
>(input: {
	id: string;
	name: string;
	mode?: "serial" | "fanout";
	persistent?: boolean;
	reuseContainer?: boolean;
	queue?: StageQueueBinding<TPipelineContext, SinkPreAnalyzeStageInput>;
}): StageDefinition<
	TPipelineContext,
	SinkPreAnalyzeStageInput,
	SinkPreAnalyzeStageOutput,
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
			const [module, runManifest] = await Promise.all([
				readTaskJsonArtifact({
					taskDir,
					containerPath: stageInput.modulePath,
				}).then((value) => moduleSchema.parse(value)),
				readTaskJsonArtifact({
					taskDir,
					containerPath: stageInput.findingManifestPath,
				}).then((value) => findingManifestSchema.parse(value)),
			]);
			const moduleClassification = classifyRuleModuleScope(module);
			const targets: SinkReviewTarget[] = [];
			const discardedTargets: string[] = [];
			for (const findingPath of runManifest.rawFindings) {
				const finding = ruleFindingSchema.parse(
					await readTaskJsonArtifact({
						taskDir,
						containerPath: findingPath,
					}),
				);
				const key = targetKey({
					moduleId: stageInput.moduleId,
					riskClass: finding.riskClass,
					filePath: finding.location.filePath,
					line: finding.location.line,
					symbolName: finding.location.symbolName,
					findingId: finding.findingId,
				});
				const pathClassification = classifyRuleFileScope(
					finding.location.filePath,
				);
				if (
					moduleClassification.action === "exclude" ||
					(finding.location.filePath &&
						pathClassification.action === "exclude")
				) {
					const discardedTarget = buildDiscardedTarget({
						finding,
						moduleId: stageInput.moduleId,
						moduleName: module.name,
						key,
						reason:
							moduleClassification.action === "exclude"
								? moduleClassification.reason
								: pathClassification.reason,
						category:
							moduleClassification.action === "exclude"
								? moduleClassification.category
								: pathClassification.category,
					});
					discardedTargets.push(
						await writeTaskJsonArtifact({
							taskDir,
							relativePath: `discarded-targets/${discardedTarget.targetId}.json`,
							value: discardedTarget,
						}),
					);
					continue;
				}
				const reviewQuestions = stringArrayMetadata(
					finding.metadata,
					"reviewQuestions",
				);
				const evidenceToCollect = stringArrayMetadata(
					finding.metadata,
					"evidenceToCollect",
				);
				const discardIf = stringArrayMetadata(finding.metadata, "discardIf");
				targets.push(
					sinkReviewTargetSchema.parse({
						targetId: `target-${sha1(key)}`,
						moduleId: stageInput.moduleId,
						targetType: "rule_finding",
						riskClass: finding.riskClass,
						priority: finding.priority,
						location: finding.location,
						ruleEvidence: [
							`${finding.engine}:${finding.ruleId}: ${finding.message}`,
						],
						reviewQuestions:
							reviewQuestions.length > 0
								? reviewQuestions
								: [
										"Does attacker-controlled data reach this sink without sufficient validation?",
									],
						evidenceToCollect:
							evidenceToCollect.length > 0
								? evidenceToCollect
								: [
										"Source-to-sink path",
										"Sanitization, validation, and authorization checks",
									],
						discardIf:
							discardIf.length > 0
								? discardIf
								: [
										"The matched code is unreachable or input is fully constant/trusted.",
									],
						normalization: {
							key,
							snippet: finding.matchedText,
							mergedFindingIds: [finding.findingId],
						},
						summary: `${finding.riskClass} rule target in ${
							finding.location.filePath || module.name
						}${finding.location.line ? `:${finding.location.line}` : ""}`,
					}),
				);
			}
			const sortedTargets = targets.sort(
				(left, right) =>
					priorityRank[left.priority] - priorityRank[right.priority],
			);
			const normalizedTargets: string[] = [];
			const candidates: string[] = [];
			const syntheticFunctions: string[] = [];
			const candidateIds = new Set<string>();
			const nextCandidateId = () => {
				let candidateId = createCandidateId();
				while (candidateIds.has(candidateId)) {
					candidateId = createCandidateId();
				}
				candidateIds.add(candidateId);
				return candidateId;
			};
			for (const target of sortedTargets) {
				normalizedTargets.push(
					await writeTaskJsonArtifact({
						taskDir,
						relativePath: `targets/${target.targetId}.json`,
						value: target,
					}),
				);
				const candidate = buildCandidate(target, nextCandidateId());
				candidates.push(
					await writeTaskJsonArtifact({
						taskDir,
						relativePath: `candidates/${candidate.id}.json`,
						value: candidate,
					}),
				);
				const syntheticFunction = buildSyntheticFunction({
					target,
					moduleName: module.name,
				});
				syntheticFunctions.push(
					await writeTaskJsonArtifact({
						taskDir,
						relativePath: `functions/${target.targetId}.json`,
						value: syntheticFunction,
					}),
				);
			}
			const manifest = sinkPreAnalyzeManifestSchema.parse({
				normalizedTargets,
				candidates,
				syntheticFunctions,
				discardedTargets,
				summary: `Sink pre-analyze normalized ${sortedTargets.length} rule targets into ${candidates.length} candidates and discarded ${discardedTargets.length} low-value rule targets.`,
			});
			return {
				completion: "immediate",
				rawOutput: JSON.stringify(manifest),
			};
		},
		validateOutput: async (_ctx, _stageInput, rawOutput) =>
			sinkPreAnalyzeManifestSchema.parse(JSON.parse(rawOutput)),
	});
