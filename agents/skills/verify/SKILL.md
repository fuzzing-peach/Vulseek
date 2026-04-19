---
name: verify
description: Verify a likely or confirmed vulnerability candidate after analysis. Decide whether it is a real vulnerability, a false positive, or API misuse; check whether it already exists in recent PRs/issues/CVEs or has already been fixed outside the current branch; assess exploit scenario and disclosure likelihood; and produce a verification report, issue draft, PoC, reproducible Docker environment, and run script.
---

# Verify

Use this skill when Vulseek launches a verifier agent for a candidate whose analysis result is already available and whose current result is either:

- `likely_vulnerability`
- `real_vulnerability`

The verifier is not a first-pass scanner. It is a confirmation and triage agent.

Its job is to validate the existing analysis, eliminate false positives and API misuse, determine novelty and fix status, assess exploit scenario and security impact, and produce a complete artifact set suitable for developer communication and reproduction.

## Inputs

You should be given:

- the candidate
- the prior analysis result
- the prior analysis report path
- the checked-out repository
- the current target revision
- access to the internet
- access to the shared scan context directory

Helpful optional inputs:

- existing PoCs or harnesses
- previous candidate notes
- existing fuzzing artifacts
- existing CodeQL database
- repository state summary

## Required Companion Skill

Read and follow `vulseek-bridge` if Dokploy asks you to emit structured events.

If Dokploy asks for a structured verification event, emit it through `VULSEEK_EVENT`. Otherwise, focus on producing the required files.

When you emit `verification_result`, include structured fields whenever you can support them:

- `result`
- `isBug`
- `isSecurity`
- `confidence`
- `reportPath`
- `issueDraftPath`
- `pocPath`
- `dockerfilePath`
- `runScriptPath`
- `summary`

## High-Level Objective

For one candidate:

1. verify whether the prior analysis conclusion is correct
2. for `likely_vulnerability`, decide whether it is actually a vulnerability
3. for `real_vulnerability`, challenge it and determine whether it is actually a false positive
4. determine whether the observed behavior is merely API misuse by the caller rather than a product vulnerability
5. if it is a real product vulnerability, determine whether it is already known, already fixed elsewhere, or genuinely new
6. recover the concrete scenario, trigger surface, and exploitability context
7. assess impact using CVSS-style reasoning
8. judge whether project maintainers are likely to accept it as a security issue and disclose a CVE
9. produce a verification report, issue draft, PoC, Docker reproduction environment, and run script

## Verification Standard

At this stage, rigor matters more than recall.

- do not preserve the previous conclusion just because the analysis agent said so
- actively try to falsify the claim
- separate product bugs from caller misuse
- separate theoretically suspicious behavior from actually reproducible security impact
- when evidence is incomplete, say exactly what is missing

## Step 1 - Reconstruct the Prior Claim

Before doing new work, restate the current hypothesis precisely:

- where is the candidate?
- what vulnerability class is being claimed?
- what path or scenario was claimed in the analysis report?
- what trigger conditions were claimed?
- what security impact was claimed?

Extract from the existing report:

- candidate location
- claimed entry point
- claimed call chain
- claimed constraints
- claimed result enum

Do not trust the report blindly. Treat it as a hypothesis to verify.

## Step 2 - Challenge the Classification

### If current result is `likely_vulnerability`

Decide whether it is:

- `real vulnerability`
- `plausible but unproven`
- `false positive`
- `api misuse`

### If current result is `real_vulnerability`

Actively challenge it. Decide whether it is actually:

- still `real vulnerability`
- `plausible but unproven`
- `false positive`
- `api misuse`

Questions to answer:

- does the repository itself violate a security property?
- is the dangerous behavior reachable in a supported usage model?
- does the issue only arise when the caller violates documented preconditions?
- is the issue actually caused by unsupported embedding or invalid API use?

## Step 3 - Determine Whether It Is API Misuse

You must explicitly consider whether the issue is really API misuse.

Treat as possible API misuse when:

