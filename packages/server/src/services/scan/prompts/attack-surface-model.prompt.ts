import { renderPromptTemplate } from "./prompt-template";
import { NEVER_REUSE_TASK_PROMPT_LINES } from "./task-isolation.prompt";

export const buildAttackSurfaceModelPrompt = (input: {
	scanJobId: string;
	moduleId: string;
	moduleName: string;
	repositoryJsonPath: string;
	moduleJsonPath: string;
	thinkingLevel?: string | null;
}) =>
	renderPromptTemplate(
		new URL("./attack-surface-model.prompt.md", import.meta.url),
		{
			taskIsolation: NEVER_REUSE_TASK_PROMPT_LINES.join("\n"),
			scanJobId: input.scanJobId,
			moduleId: input.moduleId,
			moduleName: input.moduleName,
			repositoryJsonPath: input.repositoryJsonPath,
			moduleJsonPath: input.moduleJsonPath,
			thinkingInstruction: input.thinkingLevel
				? `use_reasoning_effort: ${input.thinkingLevel}`
				: "",
		},
	);
