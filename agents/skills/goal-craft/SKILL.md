---
name: goal-craft
description: Draft and self-red-team a precise GoalSpec for tob-goal scans.
---

# Goal Craft

Turn a human threat direction into an outcome-heavy GoalSpec whose `goalPrompt` will be activated as a **Codex native `/goal`** on each hunt.

## Rules

- **Honor `threatDirection` strictly** — focus + attackerModel define the outcome; do not dilute into generic untrusted-input wording.
- Spend tokens on success criteria, non-goals, and loophole closure.
- Do not prescribe a single tool path for later hunt stages.
- Keep `goalPrompt` self-contained and compact (~1800 chars) so it fits Codex native goal limits after surface context is appended.
- Write `/task/goal-spec.json` before finishing.
