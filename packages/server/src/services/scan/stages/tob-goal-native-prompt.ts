/**
 * Build a Codex native `/goal` prompt for tob-goal hunt stages.
 *
 * codex-acp treats a first prompt block that starts with `/goal …` as the
 * slash command: it calls thread/goal/set and runs a goal-continuation turn.
 * The objective text is limited to 4000 characters by the adapter.
 */

export const CODEX_NATIVE_GOAL_MAX_CHARS = 4000;

export type TobGoalSpecLike = {
	goalId?: string;
	title?: string;
	successCriteria?: string;
	nonGoals?: string[];
	attackerModel?: string;
	stopCondition?: string;
	persistenceLanguage?: string;
	redTeamClosedLoopholes?: string[];
	goalPrompt?: string;
};

export type TobHuntGoalLike = {
	huntGoalId?: string;
	title?: string;
	objective?: string;
	focusPaths?: string[];
	riskPathways?: string[];
	rationale?: string;
	partitionDimension?: string;
};

const collapseWhitespace = (value: string) =>
	value.replace(/\s+/g, " ").trim();

const take = (value: unknown, max = 800) => {
	if (typeof value !== "string") {
		return "";
	}
	const cleaned = collapseWhitespace(value);
	if (!cleaned) {
		return "";
	}
	if (cleaned.length <= max) {
		return cleaned;
	}
	return `${cleaned.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
};

const listLines = (items: unknown, maxItems = 6, itemMax = 160) => {
	if (!Array.isArray(items)) {
		return [];
	}
	return items
		.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
		.slice(0, maxItems)
		.map((item) => `- ${take(item, itemMax)}`);
};

/**
 * Compact structured-output contract for native `/goal` hunts.
 * Mirrors other stages' hard requirement to validate against
 * /task/output.schema.json with Python jsonschema (without inlining the full schema,
 * which would exceed the 4000-char /goal objective limit).
 */
export const buildTobGoalHuntOutputContract = (input?: {
	outputFilePath?: string;
	schemaFilePath?: string;
}) => {
	const outputFilePath = input?.outputFilePath ?? "/task/output.json";
	const schemaFilePath = input?.schemaFilePath ?? "/task/output.schema.json";
	return [
		"Structured JSON output requirement (mandatory before ending the turn):",
		`- Write the final result only to ${outputFilePath} as a pure JSON object (no markdown fences, comments, or prose).`,
		`- Top-level envelope must be exactly {route, exit, output}. Set exit to false.`,
		`- route must be "candidate" or "exhausted" and must match the chosen path.`,
		`- output must match GoalHuntOutput: outcome "candidate"|"exhausted"; for candidate set output.candidate (required fields) and output.exhaustion null; for exhausted set output.exhaustion {huntGoalId, exhausted:true, methodsTried:string[], coveredPaths:string[], reason} and output.candidate null.`,
		`- ${schemaFilePath} is the source of truth for the complete envelope. Do not invent alternate field names (no snake_case free-form keys). Do not add extra fields outside the schema. Use null for nullable fields instead of omitting them unless the schema allows omission.`,
		`- Before ending, validate with Python jsonschema in the container: load ${outputFilePath} and ${schemaFilePath}, validate, print only a short success/failure line (do not dump the full JSON). If validation fails, fix and re-validate until it passes.`,
		`FINAL CHECK: (1) write complete envelope to ${outputFilePath}; (2) re-open and validate against ${schemaFilePath}; (3) only then end the turn. Never emit more than one candidate. Do not claim success without evidence. Methods are free (manual tracing, CodeQL, Semgrep, etc.).`,
	].join("\n");
};

const OUTPUT_CONTRACT_MARKER = "Structured JSON output requirement";

/**
 * Compose the native goal objective (without the `/goal` prefix).
 * Prefer crafted goalPrompt, then fold in the surface focus and the output contract.
 */
export const composeTobGoalHuntObjective = (input: {
	goalSpec?: TobGoalSpecLike | null;
	huntGoal?: TobHuntGoalLike | null;
	maxChars?: number;
}): string => {
	const maxChars = input.maxChars ?? CODEX_NATIVE_GOAL_MAX_CHARS;
	const goalSpec = input.goalSpec ?? {};
	const huntGoal = input.huntGoal ?? {};
	const outputContract = buildTobGoalHuntOutputContract();

	const sections: string[] = [];

	// Leave room for surface + contract under the /goal 4000-char cap.
	const crafted = take(goalSpec.goalPrompt, 1400);
	if (crafted) {
		sections.push(crafted);
	} else {
		const title = take(goalSpec.title, 200) || "Find one concrete, evidence-backed security bug";
		sections.push(title);
		const criteria = take(goalSpec.successCriteria, 700);
		if (criteria) {
			sections.push(`Success criteria: ${criteria}`);
		}
	}

	const surfaceBits = [
		take(huntGoal.title, 160),
		take(huntGoal.objective, 500),
	].filter(Boolean);
	if (surfaceBits.length > 0) {
		sections.push(`Assigned hunt surface (stay inside this focus): ${surfaceBits.join(" — ")}`);
	}

	const paths = listLines(huntGoal.focusPaths, 8, 120);
	if (paths.length > 0) {
		sections.push(`Focus paths:\n${paths.join("\n")}`);
	}

	const pathways = listLines(huntGoal.riskPathways, 6, 140);
	if (pathways.length > 0) {
		sections.push(`Risk pathways:\n${pathways.join("\n")}`);
	}

	const attacker = take(goalSpec.attackerModel, 280);
	if (attacker) {
		sections.push(`Attacker model: ${attacker}`);
	}

	const nonGoals = listLines(goalSpec.nonGoals, 5, 140);
	if (nonGoals.length > 0) {
		sections.push(`Non-goals:\n${nonGoals.join("\n")}`);
	}

	const persistence =
		take(goalSpec.persistenceLanguage, 220) ||
		"No bugs found is intermediate, not success; change method before giving up.";
	sections.push(`Persistence: ${persistence}`);

	const stop =
		take(goalSpec.stopCondition, 220) ||
		"Stop with exactly one candidate that meets the success criteria, or a justified exhaustion for this surface.";
	sections.push(`Stop condition: ${stop}`);

	// Hard output contract (must survive truncation).
	sections.push(outputContract);

	let objective = sections.join("\n\n").trim();
	if (objective.length <= maxChars) {
		return objective;
	}

	// Hard cap for codex-acp /goal (4000 chars). Prefer keeping the output contract.
	const contractIndex = objective.lastIndexOf(OUTPUT_CONTRACT_MARKER);
	const contract =
		contractIndex >= 0 ? objective.slice(contractIndex) : outputContract;
	const headBudget = Math.max(200, maxChars - contract.length - 2);
	const head = objective.slice(0, headBudget).trimEnd();
	return `${head}\n\n${contract}`.slice(0, maxChars);
};

export const buildTobGoalHuntNativePrompt = (input: {
	goalSpec?: TobGoalSpecLike | null;
	huntGoal?: TobHuntGoalLike | null;
	maxChars?: number;
}): string => {
	const objective = composeTobGoalHuntObjective(input);
	return `/goal ${objective}`;
};

export const tryBuildTobGoalHuntNativePrompt = (
	stageInput: unknown,
): string | null => {
	if (!stageInput || typeof stageInput !== "object" || Array.isArray(stageInput)) {
		return null;
	}
	const record = stageInput as Record<string, unknown>;
	const goalSpec =
		record.goalSpec && typeof record.goalSpec === "object" && !Array.isArray(record.goalSpec)
			? (record.goalSpec as TobGoalSpecLike)
			: null;
	const huntGoal =
		record.huntGoal && typeof record.huntGoal === "object" && !Array.isArray(record.huntGoal)
			? (record.huntGoal as TobHuntGoalLike)
			: null;
	if (!goalSpec && !huntGoal) {
		return null;
	}
	return buildTobGoalHuntNativePrompt({ goalSpec, huntGoal });
};
