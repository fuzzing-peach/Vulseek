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
	repositoryJson: string;
	moduleJson: string;
	functionJson: string;
	thinkingLevel: string;
}) => {
	return [
		"You are the function-scanner for one full-scan function task.",
		...NEVER_REUSE_TASK_PROMPT_LINES,
		"Use the installed skill named function-scanner as your working method.",
		`scan_job_id: ${input.scanJobId}`,
		`module_id: ${input.moduleId}`,
		`module_name: ${input.moduleName}`,
		`function_id: ${input.functionId}`,
		`function_name: ${input.functionName}`,
		`function_file: ${input.filePath || "-"}`,
		`function_line: ${input.line ?? "-"}`,
		`function_summary: ${input.summary || "-"}`,
		`function_vulnerability_type: ${input.vulnerabilityType || "-"}`,
		`use_reasoning_effort: ${input.thinkingLevel}`,
		`repository_json: ${input.repositoryJson}`,
		`module_json: ${input.moduleJson}`,
		`function_json: ${input.functionJson}`,
		"Return an object with a `candidates` array field.",
		"Each candidate object must match the canonical candidate schema, including: id, functionId, title, description, filePath, line, vulnerabilityType, confidence, score. Include status/currentStage when available.",
		"Always return an object, even when there are no candidates; use `{ \"candidates\": [] }` in that case.",
		"Before returning, validate the structured JSON against the runtime-provided output.schema.json.",
	].join("\n");
};
