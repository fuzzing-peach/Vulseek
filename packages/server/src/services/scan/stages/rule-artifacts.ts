import type { RulePlan } from "../artifacts/contracts/domain-object.contract";

type Rule = RulePlan["rules"][number];

const yamlString = (value: string) => JSON.stringify(value);

export const buildRuleArtifactRelativePath = (rule: Rule) =>
	rule.engine === "semgrep"
		? `rules/${rule.ruleId}.yaml`
		: `rules/${rule.ruleId}.patterns.json`;

export const buildRuleArtifactPath = (rule: Rule) =>
	`/task/${buildRuleArtifactRelativePath(rule)}`;

export const buildSemgrepRuleArtifact = (rule: Rule) => {
	const regexes =
		rule.execution.semgrepRule ||
		rule.execution.patterns
			.map((pattern) => pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
			.join("|");
	return [
		"rules:",
		`  - id: ${yamlString(rule.ruleId)}`,
		"    languages: [generic]",
		`    message: ${yamlString(rule.intent)}`,
		"    severity: WARNING",
		`    pattern-regex: ${yamlString(regexes || rule.ruleId)}`,
		"",
	].join("\n");
};

export const buildRuleArtifactValue = (rule: Rule) =>
	rule.engine === "semgrep"
		? { rule: buildSemgrepRuleArtifact(rule) }
		: rule.execution.patterns;
