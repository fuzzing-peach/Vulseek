import { renderPromptTemplate } from "./prompt-template";
import { NEVER_REUSE_TASK_PROMPT_LINES } from "./task-isolation.prompt";

export const buildScanTargetPrompt = (input: {
	scanJobId: string;
	moduleId: string;
	moduleName: string;
	targetId: string;
	targetName: string;
	targetKind: string;
	vulnerabilityClassFocus: string;
	filePath?: string;
	line?: number;
	summary?: string;
	repositoryJsonPath: string;
	moduleJsonPath: string;
	threatModelJsonPath: string;
	targetJsonPath: string;
	thinkingLevel?: string | null;
}) =>
	renderPromptTemplate(new URL("./scan-target.prompt.md", import.meta.url), {
		taskIsolation: NEVER_REUSE_TASK_PROMPT_LINES.join("\n"),
		scanJobId: input.scanJobId,
		moduleId: input.moduleId,
		moduleName: input.moduleName,
		targetId: input.targetId,
		targetName: input.targetName,
		targetKind: input.targetKind,
		vulnerabilityClassFocus: input.vulnerabilityClassFocus,
		targetFile: input.filePath || "-",
		targetLine: input.line ?? "-",
		targetSummary: input.summary || "-",
		repositoryJsonPath: input.repositoryJsonPath,
		moduleJsonPath: input.moduleJsonPath,
		threatModelJsonPath: input.threatModelJsonPath,
		targetJsonPath: input.targetJsonPath,
		thinkingInstruction: input.thinkingLevel
			? `use_reasoning_effort: ${input.thinkingLevel}`
			: "",
	});
