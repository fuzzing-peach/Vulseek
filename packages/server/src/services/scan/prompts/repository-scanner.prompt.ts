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
		"Populate each module's files array with repository-relative source file paths that belong to that module.",
		"Before returning, validate the structured JSON against the runtime-provided output.schema.json.",
		"Set output.json exit to true so Dokploy can discard this repository-scanner lane after end_turn.",
	].join("\n");
};
