import { NEVER_REUSE_TASK_PROMPT_LINES } from "./task-isolation.prompt";
import { renderPromptTemplate } from "./prompt-template";

export type PreparedDeltaRepositoryStateForPrompt = {
	currentBranch: string | null;
	targetRef: string | null;
	currentExactTag: string | null;
	targetTag: string | null;
	resolvedTargetSha: string;
	resolvedBaseSha: string | null;
	commitWindow: number;
};

export const buildDeltaScopePrompt = (input: {
	repository: {
		name: string;
		id: string;
	};
	repositoryState: PreparedDeltaRepositoryStateForPrompt;
	repositoryStatePath: string;
	agentProvider: string;
	thinkingLevel?: string | null;
}) =>
	renderPromptTemplate(new URL("./scan-delta-scope.prompt.md", import.meta.url), {
		taskIsolation: NEVER_REUSE_TASK_PROMPT_LINES.join("\n"),
		repositoryId: input.repository.id,
		repositoryName: input.repository.name,
		targetRef:
			input.repositoryState.currentBranch ||
			input.repositoryState.targetRef ||
			"<none>",
		targetTag:
			input.repositoryState.currentExactTag ||
			input.repositoryState.targetTag ||
			"<none>",
		targetCommit: input.repositoryState.resolvedTargetSha,
		baseCommit: input.repositoryState.resolvedBaseSha || "<none>",
		commitWindow: input.repositoryState.commitWindow,
		agentInstruction: input.thinkingLevel
			? `Use ${input.agentProvider} with reasoning effort around ${input.thinkingLevel}.`
			: `Use ${input.agentProvider}.`,
		repositoryStatePath: input.repositoryStatePath,
	});
