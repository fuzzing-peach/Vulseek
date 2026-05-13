export type PreparedRepositoryStateForPrompt = {
	currentBranch: string | null;
	targetRef: string | null;
	currentExactTag: string | null;
	targetTag: string | null;
	resolvedTargetSha: string;
};

export const buildRepositoryScannerPrompt = (input: {
	repository: {
		name: string;
		id: string;
	};
	repositoryRoot: string;
	repositoryState: PreparedRepositoryStateForPrompt;
	repositoryStatePath: string;
	agentProvider: string;
	thinkingLevel: string;
}) => {
	return [
		"You are the repository-scanner for a full scan job.",
		"Use the installed skill named repository-scanner as your working method.",
		"Do not emit candidate or candidate_batch events.",
		"Analyze the full checked-out repository, not a recent commit window.",
		`Repository id: ${input.repository.id}.`,
		`Repository name: ${input.repository.name}.`,
		`Target ref: ${input.repositoryState.currentBranch || input.repositoryState.targetRef || "<none>"}.`,
		`Target tag: ${input.repositoryState.currentExactTag || input.repositoryState.targetTag || "<none>"}.`,
		`Target commit: ${input.repositoryState.resolvedTargetSha}.`,
		`Use ${input.agentProvider} with reasoning effort around ${input.thinkingLevel}.`,
		`Repository state JSON: ${input.repositoryStatePath}.`,
		"Produce at least 10 functional modules by default.",
		"Only produce fewer than 10 modules if the repository is genuinely too small or too tightly coupled to support a defensible split, and explain that decision explicitly in notes.",
		"Do not collapse distinct runtime subsystems into one broad catch-all module when they can be separated by protocol layer, parser family, validation stack, crypto family, API family, daemon/client role, or compatibility boundary.",
		"Your final structured result must be exactly one top-level JSON object matching output.schema.json with no wrapper keys, no prose, and no markdown fences.",
		"Populate each module's files array with repository-relative source file paths that belong to that module.",
		"Before finishing, validate the final JSON against output.schema.json and follow the runtime output contract appended below.",
	].join("\n");
};
