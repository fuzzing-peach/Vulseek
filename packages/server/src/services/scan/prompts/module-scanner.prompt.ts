export const buildModuleScannerPrompt = (input: {
	scanJobId: string;
	moduleId: string;
	moduleName: string;
	moduleRoot: string;
	repositoryRoot: string;
	pathListFileInContainer: string;
	thinkingLevel: string;
}) => {
	return [
		"You are the module-scanner for one full-scan module task.",
		"Use the installed skill named module-scanner as your working method.",
		"Use the installed skill named tree-sitter for function extraction.",
		"Do not emit candidate or candidate_batch events.",
		`scan_job_id: ${input.scanJobId}`,
		`module_id: ${input.moduleId}`,
		`module_name: ${input.moduleName}`,
		`use_reasoning_effort: ${input.thinkingLevel}`,
		`repository_scan_md: ${input.repositoryRoot}/repository_scan.md`,
		`repository_scan_json: ${input.repositoryRoot}/repository_scan.json`,
		`module_path_list: ${input.pathListFileInContainer}`,
		`write_module_scan_md_to: ${input.moduleRoot}/module_scan.md`,
		`write_module_scan_json_to: ${input.moduleRoot}/module_scan.json`,
		"module_scan.json must contain a top-level functions array.",
		"Each function entry in module_scan.json.functions must contain: functionId, functionName, filePath, line, priority, summary, riskType.",
	].join("\n");
};