- the reported path is only reachable through public library APIs
- the caller must violate documented preconditions
- the caller passes structurally invalid objects, lengths, states, or ownership assumptions
- the library exposes a dangerous low-level primitive and the claim depends on using it incorrectly

Do not dismiss as API misuse too easily.

Do not classify as API misuse if:

- the API is public and realistic callers can trigger the issue without violating clearly documented requirements
- the library fails to validate untrusted input in a common usage pattern
- the API contract is ambiguous, weak, misleading, or incomplete
- the library enters an unsafe state under plausible external input

For this step, collect:

- the relevant API contract
- whether the precondition is documented
- whether the caller behavior is realistic
- whether the library still should defensively reject it

## Step 4 - Reproduce or Refute

Try to produce concrete evidence.

Prefer:

- minimal reproducer
- debugger-backed confirmation
- sanitizers
- existing test or harness adaptation
- targeted input replay

You may use:

- `codeql`
- `semgrep`
- `grep` / `rg`
- compiler sanitizers
- existing build systems
- ad hoc harness code

Your goal is not just "can I crash it".

Your goal is to answer:

- what exact input or state triggers the behavior?
- is the behavior actually security relevant?
- can the trigger be reached in a realistic program scenario?

If full reproduction is not possible, document the strongest available evidence and the remaining gaps.


## Historical CVE / PR Cache Reuse

See also: `/root/.codex/skills/cache-schema/project-intel.md` for the normalized file layout and merge rules.


Historical CVE and PR intelligence is project-scoped and must be reused across scan jobs.

Do not hand-roll cache logic in the agent. Use the search tools instead:

- `python3 skills/search-registries/search_cve.py ...`
- `python3 skills/search-registries/search_prs.py ...`

These tools handle cache reuse, staleness checks, refresh, merge, and `updatedAt` internally. Use `--refresh` only when you have a concrete reason to bypass the normal cached path, such as suspected stale results or a need to force the newest upstream state.

In the verification report, explicitly state:

- which search tools were used
- whether the tool reported `cache-only` or `cache+refresh`
- which historical CVEs and PRs were most relevant to the final judgment

## Step 5 - Check Whether It Is Already Known or Already Fixed

If the issue appears to be a real vulnerability and not API misuse, investigate whether it is already known or already fixed elsewhere.

Check:

- recent PRs
- recent issues
- commit history on nearby code
- historical CVEs for the project
- fixes on other branches or unmerged changes

Questions to answer:

- is there already an issue describing the same bug?
- is there a PR fixing the same root cause?
- is there already a CVE for the same vulnerability pattern and same code path?
- has the bug already been fixed on another branch but not merged into the current branch?
- is the current finding merely a rediscovery of a known vulnerability?

Use exact root-cause comparison, not superficial similarity.

Two reports are the same only if they match substantially on:

- vulnerable component
- vulnerable path
- root cause
- trigger condition
- security impact

## Step 6 - Determine Scenario and Attack Surface

If the issue is still considered real after verification, determine the concrete scenario.

Answer:

- which program or subsystem does it belong to?
- at which runtime step does it occur?
- is it reachable through a public API?
- is the trigger surface remote network, local file input, IPC, command line, environment, configuration, or embedded API usage?
- is the issue pre-auth or post-auth?
- does exploitation require unusual deployment assumptions?

Be precise:

- identify the component
- identify the entry mechanism
- identify the trust boundary crossed
- identify whether the trigger is remote or local

## Step 7 - Assess Severity Using CVSS Dimensions

Evaluate the issue using CVSS-style dimensions.

At minimum assess:

- Attack Vector
- Attack Complexity
- Privileges Required
- User Interaction
- Scope
- Confidentiality Impact
- Integrity Impact
- Availability Impact

You do not need to compute a perfect official score if tooling is unavailable, but you must provide:

- a reasoned assessment for each dimension
- an approximate qualitative severity
- any uncertainty in the estimate

## Step 8 - Judge Disclosure Likelihood

Based on:

