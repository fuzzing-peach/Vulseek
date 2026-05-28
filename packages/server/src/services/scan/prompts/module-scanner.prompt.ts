import { renderPromptTemplate } from "./prompt-template";
import { NEVER_REUSE_TASK_PROMPT_LINES } from "./task-isolation.prompt";

export const buildModuleScannerPrompt = (input: {
	scanJobId: string;
	moduleId: string;
	moduleName: string;
	repositoryJsonPath: string;
	moduleJsonPath: string;
	thinkingLevel?: string | null;
}) => {
	return renderPromptTemplate(
		new URL("./scan-module.prompt.md", import.meta.url),
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
		},
	);
};
