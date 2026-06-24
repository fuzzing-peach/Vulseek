import { renderPromptTemplate } from "./prompt-template";
import { NEVER_REUSE_TASK_PROMPT_LINES } from "./task-isolation.prompt";

export const buildIdentifyTargetPrompt = (input: {
	scanJobId: string;
	moduleId: string;
	moduleName: string;
	repositoryJsonPath: string;
	moduleJsonPath: string;
	threatModelJsonPath: string;
	thinkingLevel?: string | null;
}) =>
	renderPromptTemplate(new URL("./identify-target.prompt.md", import.meta.url), {
		taskIsolation: NEVER_REUSE_TASK_PROMPT_LINES.join("\n"),
		scanJobId: input.scanJobId,
		moduleId: input.moduleId,
		moduleName: input.moduleName,
		repositoryJsonPath: input.repositoryJsonPath,
		moduleJsonPath: input.moduleJsonPath,
		threatModelJsonPath: input.threatModelJsonPath,
		thinkingInstruction: input.thinkingLevel
			? `use_reasoning_effort: ${input.thinkingLevel}`
			: "",
	});
