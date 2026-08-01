# Trail of Bits: How we use `/goal` to find bugs in Patch the Planet

> Source notes from the Trail of Bits blog (2026-07-28).
>
> Original: https://blog.trailofbits.com/2026/07/28/how-we-use-goal-to-find-bugs-in-patch-the-planet/
>
> Context: Patch the Planet is a joint Trail of Bits / OpenAI initiative to find and fix bugs in widely used open-source software (e.g. Rust, curl, zlib, Keycloak).

This note captures the **main ideas and operational techniques** from the article, not a verbatim reprint.

---

## What `/goal` is

- Codex feature for **goal-based prompting**: give an open-ended objective plus a **success condition**, then let the model work autonomously toward it.
- In the article, `/goal` means goal-based prompting in general.
- Recommended usage: let **Codex set goals for itself via a tool call**; engineers rarely type the slash command by hand.
- Effect: the objective **survives across multi-turn runs and context compaction**, so the model holds scope longer than ordinary chat.

---

## Why it mattered in Patch the Planet

Engineers kept seeing `/goal` in internal bug-report channels. Highlights attributed to this style of work:

| Result | Detail |
|--------|--------|
| Rust | Every Rust bug they submitted came from one variant-analysis pipeline built on `/goal`, including a soundness hole and a miscompilation patched in Rust 1.98 |
| CVE → Semgrep variants | Turned each project’s past CVEs into Semgrep rules that must fire on the vulnerable version and stay silent on the patched version; flagged **11 variant hits** across projects |
| Keycloak | Two potential high-severity privilege-escalation bugs in the SAML component during a discovery run |

Related earlier field report (zlib fuzzing lab in a day): frontier model + `/goal` enabled end-to-end work with less hand-holding—reject weak findings, expand coverage when a line dies, keep going until sanitizer-backed PoCs exist.

---

## Three techniques they converged on

### 1. Let Codex write the goal

**Core tip:** use Codex to draft each `/goal` prompt.

Workflow:

1. Give Codex threat-model files and what you care about.
2. Ask it to write the goal prompt (meta-prompting).
3. Ask it to **red-team its own goal**: list ways a future run might be lazy or satisfy the letter of the goal without real work, then revise criteria to close those outs.
4. Iterate as new shortcuts appear; fold them into the next prompt revision.

Why this works:

- Codex knows the target *and* its own failure modes better than a cold human draft.
- It turns a threat model into **concrete, testable success criteria**, prioritizes paths, and phrases outcomes tightly enough that a run can converge.
- Defining outcomes carefully closes “easy outs” you would otherwise miss.

Supporting tooling:

- **[aicov](https://github.com/trailofbits/aicov)** — tracks which lines of code Codex actually read, so it cannot claim full-codebase review while skipping large regions.

Example meta-prompt style (from the post):

> based on threat model write goal to find single critical issue (RCE) exploitable by remote attacker for kubectl-client. the kubectl-client is used in normal config, malicious remote users exploits.

---

### 2. Define the outcome, not the path

**Philosophy:** spend as many tokens as needed defining the **outcome**; spend almost none telling the model **how** to get there.

| Do | Don’t |
|----|--------|
| Name a precise, verifiable success condition | “Find bugs in X” (no stop condition) |
| Define attacker model and what **does not** count | Prescribe a single method (“must use my existing harness only”) |
| Write persistence into the goal (“no bugs found” is intermediate, not done) | Over-specify root cause so the search collapses |
| Reference a `THREAT_MODEL.md` for valid-bug shape | Optimize for token-saving by under-specifying what “done” means |

**Scope calibration:**

- **Too specific:** feed exact root cause of a known bug → variant hunt found nothing.
- **Better:** one sentence describing the *class* of bugs from that known issue → many hits (they reported 9; 3 already fixed upstream).
- **Too vague:** model never knows when to stop; surfaces low-impact issues and burns tokens.

**Path under-specification:**

- “Use fuzzing” is about as far as you should go if you want fuzzing involved.
- “Build on my existing harness” or “must build a new harness” are both worse: they freeze judgment and kill open-ended problem solving, which is the point of `/goal`.

**Best resource for bug-hunting goals:** a **`THREAT_MODEL.md`**.

- Precisely defines what a valid bug looks like **without** explaining how to find it.
- They ended up referencing a threat model in almost every goal.
- Recommendation: every open-source project should maintain one.

**Example complete outcome** (kubectl-client style, condensed from the post):

- Audit repo to find **exactly one** previously unreported **critical remote RCE**.
- Reachable under **normal/default** client config by a malicious remote user/server controlling only network/API responses, legitimately fetched K8s objects, or other remote data accepted in normal use.
- First build a concise threat model of remote entry points and trust boundaries.
- Prioritize high-risk path classes (deserialization, YAML/JSON/protobuf, dynamic import/eval/templates, archive extraction, auth redirects, generated hooks, websocket/exec/attach/port-forward, subprocess/filesystem effects).
- **Reject** findings that assume attacker control of local kubeconfig, CLI args, env vars, plugins, source, credentials, privileged cluster/admin access, or prior code execution.
- Before accepting: search local known-findings + open issues/PRs for duplicates.
- Produce a **minimal safe proof** of attacker-controlled code execution or a direct RCE primitive under stated config.
- **Stop after one** valid critical issue; write to `./findings/`.

On heavily audited codebases, “no bugs found” happened more than once—they treat that as **intermediate**, not success, and encode persistence in the goal text itself.

---

### 3. Assign one outcome per agent

**Problem:** two competing outcomes in one `/goal` cause uneven optimization.

zlib example:

- Same prompt: “find bugs” + “high coverage”.
- Model gravitated to early regions and fuzzed them hard, never reaching the rest.
- Adding coverage requirements made the run optimize coverage instead; vulnerability hunting suffered.

**What worked:**

1. First pass: identify the **five most promising attack surfaces** after reading the codebase.
2. Spin a **separate `/goal` session** per surface to find bugs there.
3. Add one **fully open-ended** session to roam unassigned areas.
4. Result: drastically better (see their zlib field report).

#### Rust variant-analysis pipeline (one outcome per agent at scale)

Built by Kevin Valerio; every Patch the Planet Rust bug they submitted came from this system.

1. **Ingest:** download every `P-critical` issue from `rust-lang/rust` as JSON.
2. **Orchestrator:** one **independent Codex session per issue** (not one session told to handle all variants).
3. **Goal mode prompt (small):** find a security issue with the **same risk class** as the original; give a **one-sentence** risk description, **not** full root cause + backtrace—so the model retains freedom to explore.
4. **Security gate (before hunt):** is the source issue even a real vulnerability? Route to `skip` / `no_variant` / `bug_found` to focus impact.
5. **Two-pass false-positive gauntlet:**
   - Judge 1: genuine security risk?
   - Judge 2 (different model): PoC-oriented; must matter under Rust threat model.
   - Only dual agreement → “validated finding”.
6. **Human filter:** duplicate check against GitHub backlog; only confirmed, novel bugs drafted for upstream.

Figure of merit in the post: Rust maintainers assumed a team of engineers; it was one engineer fluent with `/goal` orchestration.

---

## Where human judgment is still required

`/goal` amplifies work:

- Can stand up security infrastructure in under a day that would take a researcher weeks.
- Can scour large codebases faster than a human.

But it **faithfully pursues whatever outcome you define**—the run is largely decided **before** the model starts. Experts still must:

1. Know **where to look** (threat model, surface prioritization, issue triage).
2. Verify results are **reportable** findings (not toy issues).
3. Know what **maintainers accept** as a valid vulnerability disclosure.

Prompt engineering matters, but only if you already know **exactly what “done” means**.

---

## Practical checklist (extracted)

- [ ] Prefer model-drafted goals + self red-team of the goal text.
- [ ] Outcome-heavy, path-light prompts.
- [ ] Always attach or reference a threat model.
- [ ] Explicit non-goals / invalid preconditions.
- [ ] Persistence language when “clean scan” is not an acceptable terminal state.
- [ ] One primary outcome per agent/session; fan out surfaces or seed issues.
- [ ] Duplicate checks and multi-judge validation before claiming a finding.
- [ ] Optional tooling to verify the agent actually read what it claims (e.g. aicov).

---

## Relation to Vulseek research pipeline (local note)

Not part of the original article; recorded for product comparison:

| ToB `/goal` practice | Rough analogue in research scan |
|----------------------|----------------------------------|
| Single clear success condition | Scope / success criteria / `successTarget` |
| One agent, one outcome | Track fan-out; per-track discovery |
| `THREAT_MODEL.md` defines valid bugs | Surface map + attacker model + review gates |
| Don’t prescribe path | Agent + skills choose means |
| Persistence / multi-round | Review loops, primitive-gap → track-plan |
| Dual-judge FP filter | Finding-validation + finding-review; chain-review |
| Orchestrator per seed issue | Pipeline DAG + registry state |

Useful tensions to keep in mind when improving Vulseek:

- Over-specifying *how* stages work can kill the open-ended value ToB attributes to `/goal`.
- Competing metrics in one stage (e.g. “coverage + bugs” or “many tracks + deep unique findings”) recreate their multi-objective failure mode.
- “Exactly one high-quality outcome” vs “maximize list length” is a deliberate product tradeoff they resolved toward **quality and stop conditions**.

---

## Related ToB posts

- Introducing Patch the Planet: https://blog.trailofbits.com/2026/06/22/introducing-patch-the-planet/
- Field reports (zlib / GPT-5.5-Cyber): https://blog.trailofbits.com/2026/07/02/field-reports-from-patch-the-planet/
- aicov: https://github.com/trailofbits/aicov
