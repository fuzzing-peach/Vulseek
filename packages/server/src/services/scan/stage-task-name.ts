type TaskNameRecord = Record<string, unknown>;

const asRecord = (value: unknown): TaskNameRecord | null =>
	value && typeof value === "object" ? (value as TaskNameRecord) : null;

const compactResearchSubject = (value: unknown): string | null => {
	if (typeof value !== "string") {
		return null;
	}

	const compact = value.trim().replace(/\s+/g, " ");
	if (!compact) {
		return null;
	}
	return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
};

const describeResearchSubject = (
	value: unknown,
	seen = new Set<TaskNameRecord>(),
): string | null => {
	const direct = compactResearchSubject(value);
	if (direct) {
		return direct;
	}

	const record = asRecord(value);
	if (!record || seen.has(record)) {
		return null;
	}
	seen.add(record);

	for (const key of [
		"title",
		"name",
		"objective",
		"family",
		"description",
		"id",
		"candidateId",
		"findingId",
		"rootCauseKey",
		"trackKey",
		"chainId",
	]) {
		const subject = compactResearchSubject(record[key]);
		if (subject) {
			return subject;
		}
	}

	for (const key of [
		"candidate",
		"finding",
		"chain",
		"track",
		"analysisResult",
		"confirmedPrimitive",
	]) {
		const subject = describeResearchSubject(record[key], seen);
		if (subject) {
			return subject;
		}
	}

	return null;
};

const researchSubjectFromInput = (
	input: unknown,
	keys: string[],
): string | null => {
	const record = asRecord(input);
	if (!record) {
		return null;
	}

	for (const key of keys) {
		const subject = describeResearchSubject(record[key]);
		if (subject) {
			return subject;
		}
	}

	return describeResearchSubject(record);
};

export const resolveStageTaskName = <TInput>(
	stageName: string,
	input: TInput,
): string => {
	const record = asRecord(input);
	switch (stageName) {
		case "research-scope": {
			const subject = researchSubjectFromInput(input, ["researchScope"]);
			return subject
				? `Define research scope: ${subject}`
				: "Define research scope";
		}
		case "surface-map":
			return "Map attack surface";
		case "track-plan":
			return "Plan research tracks";
		case "vulnerability-discovery": {
			const subject = researchSubjectFromInput(input, ["track"]);
			return subject
				? `Investigate track: ${subject}`
				: "Investigate research track";
		}
		case "track-review": {
			const subject = researchSubjectFromInput(input, ["track"]);
			return subject ? `Review track: ${subject}` : "Review research track";
		}
		case "finding-validation": {
			const subject = researchSubjectFromInput(input, ["finding"]);
			return subject
				? `Validate finding: ${subject}`
				: "Validate finding";
		}
		case "finding-review": {
			const subject = researchSubjectFromInput(input, ["finding"]);
			return subject ? `Review finding: ${subject}` : "Review finding";
		}
		case "chain-synthesis": {
			const subject = researchSubjectFromInput(input, ["chain"]);
			return subject
				? `Synthesize chain: ${subject}`
				: "Synthesize exploit chains";
		}
		case "chain-review": {
			const subject = researchSubjectFromInput(input, ["chain"]);
			return subject ? `Review chain: ${subject}` : "Review exploit chain";
		}
		case "exploit-validation": {
			const subject = researchSubjectFromInput(input, ["chain"]);
			return subject
				? `Validate exploit chain: ${subject}`
				: "Validate exploit chain";
		}
		case "exploit-review": {
			const subject = researchSubjectFromInput(input, ["chain"]);
			return subject
				? `Review exploit chain: ${subject}`
				: "Review exploit chain";
		}
		case "research-report": {
			const subject = researchSubjectFromInput(input, ["chain"]);
			return subject
				? `Write research report: ${subject}`
				: "Write research report";
		}
		case "goal-craft":
			return "Craft goal specification";
		case "goal-surface": {
			const feedback = asRecord(record?.feedback);
			const kind =
				typeof feedback?.kind === "string" ? feedback.kind : null;
			return kind
				? `Plan hunt goals (${kind})`
				: "Plan and dispatch hunt goals";
		}
		case "goal-hunt": {
			const subject = researchSubjectFromInput(input, ["huntGoal"]);
			return subject ? `Hunt: ${subject}` : "Hunt assigned goal";
		}
		case "goal-judge": {
			const subject = researchSubjectFromInput(input, ["candidate"]);
			return subject ? `Judge candidate: ${subject}` : "Judge candidate";
		}
		case "goal-dedup": {
			const subject = researchSubjectFromInput(input, ["candidate"]);
			return subject ? `Dedup candidate: ${subject}` : "Dedup candidate";
		}
		case "delta-scope":
			return "delta-scope";
		case "repository-profile":
			return "repository-profile";
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
				: stageName;
		case "verify-finding":
			return typeof record?.analysisResult === "object" &&
				record.analysisResult &&
				"candidate" in record.analysisResult &&
				typeof record.analysisResult.candidate === "object" &&
				record.analysisResult.candidate &&
				"title" in record.analysisResult.candidate &&
				typeof record.analysisResult.candidate.title === "string"
				? record.analysisResult.candidate.title
				: "verify-finding";
		case "triage-finding":
			return typeof record?.candidate === "object" &&
				record.candidate &&
				"title" in record.candidate &&
				typeof record.candidate.title === "string"
				? record.candidate.title
				: "triage-finding";
		default:
			return stageName;
	}
};
