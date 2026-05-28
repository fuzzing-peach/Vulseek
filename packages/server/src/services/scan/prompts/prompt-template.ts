import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const renderPromptTemplate = (
	templateUrl: URL,
	values: Record<string, string | number | null | undefined>,
) => {
	const template = readFileSync(fileURLToPath(templateUrl), "utf-8").trim();
	return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (match, key) => {
		const value = values[key];
		if (value === undefined || value === null) {
			throw new Error(`Missing prompt template value: ${key}`);
		}
		return String(value);
	});
};
