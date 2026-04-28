export type PreparedRepositoryStateForPrompt = {
	currentBranch: string | null;
	targetRef: string | null;
	currentExactTag: string | null;
	targetTag: string | null;
	resolvedTargetSha: string;
	markdown: string;
};

export const buildRepositoryScannerPrompt = (input: {
	repositoryRoot: string;
	modulesRoot: string;
	repositoryState: PreparedRepositoryStateForPrompt;
	agentProvider: string;
	thinkingLevel: string;
}) => {
	return [
		"You are the repository-scanner for a full scan job.",
		"Use the installed skill named repository-scanner as your working method.",
		"Do not emit candidate or candidate_batch events.",
		"Analyze the full checked-out repository, not a recent commit window.",
		`Target ref: ${input.repositoryState.currentBranch || input.repositoryState.targetRef || "<none>"}.`,
		`Target tag: ${input.repositoryState.currentExactTag || input.repositoryState.targetTag || "<none>"}.`,
		`Target commit: ${input.repositoryState.resolvedTargetSha}.`,
		`Use ${input.agentProvider} with reasoning effort around ${input.thinkingLevel}.`,
		`Write repository markdown report to ${input.repositoryRoot}/repository_scan.md.`,
		`Write repository JSON report to ${input.repositoryRoot}/repository_scan.json.`,
		`Create one module artifact directory under ${input.modulesRoot}/<moduleId>.`,
		"repository_scan.json must be exactly one top-level JSON object matching the repository-scanner skill schema with no wrapper keys, no prose, and no markdown fences.",
		"repository_scan.json must contain a top-level modules array.",
		"Each module entry in repository_scan.json.modules must contain: moduleId, name, summary, artifactDir, pathListFile, priority.",
		"Each module's pathListFile must point to a file_list.txt that you create inside that module artifact directory.",
		"file_list.txt should contain repository-relative source file paths, one path per line.",
		"Before finishing, reopen repository_scan.json and verify it is valid JSON and still exactly matches the required top-level schema.",
		"",
		`Repository state:\n${input.repositoryState.markdown}`,
	].join("\n");
};
