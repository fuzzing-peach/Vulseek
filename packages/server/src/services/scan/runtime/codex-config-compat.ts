const unsupportedDefaultServiceTierPattern =
	/^\s*service_tier\s*=\s*(["'])default\1\s*(?:#.*)?$/;

export const sanitizeCodexAcpConfigToml = (configToml: string) => {
	let seenTable = false;
	return configToml
		.split(/\r?\n/)
		.filter((line) => {
			const trimmed = line.trim();
			if (/^\[.*\]\s*(?:#.*)?$/.test(trimmed)) {
				seenTable = true;
			}
			return seenTable || !unsupportedDefaultServiceTierPattern.test(line);
		})
		.join("\n");
};

/**
 * Ensure Codex native Goals (`/goal`, thread_goals) are enabled.
 * Required for goal-enabled stages that activate objectives via `/goal …`.
 */
export const ensureCodexGoalsFeature = (configToml: string) => {
	const source = (configToml || "").trimEnd();
	if (/^\s*\[features\]\s*$/m.test(source) || /^\s*\[features\]\s*(?:#.*)?$/m.test(source)) {
		if (/^\s*goals\s*=/m.test(source)) {
			return source.replace(/^\s*goals\s*=\s*.*$/m, "goals = true");
		}
		return source.replace(
			/^(\s*\[features\]\s*(?:#.*)?)$/m,
			"$1\ngoals = true",
		);
	}
	const block = ["[features]", "goals = true"].join("\n");
	return source ? `${source}\n\n${block}` : block;
};
