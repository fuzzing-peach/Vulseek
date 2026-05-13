export const buildModuleScannerPrompt = (input: {
	scanJobId: string;
	moduleId: string;
	moduleName: string;
	repositoryJson: string;
	moduleJson: string;
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
		`repository_json: ${input.repositoryJson}`,
		`module_json: ${input.moduleJson}`,
		"Use the provided module_json.files array as the source file set for this module scan.",
		"Your final structured result must be the full canonical module object matching output.schema.json. Preserve the module metadata fields and populate the functions array.",
		"Return exactly one top-level JSON object with no wrapper keys, no prose, and no markdown fences.",
		"Before finishing, validate the final JSON against output.schema.json and follow the runtime output contract appended below.",
		"Each function entry must match the full canonical function schema, including: id, moduleId, moduleName, functionId, functionName, filePath, line, priority, summary, vulnerabilityType, score.",
	].join("\n");
};
