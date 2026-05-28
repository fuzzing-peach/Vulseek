import { renderPromptTemplate } from "./prompt-template";
import { NEVER_REUSE_TASK_PROMPT_LINES } from "./task-isolation.prompt";

export const buildFunctionScannerPrompt = (input: {
	scanJobId: string;
	moduleId: string;
	moduleName: string;
	functionId: string;
	functionName: string;
	filePath?: string;
	line?: number;
	summary?: string;
	vulnerabilityType?: string;
	repositoryJsonPath: string;
	moduleJsonPath: string;
	functionJsonPath: string;
	thinkingLevel?: string | null;
}) => {
	return renderPromptTemplate(
		new URL("./scan-function.prompt.md", import.meta.url),
		{
			taskIsolation: NEVER_REUSE_TASK_PROMPT_LINES.join("\n"),
			scanJobId: input.scanJobId,
			moduleId: input.moduleId,
			moduleName: input.moduleName,
			functionId: input.functionId,
			functionName: input.functionName,
			functionFile: input.filePath || "-",
			functionLine: input.line ?? "-",
			functionSummary: input.summary || "-",
			functionVulnerabilityType: input.vulnerabilityType || "-",
			thinkingInstruction: input.thinkingLevel
				? `use_reasoning_effort: ${input.thinkingLevel}`
				: "",
			repositoryJsonPath: input.repositoryJsonPath,
			moduleJsonPath: input.moduleJsonPath,
			functionJsonPath: input.functionJsonPath,
		},
	);
};
