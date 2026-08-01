export const loadDiscoveryFindingArtifacts = async (input: {
	report: Record<string, unknown>;
	readArtifactJson: (path: string) => Promise<unknown>;
}) => {
	if (!Array.isArray(input.report.findingPaths)) {
		throw new Error("Research Discovery Report is missing findingPaths");
	}
	if (
		!input.report.findingPaths.every(
			(path): path is string =>
				typeof path === "string" && path.trim().length > 0,
		)
	) {
		throw new Error(
			"Research Discovery Report Finding artifact paths must be non-empty strings",
		);
	}
	return await Promise.all(
		input.report.findingPaths.map((path) => input.readArtifactJson(path)),
	);
};
