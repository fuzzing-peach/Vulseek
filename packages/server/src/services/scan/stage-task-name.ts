export const resolveStageTaskName = <TInput>(
	stageName: string,
	input: TInput,
): string => {
	const record =
		(input as Record<string, unknown> | null | undefined) || undefined;
	switch (stageName) {
		case "repository-scan":
			return "repository-scanning";
		case "module-scan":
			return typeof record?.module === "object" &&
				record.module &&
				"name" in record.module &&
				typeof record.module.name === "string"
				? record.module.name
				: "module-scanning";
		case "function-scan":
			return typeof record?.function === "object" &&
				record.function &&
				"functionName" in record.function &&
				typeof record.function.functionName === "string"
				? record.function.functionName
				: "function-scanning";
		case "analyze":
		case "build-fuzzer":
		case "run-fuzzer":
		case "criticize":
			return typeof record?.candidate === "object" &&
				record.candidate &&
				"title" in record.candidate &&
				typeof record.candidate.title === "string"
				? record.candidate.title
				: "candidate-analysis";
		case "verify":
			return typeof record?.analysisResult === "object" &&
				record.analysisResult &&
				"candidate" in record.analysisResult &&
				typeof record.analysisResult.candidate === "object" &&
				record.analysisResult.candidate &&
				"title" in record.analysisResult.candidate &&
				typeof record.analysisResult.candidate.title === "string"
				? record.analysisResult.candidate.title
				: "candidate-verification";
		default:
			return stageName;
	}
};
