export type PromptTemplateValues = Record<string, string | number | null | undefined>;

export const renderPromptTemplateString = (
	template: string,
	values: PromptTemplateValues,
) => {
	const rendered = template.trim().replace(
		/\{\{([a-zA-Z0-9_]+)\}\}/g,
		(_match, key) => {
			const value = values[key];
			if (value === undefined || value === null) {
				throw new Error(`Missing prompt template value: ${key}`);
			}
			return String(value);
		},
	);
	const unresolved = rendered.match(/\{\{[^{}]+\}\}/);
	if (unresolved) {
		throw new Error(`Unresolved prompt template variable: ${unresolved[0]}`);
	}
	return rendered;
};
