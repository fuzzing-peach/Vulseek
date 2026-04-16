# full-scan skill

Scan the entire codebase for potential vulnerability locations using pattern matching. Build a tasklist of candidates for the Analysis Agent to investigate with static analysis and fuzzing.

Unlike `delta-scan` (which is targeted and change-aware), `full-scan` is a broad sweep with no specific CVE or diff as a starting point. Use it for first-time audits, or to complement delta-scan with untargeted discovery.

---

## When to Use

- First-time audit of a codebase with no prior recon data
- Systematic sweep to find locations that delta-scan would not reach (no recent CVE, no recent PR)
- To complement `delta-scan` after targeted hunting is complete

---

## Prerequisites

- C/C++ source code available
- `semgrep` installed and working (`semgrep --version`)
- `recon` skill already run: `.vulseek/recon/recon_report.txt` exists (used for scoring; full-scan still works without it but scoring accuracy degrades)

---

## Step 1 — Semgrep Pattern Sweep

Create the output directory:

```bash
mkdir -p .vulseek/full-scan
```

Run all built-in vulnerability rules:

```bash
semgrep scan \
  --config skills/semgrep/rules/ \
  --lang c --lang cpp \
  --json \
  . > .vulseek/full-scan/semgrep_results.json
```

If project-specific rules exist from a prior `recon` or `delta-scan` run, include them:

```bash
semgrep scan \
  --config skills/semgrep/rules/ \
  --config .vulseek/semgrep/ \
  --lang c --lang cpp \
  --json \
  . > .vulseek/full-scan/semgrep_results.json
```

Rule categories and what each finds:

| Rule file | Bug class | Severity |
|-----------|-----------|----------|
| `entry-points.yaml` | `main()`, `recv`, `fread`, `fgets`, `getenv` — untrusted input sources | INFO |
| `dangerous-functions.yaml` | `strcpy`, `strcat`, `gets`, `sprintf`, variable-length `memcpy`/`memmove` | WARNING/ERROR |
| `format-string.yaml` | CWE-134: `printf`/`fprintf`/`syslog` with non-literal format argument | WARNING/ERROR |
| `memory-safety.yaml` | `malloc` without NULL check, `realloc` pointer overwrite, `malloc(user_len)` | WARNING/INFO |

---

## Step 2 — Supplemental grep Patterns

Capture vulnerability classes that semgrep rules do not cover:

```bash
# Integer sign confusion: signed variable used as size in memcpy/read
grep -rn --include="*.c" --include="*.cpp" \
  -E "(int|signed)\s+\w+\s*=.*len|memcpy\s*\(.*,\s*[a-z_]+->len\b" \
  . >> .vulseek/full-scan/grep_results.txt

# Allocation using a length field without an explicit upper-bound check
grep -rn --include="*.c" --include="*.cpp" \
  -E "malloc\s*\(\s*\w+->(len|size|length|count)\s*[+*]?" \
  . >> .vulseek/full-scan/grep_results.txt

# Integer arithmetic before allocation — potential overflow
grep -rn --include="*.c" --include="*.cpp" \
  -E "malloc\s*\(\s*\w+\s*[+*]\s*\w+" \
  . >> .vulseek/full-scan/grep_results.txt

# free() at end of line without nulling the pointer (UAF precursor)
grep -rn --include="*.c" --include="*.cpp" \
  -E "free\s*\(\s*\w+\s*\);" \
  . >> .vulseek/full-scan/grep_results.txt

# strncat/strncpy with arithmetic in the length argument (off-by-one)
grep -rn --include="*.c" --include="*.cpp" \
  -E "(strncat|strncpy)\s*\([^,]+,[^,]+,\s*\w+\s*-\s*" \
  . >> .vulseek/full-scan/grep_results.txt

# Return value of read()/recv() used as a signed size
grep -rn --include="*.c" --include="*.cpp" \
  -E "(ret|n|r|bytes)\s*=\s*(read|recv|fread)\s*\(.*\).*memcpy|memmove" \
  . >> .vulseek/full-scan/grep_results.txt
```

---

## Step 3 — Filter and Score Hits

Parse both output files and apply the following filter and scoring rules.

### Discard (never add to tasklist)

- Hits in `tests/`, `test/`, `examples/`, `doc/`, `docs/`, `fuzz/` directories
- Hits in vendored or frozen third-party directories (check `.gitmodules`, `third_party/`, `vendor/`, `external/`)
- Hits where the enclosing 10 lines already contain an explicit bounds check or a safe wrapper call (e.g., `snprintf`, `strlcpy`, size validation `if`)
- Duplicate hits: same `file:line` or same `file + enclosing function` already present

### Score each remaining hit (add scores; keep top N)