- the project's historical CVEs
- the maintainers' past issue handling
- the apparent security impact
- the trigger realism
- whether the project has previously treated similar bugs as security issues

Judge:

- whether maintainers are likely to accept this as a security vulnerability
- whether they are likely to disclose or request a CVE
- whether they may instead treat it as misuse, robustness, or hardening only

Do not confuse your own assessment with maintainers' likely reaction. Report both when they differ.

For wolfSSL specifically, do not stop at a generic statement.

You must inspect historical wolfSSL CVEs and closely similar past cases, then answer:

- whether wolfSSL maintainers have previously treated the same class of bug as a security vulnerability
- whether they have historically assigned CVEs for similar root causes, trigger surfaces, and impacts
- whether there are precedent cases showing they classify such issues as hardening only, misuse only, or non-security bugs

Do not rely on superficial similarity. Compare on:

- affected component
- root cause
- attacker-controlled input or trigger surface
- realistic impact
- whether the issue is in a public API path or an internal/debug-only path

Your report should explicitly include:

- a short list of the most relevant historical wolfSSL CVE or issue precedents
- how each precedent is similar or different
- an inference about maintainer attitude supported by those precedents
- your final judgment on whether wolfSSL maintainers are likely to consider the candidate a security vulnerability

## Step 9 - Produce Required Output Artifacts

You must generate all of the following under the candidate verification directory.

Suggested layout:

```text
/scan-context/jobs/<scanJobId>/candidates/<candidateId>/verify/
  01_verify_report.md
  02_issue_draft.md
  03_poc/
    poc.c
    poc.cpp
    poc.py
    input/
  04_repro/
    Dockerfile
    run.sh
    patches/
```

Use the language and filenames that best fit the target. You do not need to create every alternative language file. Create the minimal set that makes the reproduction usable.

### 1. Verification Report

Write a detailed markdown report.

It must include:

- candidate summary
- previous analysis claim
- verification conclusion
- real vulnerability vs false positive vs API misuse decision
- reproduction evidence
- remaining uncertainty
- root cause
- trigger conditions
- attack surface
- whether it appears already known or already fixed
- related PRs / issues / CVEs
- CVSS-style assessment
- maintainer disclosure-likelihood assessment
- final recommendation

### 2. Issue Draft

Write a shorter markdown file suitable for filing an issue.

It should be concise and developer-facing:

- summary
- affected component
- trigger conditions
- security impact
- minimal reproduction steps
- expected vs actual behavior

Do not include unnecessary internal speculation.

### 3. PoC Program

Create a PoC program that demonstrates the issue or the strongest available trigger.

Requirements:

- keep it minimal
- make it runnable
- comment only where necessary
- if full exploitation is unrealistic, demonstrate the problematic path clearly

### 4. Reproduction Dockerfile

Create a Dockerfile that builds a full reproduction environment.

It should include as needed:

- cloning the target repository
- checking out the correct revision
- build dependencies
- project build commands
- optional patch application if required for reproducible instrumentation or harnessing
- copying or generating the PoC

### 5. Run Script

Create a script that:

- builds or prepares the target
- runs the PoC
- prints the expected verification signal

The run script should be the primary entry point for replay.

## Final Classification

Use one final verifier conclusion:

- `real_vulnerability`
- `likely_vulnerability`
- `plausible_but_unproven`
- `false_positive`
- `api_misuse`

Use `api_misuse` only when the evidence clearly supports that conclusion.

## Reporting Discipline

- be explicit about what is proven and what is inferred
- separate product vulnerability from caller misuse
- prefer root-cause comparison over keyword similarity when matching PRs/issues/CVEs
- do not overclaim novelty
- do not overclaim exploitability
- do not under-report if the issue is real but awkward to reproduce

## Completion

Before finishing:

1. ensure all required artifact files exist
2. ensure the verification report states the final conclusion clearly
3. ensure the issue draft is shorter than the full report
4. ensure the Dockerfile and run script are coherent with the selected revision
5. if Dokploy requested a structured event, emit it only after the files are written
