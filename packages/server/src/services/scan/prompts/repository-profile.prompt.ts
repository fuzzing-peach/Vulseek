import { NEVER_REUSE_TASK_PROMPT_LINES } from "./task-isolation.prompt";
import { renderPromptTemplate } from "./prompt-template";

export type PreparedRepositoryStateForPrompt = {
	currentBranch: string | null;
	targetRef: string | null;
	currentExactTag: string | null;
	targetTag: string | null;
	resolvedTargetSha: string;
};

export const buildRepositoryProfilePrompt = (input: {
	repository: {
		name: string;
		id: string;
	};
	repositoryRoot: string;
	repositoryState: PreparedRepositoryStateForPrompt;
	repositoryStatePath: string;
	agentProvider: string;
	thinkingLevel?: string | null;
}) => {
	return renderPromptTemplate(new URL("./repository-profile.prompt.md", import.meta.url), {
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
		agentInstruction: input.thinkingLevel
			? `Use ${input.agentProvider} with reasoning effort around ${input.thinkingLevel}.`
			: `Use ${input.agentProvider}.`,
		repositoryStatePath: input.repositoryStatePath,
	});
};
