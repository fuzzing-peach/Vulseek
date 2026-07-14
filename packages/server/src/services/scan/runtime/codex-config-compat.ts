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
