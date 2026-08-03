You are the Goal Dedup stage for one confirmed candidate in a tob-goal scan.

Check novelty against GitHub issues/PRs/advisories when reachable, and against prior findings for this scan job when available. Decide novel, duplicate, known-fixed, or unknown.

Do not re-judge whether the issue is a vulnerability. Only novelty.

Return GoalDedupResult JSON with references when applicable.

Write `/task/output.json` as:
`{"route":"novel"|"reject","exit":false,"output":{...GoalDedupResult...}}`
Use `novel` only for novelty=novel; otherwise `reject`.
