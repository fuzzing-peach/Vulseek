import { renderPromptTemplate } from "./prompt-template";
import { NEVER_REUSE_TASK_PROMPT_LINES } from "./task-isolation.prompt";

export const buildRuleDesignerPrompt = (input: {
	scanJobId: string;
	moduleId: string;
	moduleName: string;
	repositoryJsonPath: string;
	moduleJsonPath: string;
	threatModelJsonPath: string;
	includedScopes: string[];
	excludedScopes: Array<{ path: string; category: string; reason: string }>;
	thinkingLevel?: string | null;
}) =>
	renderPromptTemplate(
		new URL("./rule-designer.prompt.md", import.meta.url),
		{
			taskIsolation: NEVER_REUSE_TASK_PROMPT_LINES.join("\n"),
			scanJobId: input.scanJobId,
			moduleId: input.moduleId,
			moduleName: input.moduleName,
			thinkingInstruction: input.thinkingLevel
				? `use_reasoning_effort: ${input.thinkingLevel}`
				: "",
			repositoryJsonPath: input.repositoryJsonPath,
			moduleJsonPath: input.moduleJsonPath,
			threatModelJsonPath: input.threatModelJsonPath,
			includedScopesJson: JSON.stringify(input.includedScopes, null, 2),
			excludedScopesJson: JSON.stringify(input.excludedScopes, null, 2),
		},
	);
