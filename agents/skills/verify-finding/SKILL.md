---
name: verify-finding
description: Sanity-check a critic-approved vulnerability analysis by confirming whether its factual claims, code paths, symbols, data-flow descriptions, trigger conditions, and preconditions exist or basically hold. Do not decide security impact, exploitability, CVSS, EPSS, or issue-report readiness.
---

# Verify Finding

Use this skill when Vulseek launches the Verify stage for a candidate whose final analysis result is already available.

Verify is a fact-checking stage. It is not a security triage stage.

## Inputs

You should be given:

- repository, module, function, candidate, and final-analysis JSON paths
- the prior analysis report path
- the checked-out repository at the target revision
- the task directory and verify report path

Read the referenced JSON files before making a conclusion.

## Objective

Decide only whether the factual basis of the analysis is sound:

1. The referenced files, functions, symbols, and line ranges exist.
2. The described control flow or data flow is present or reasonably supported by the code.
3. The claimed trigger conditions and preconditions are present or plausible in the codebase.
4. Any contradictions or missing facts are identified clearly.

Do not decide:

- whether the finding is a vulnerability
- whether it is exploitable
- whether it is API misuse
- whether maintainers would accept it as security
- CVSS, EPSS, severity, or disclosure likelihood
- PoC, Docker reproduction, issue draft, or exploit artifacts

Those decisions belong to Triage.

## Result Values

Return one of:

- `true`: core facts, paths, code locations, and trigger conditions are present and materially support the analysis.
- `likely`: most core facts hold, but some uncertainty remains that does not clearly refute the analysis.
- `false`: a central factual claim, code path, trigger, or precondition is absent or contradicted.

## Report

Write one concise markdown report to the path provided by the stage prompt.

The report should include:

- checked files/symbols
- confirmed facts
- contradicted or missing facts
- trigger/precondition assessment
- residual uncertainty

Populate `evidenceBundle` with concise evidence that supports or contradicts the factual sanity check. Populate `residualUncertainty` with any remaining unknowns.

Do not write a separate machine-readable result file unless the stage prompt explicitly requires it.
