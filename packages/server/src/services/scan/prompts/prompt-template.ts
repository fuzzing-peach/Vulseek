import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type PromptTemplateValues = Record<string, string | number | null | undefined>;

export const renderPromptTemplateString = (
	template: string,
	values: PromptTemplateValues,
) =>
	template.trim().replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, key) => {
		const value = values[key];
		if (value === undefined || value === null) {
			throw new Error(`Missing prompt template value: ${key}`);
		}
		return String(value);
	});

export const renderPromptTemplate = (
	templateUrl: URL,
	values: PromptTemplateValues,
) => {
	const template = readFileSync(fileURLToPath(templateUrl), "utf-8").trim();
	return renderPromptTemplateString(template, values);
};
