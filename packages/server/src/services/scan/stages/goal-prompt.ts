/**
 * Build Codex native `/goal` prompts for goal-enabled agent stages.
 *
 * codex-acp treats a first prompt block that starts with `/goal …` as the
 * slash command: it calls thread/goal/set and runs a goal-continuation turn.
 * The objective text is limited to 4000 characters by the adapter.
 */

export const CODEX_NATIVE_GOAL_MAX_CHARS = 4000;

const collapseWhitespace = (value: string) =>
	value.replace(/\s+/g, " ").trim();

const humanizeGoalKey = (key: string) =>
	key
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^./, (character) => character.toUpperCase());

const formatGoalScalar = (value: unknown): string => {
	if (value === null || value === undefined) return "none";
	if (typeof value === "boolean") return value ? "yes" : "no";
	if (typeof value === "string") return collapseWhitespace(value) || "empty";
	if (typeof value === "number" || typeof value === "bigint") return String(value);
	return String(value);
};

const formatGoalValue = (value: unknown, indent: string): string[] => {
	if (Array.isArray(value)) {
		if (value.length === 0) return [`${indent}none`];
		return value.flatMap((item) => {
			if (item && typeof item === "object") {
				return [
					`${indent}-`,
					...formatGoalValue(item, `${indent}  `),
				];
			}
			return [`${indent}- ${formatGoalScalar(item)}`];
		});
	}
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>);
		if (entries.length === 0) return [`${indent}none`];
		return entries.flatMap(([key, child]) => {
			const label = humanizeGoalKey(key);
			if (child && typeof child === "object") {
				return [`${indent}${label}:`, ...formatGoalValue(child, `${indent}  `)];
			}
			return [`${indent}${label}: ${formatGoalScalar(child)}`];
		});
	}
	return [`${indent}${formatGoalScalar(value)}`];
};

/** Render stage input as readable task context rather than embedding raw JSON. */
export const formatGoalInputAsNaturalText = (input: unknown): string =>
	formatGoalValue(input, "").join("\n");

/**
 * Prefix a stage prompt with Codex's native goal marker and append readable
 * input context. The stage's existing output contract remains authoritative.
 */
export const buildGoalPrompt = (input: {
	prompt: string;
	input: unknown;
	maxChars?: number;
}): string => {
	const maxChars = input.maxChars ?? CODEX_NATIVE_GOAL_MAX_CHARS;
	const prompt = input.prompt.trim();
	const inputText = formatGoalInputAsNaturalText(input.input);
	const sections = [prompt, "Task input:", inputText].filter(Boolean);
	const objective = sections.join("\n\n");
	if (objective.length <= maxChars) return `/goal ${objective}`;
	return `/goal ${objective.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
};
