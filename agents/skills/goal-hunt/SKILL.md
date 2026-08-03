---
name: goal-hunt
description: Pursue one hunt goal to a single candidate or exhaustion for tob-goal scans.
---

# Goal Hunt

This stage runs under a **Codex native `/goal`** (thread-scoped objective in `thread_goals`). One goal, one outcome. Choose methods freely. Prefer evidence over speculation.

When done, write `/task/output.json` with route `candidate` or `exhausted`, and **validate it against `/task/output.schema.json` with Python `jsonschema` before ending the turn**. Do not invent alternate field names.