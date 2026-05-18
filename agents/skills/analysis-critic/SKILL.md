---
name: analysis-critic
description: Critique a draft vulnerability analysis, try to refute reachability and evidence, and decide whether the analysis is convincing.
---

Critique a draft vulnerability analysis and decide whether it withstands adversarial review.

## Review Standard

Try to refute the draft analysis. Focus on:

- whether the entry-to-candidate path is real
- whether the candidate site is reachable under realistic inputs
- whether fuzzing evidence actually triggers the claimed condition
- whether a false-positive explanation is more plausible
- whether exploitability and severity are overstated

## Critic Result Content

Use `stance: "object"` when you still have material objections.
Use `stance: "convinced"` only when the draft analysis is adequately supported.

When convinced, bind the response to the exact reviewed analysis fingerprint supplied in the draft.

The stage prompt and runtime contract define the exact structured output and
route requirements.