| Signal | Score |
|--------|-------|
| Hit is in a module flagged as **under-audited** in `recon_report.txt` | +3 |
| Hit's CWE class is **dominant** in the project's CVE history | +2 |
| Hit is in a function whose name contains `parse`, `decode`, `read`, `recv`, `input`, `process`, `unpack` | +2 |
| Hit involves a **user-controlled length or size** (e.g., `malloc(input->len)`) | +2 |
| Hit is in a file with **no existing fuzz harness** in the project | +1 |
| Hit is in a module with **low churn** (≤ 3 commits in the last 12 months) | +1 |
| Hit file was **modified in the last 6 months** (`git log --since`) | +1 |
| Hit has semgrep severity `ERROR` | +1 |

**Cap:** Keep the top **20 hits** by score (configurable via `FULL_SCAN_LIMIT`, default 20). Discard lower-scoring hits if total > cap.

---

## Step 4 — Build Tasklist

For each retained hit, add a task:

```bash
python skills/tasklist/tasklist.py -l full add \
  "<file_basename>-<enclosing_function>-<operation>" \
  --notes "full-scan: rule <rule_id_or_grep_pattern> | <file:line> | <vulnerability_type> | score <N> | <one-line description>"
```

**Naming convention:** `<file_basename>-<enclosing_function>-<operation>`

Examples:
- `ssl_sess-ParseTicket-memcpy`
- `xml-decode_attr-sprintf`
- `http-parse_header-strcat`
- `tls13-HandleKeyShare-malloc`

**Vulnerability type** is derived from the matching rule:
- `dangerous-functions.yaml` → `buffer-overflow`
- `format-string.yaml` → `format-string`
- `memory-safety.yaml` → `null-deref` or `heap-overflow`
- `grep: malloc+arithmetic` → `integer-overflow`
- `grep: free without null` → `use-after-free`
- `grep: signed-size` → `integer-sign-confusion`

Print a summary before finishing:

```
Full-Scan Summary
=================
Semgrep hits (raw):       N
grep hits (raw):          N
After dedup/filter:       N
After cap (top 20):       N
Added to tasklist:        N

Top candidates:
  #1  ssl_sess-ParseTicket-memcpy    src/ssl_sess.c:2759  score=8  [dangerous-functions]
  #2  xml-decode_attr-sprintf        src/xml.c:412        score=7  [format-string]
  ...
```

---

## Step 5 — Dispatch to Analysis Agent

**Agent prompt:** `.agents/skills/vulseek-agents/analyzer.md`

Maximum concurrency: **3 agents in parallel**. Use a slot counter: start a new agent only when fewer than 3 are running.

For each `pending` task, in order:

### 5.1 Mark as running

```bash
python .agents/skills/tasklist/tasklist.py -l full update <id> running
```

### 5.2 Compose the subagent prompt

Pass the following context block as the subagent's initial message:

```
Read .agents/skills/vulseek-agents/analyzer.md and follow its instructions.

Task:
  id:    <id>
  name:  <name>
  notes: <full notes field>

Context files (read if available):
  .vulseek/recon/recon_report.txt

Working directory: <absolute path to target repository>
```

### 5.3 Wait and replenish

Wait for the subagent to set the task status to `finished` (it does this as its final action via `tasklist.py -l full update <id> finished`). When a slot opens, immediately dispatch the next `pending` task.

### 5.4 Resume on interruption

On restart, check for tasks stuck in `running` status (agent crashed mid-run): reset them to `pending` and re-dispatch.

```bash
python .agents/skills/tasklist/tasklist.py -l full list --status running
# for each: reset to pending
python .agents/skills/tasklist/tasklist.py -l full update <id> pending
```

Continue until no tasks remain in `pending` or `running`.

---

## Step 6 — Report Results

After all tasks complete:

```
Full-Scan Results
=================
Total tasks:     N
CONFIRMED:       N  ← real vulnerabilities
NO_VULN:         N
NEEDS_REVIEW:    N

Confirmed findings:
  #<id> <name>  <file:line>  Reproducer: <path>
  ...
```

---

## Output Layout

```
<target>/
└── .vulseek/
    ├── full.json
    ├── full-scan/
    │   ├── semgrep_results.json   # raw semgrep JSON output
    │   ├── grep_results.txt       # raw grep output
    │   └── summary.txt            # scoring table + final results
    └── analysis/
        └── <id>-<name>/           # written by analysis agent
            └── report.md
```

---

## Notes

- If `.vulseek/full.json` already has entries for the same `file + function`, skip re-adding those locations. Append only new candidates.
- `FULL_SCAN_LIMIT` environment variable overrides the default cap of 20 tasks.
- For large codebases (> 500 KLOC), limit semgrep scan scope to core source directories: `semgrep scan --config ... src/ lib/`
- If CodeQL database exists at `.vulseek/analysis/codeql/`, run a reachability pre-filter before adding to tasklist: discard hits with no taint path from any entry point (reduces false-positive rate significantly).
