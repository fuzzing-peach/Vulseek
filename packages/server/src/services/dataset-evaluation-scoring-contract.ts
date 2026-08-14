import { z } from "zod";

export const datasetTrialScoringAgentOutputSchema = z.strictObject({
	jobOutputs: z.array(
		z.strictObject({
			taskId: z.string().min(1),
			hit: z.boolean(),
			matchedGroundTruthArtifacts: z.array(z.string().min(1)),
			reason: z.string().min(1).max(4000),
		}),
	),
	summary: z.string().min(1).max(8000),
});

export type DatasetTrialScoringInputOutput = {
	taskId: string;
	stageName: string;
	artifacts: string[];
};

export const selectScorableJobOutputs = <
	TOutput extends { artifacts: readonly unknown[] },
>(outputs: TOutput[]): TOutput[] =>
	outputs.filter((output) => output.artifacts.length > 0);

export type DatasetTrialScoringResult = {
	groundTruthArtifacts: string[];
	jobOutputs: Array<
		DatasetTrialScoringInputOutput & {
			hit: boolean;
			matchedGroundTruthArtifacts: string[];
			reason: string;
		}
	>;
	unmatchedGroundTruthArtifacts: string[];
	summary: string;
};

export const validateDatasetTrialScoringAgentOutput = (input: {
	rawOutput: unknown;
	groundTruthArtifacts: string[];
	jobOutputs: DatasetTrialScoringInputOutput[];
}): DatasetTrialScoringResult => {
	const parsed = datasetTrialScoringAgentOutputSchema.parse(input.rawOutput);
	const expectedTaskIds = new Set(input.jobOutputs.map((output) => output.taskId));
	const knownGroundTruthArtifacts = new Set(input.groundTruthArtifacts);
	const resultByTaskId = new Map<
		string,
		z.infer<typeof datasetTrialScoringAgentOutputSchema>["jobOutputs"][number]
	>();

	for (const output of parsed.jobOutputs) {
		if (!expectedTaskIds.has(output.taskId)) {
			throw new Error(
				`Scoring result references unknown Job output task: ${output.taskId}`,
			);
		}
		if (resultByTaskId.has(output.taskId)) {
			throw new Error(
				`Scoring result contains duplicate Job output task: ${output.taskId}`,
			);
		}
		const matchedArtifacts = [...new Set(output.matchedGroundTruthArtifacts)];
		for (const artifact of matchedArtifacts) {
			if (!knownGroundTruthArtifacts.has(artifact)) {
				throw new Error(
					`Scoring result references unknown ground-truth artifact: ${artifact}`,
				);
			}
		}
		if (output.hit !== (matchedArtifacts.length > 0)) {
			throw new Error(
				`Scoring result hit flag is inconsistent for Job output task: ${output.taskId}`,
			);
		}
		resultByTaskId.set(output.taskId, {
			...output,
			matchedGroundTruthArtifacts: matchedArtifacts,
		});
	}

	const missingTaskIds = input.jobOutputs
		.map((output) => output.taskId)
		.filter((taskId) => !resultByTaskId.has(taskId));
	if (missingTaskIds.length > 0) {
		throw new Error(
			`Scoring result is missing Job output tasks: ${missingTaskIds.join(", ")}`,
		);
	}

	const matchedGroundTruthArtifacts = new Set(
		[...resultByTaskId.values()].flatMap(
			(output) => output.matchedGroundTruthArtifacts,
		),
	);

	return {
		groundTruthArtifacts: input.groundTruthArtifacts,
		jobOutputs: input.jobOutputs.map((output) => {
			const result = resultByTaskId.get(output.taskId)!;
			return {
				...output,
				hit: result.hit,
				matchedGroundTruthArtifacts: result.matchedGroundTruthArtifacts,
				reason: result.reason,
			};
		}),
		unmatchedGroundTruthArtifacts: input.groundTruthArtifacts.filter(
			(artifact) => !matchedGroundTruthArtifacts.has(artifact),
		),
		summary: parsed.summary,
	};
};

export const buildDatasetTrialScoringPrompt = (manifestPath: string) =>
	[
		"You are evaluating scanner Job outputs against known ground-truth vulnerabilities.",
		"",
		`Read the comparison manifest at ${manifestPath}. It lists every ground-truth artifact and every Job output with local artifact paths.`,
		"Inspect every listed file with local tools. Files may use any text or binary format.",
		"",
		"For each Job output, decide whether it identifies the same vulnerability as one or more ground-truth artifacts.",
		"A thematic similarity is not a hit. Require the same vulnerable behavior, affected code or component, and security impact.",
		"Return exactly one jobOutputs entry for every manifest Job output, using its taskId verbatim.",
		"Set hit=true exactly when matchedGroundTruthArtifacts is non-empty, and use original ground-truth artifact paths from the manifest.",
		"If a Job output artifact lacks enough evidence, mark it as a miss and explain why.",
		"Do not use the network. Return only the structured result required by the output schema.",
	].join("\n");
