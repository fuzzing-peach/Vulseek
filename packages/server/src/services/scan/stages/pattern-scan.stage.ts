import crypto from "node:crypto";
import {
	ruleFindingSchema,
	rulePlanSchema,
	findingManifestSchema,
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
	type PipelineContext,
	resolveStageConcurrencySetting,
	type StageContext,
} from "./full-scan-stage.runtime";

export type PatternScanStageInput = {
	scanJob: ScanJob;
	repositoryPath: string;
	modulePath: string;
	threatModelPath: string;
	rulePlanPath: string;
	moduleId: string;
	moduleName: string;
	priority: number | null;
};

export type PatternScanStageOutput = FindingManifest;

const sha1 = (value: string) =>
	crypto.createHash("sha1").update(value).digest("hex").slice(0, 12);

export const createPatternScanStageDefinition = <
	TPipelineContext extends PipelineContext,
>(input: {
	id: string;
	name: string;
	mode?: "serial" | "fanout";
	persistent?: boolean;
	reuseContainer?: boolean;
	queue?: StageQueueBinding<TPipelineContext, PatternScanStageInput>;
}): StageDefinition<
	TPipelineContext,
	PatternScanStageInput,
	PatternScanStageOutput,
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
			const plan = rulePlanSchema.parse(
				await readTaskJsonArtifact({
					taskDir,
					containerPath: stageInput.rulePlanPath,
				}),
			);
			const rawFindings: string[] = [];
			const executionReports: FindingManifest["executionReports"] = [];
			for (const pattern of plan.abstractPatterns) {
				const finding = ruleFindingSchema.parse({
					findingId: `${pattern.patternId}-${sha1(
						`${pattern.location.filePath ?? "-"}:${pattern.location.line ?? "-"}:${pattern.location.symbolName ?? "-"}:${pattern.summary}`,
					)}`,
					ruleId: pattern.patternId,
					engine: "abstract",
					riskClass: pattern.riskClass,
					priority: pattern.priority,
					location: {
						...pattern.location,
						column: null,
					},
					message: pattern.summary,
					matchedText: null,
					metadata: {
						reviewQuestions: pattern.reviewQuestions,
						evidenceToCollect: pattern.evidenceToCollect,
						discardIf: pattern.discardIf,
					},
				});
				rawFindings.push(
					await writeTaskJsonArtifact({
						taskDir,
						relativePath: `findings/${finding.findingId}.json`,
						value: finding,
					}),
				);
				executionReports.push({
					ruleId: pattern.patternId,
					engine: "abstract",
					status: "completed",
					command: null,
					exitCode: 0,
					findings: 1,
					errorMessage: null,
					artifactPath: null,
				});
			}
			const manifest = findingManifestSchema.parse({
				rawFindings,
				executionReports,
				summary: `Pattern scan produced ${rawFindings.length} abstract findings.`,
			});
			return {
				completion: "immediate",
				rawOutput: JSON.stringify(manifest),
			};
		},
		validateOutput: async (_ctx, _stageInput, rawOutput) =>
			findingManifestSchema.parse(JSON.parse(rawOutput)),
	});
