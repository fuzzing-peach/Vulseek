export const resolveStageTaskName = <TInput>(
	stageName: string,
	input: TInput,
): string => {
	const record =
		(input as Record<string, unknown> | null | undefined) || undefined;
	switch (stageName) {
		case "delta-scope":
			return "delta-scoping";
		case "repository-profile":
			return "repository-profiling";
		case "repository-scan":
			return "repository-scanning";
		case "attack-surface-model":
			return typeof record?.moduleName === "string"
				? record.moduleName
				: "attack-surface-model";
		case "identify-target":
			return typeof record?.moduleName === "string"
				? record.moduleName
				: "identify-target";
		case "module-scan":
			return typeof record?.module === "object" &&
				record.module &&
				"name" in record.module &&
				typeof record.module.name === "string"
				? record.module.name
				: "module-scanning";
		case "module-threat-model":
			return typeof record?.moduleName === "string"
				? record.moduleName
				: "module-threat-model";
		case "design-rule":
			return typeof record?.moduleName === "string"
				? record.moduleName
				: "design-rule";
		case "scan-rule":
			return typeof record?.moduleName === "string"
				? record.moduleName
				: "scan-rule";
		case "scan-pattern":
			return typeof record?.moduleName === "string"
				? record.moduleName
				: "scan-pattern";
		case "sink-pre-analyze":
			return typeof record?.moduleName === "string"
				? record.moduleName
				: "sink-pre-analyze";
		case "function-scan":
		case "scan-target":
			return typeof record?.function === "object" &&
				record.function &&
				"functionName" in record.function &&
				typeof record.function.functionName === "string"
				? record.function.functionName
				: typeof record?.targetName === "string"
					? record.targetName
					: stageName === "scan-target"
						? "scan-target"
						: "function-scanning";
		case "analyze":
		case "analyze-finding":
		case "build-fuzzer":
		case "run-fuzzer":
		case "criticize":
		case "critique-finding":
			return typeof record?.candidate === "object" &&
				record.candidate &&
				"title" in record.candidate &&
				typeof record.candidate.title === "string"
				? record.candidate.title
				: "candidate-analysis";
		case "verify":
		case "verify-finding":
			return typeof record?.analysisResult === "object" &&
				record.analysisResult &&
				"candidate" in record.analysisResult &&
				typeof record.analysisResult.candidate === "object" &&
				record.analysisResult.candidate &&
				"title" in record.analysisResult.candidate &&
				typeof record.analysisResult.candidate.title === "string"
				? record.analysisResult.candidate.title
				: "candidate-verification";
		case "triage":
		case "triage-finding":
			return typeof record?.candidate === "object" &&
				record.candidate &&
				"title" in record.candidate &&
				typeof record.candidate.title === "string"
				? record.candidate.title
				: "candidate-triage";
		default:
			return stageName;
	}
};
