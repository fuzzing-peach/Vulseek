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
		case "attack-surface-model":
			return typeof record?.moduleName === "string"
				? record.moduleName
				: "attack-surface-model";
		case "identify-target": {
			const moduleName =
				typeof record?.moduleName === "string"
					? record.moduleName
					: "identify-target";
			const focus =
				typeof record?.vulnerabilityClassFocus === "string"
					? record.vulnerabilityClassFocus.trim()
					: "";
			return focus ? `${moduleName}:${focus}` : moduleName;
		}
		case "scan-target": {
			const targetName =
				typeof record?.function === "object" &&
				record.function &&
				"functionName" in record.function &&
				typeof record.function.functionName === "string"
					? record.function.functionName
					: typeof record?.targetName === "string"
						? record.targetName
						: "scan-target";
			const focus =
				typeof record?.vulnerabilityClassFocus === "string"
					? record.vulnerabilityClassFocus.trim()
					: "";
			return focus ? `${targetName}:${focus}` : targetName;
		}
		case "analyze-finding":
		case "critique-finding":
			return typeof record?.candidate === "object" &&
				record.candidate &&
				"title" in record.candidate &&
				typeof record.candidate.title === "string"
				? record.candidate.title
				: "candidate-analysis";
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
