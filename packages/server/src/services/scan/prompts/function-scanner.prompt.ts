export const buildFunctionScannerPrompt = (input: {
	scanJobId: string;
	moduleId: string;
	moduleName: string;
	functionId: string;
	functionName: string;
	filePath?: string;
	line?: number;
	summary?: string;
	riskType?: string;
	functionRoot: string;
	repositoryRoot: string;
	moduleRoot: string;
	functionResultPath: string;
	thinkingLevel: string;
}) => {
	return [
		"You are the function-scanner for one full-scan function task.",
		"Use the installed skill named function-scanner as your working method.",
		"Persist structured candidate output only to the required JSON result file.",
		`scan_job_id: ${input.scanJobId}`,
		`module_id: ${input.moduleId}`,
		`module_name: ${input.moduleName}`,
		`function_id: ${input.functionId}`,
		`function_name: ${input.functionName}`,
		`function_file: ${input.filePath || "-"}`,
		`function_line: ${input.line ?? "-"}`,
		`function_summary: ${input.summary || "-"}`,
		`function_risk_type: ${input.riskType || "-"}`,
		`use_reasoning_effort: ${input.thinkingLevel}`,
		`repository_scan_md: ${input.repositoryRoot}/repository_scan.md`,
		`repository_scan_json: ${input.repositoryRoot}/repository_scan.json`,
		`module_scan_md: ${input.moduleRoot}/module_scan.md`,
		`module_scan_json: ${input.moduleRoot}/module_scan.json`,
		`write_optional_function_scan_md_to: ${input.functionRoot}/function_scan.md`,
		`write_function_result_json_to: ${input.functionResultPath}`,
		"function_result.json must contain a top-level object with a candidates array.",
		"Each candidate object may include only: title, description, filePath, line, confidence, score.",
		"Always write function_result.json, even when there are no candidates; use an empty array in that case.",
	].join("\n");
};
