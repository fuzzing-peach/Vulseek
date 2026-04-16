# semgrep skill

Static analysis tool for finding bugs and security vulnerabilities via pattern matching.

## Capabilities

- **Pattern-based scanning**: Search code using semgrep's grep-like syntax
- **Pre-built rules**: Use `--config auto` for community rules
- **Custom rules**: Write YAML rules to detect specific vulnerabilities
- **Multi-language support**: C, Python, JavaScript, Go, Rust, and more
- **CI/CD integration**: Run in automated pipelines

## Usage

### Basic Scanning

```bash
# Scan with all community rules
semgrep scan --config auto /path/to/code

# Scan with a specific rules directory or file
semgrep scan --config /path/to/rules.yaml /path/to/code

# Dry run (show what would be scanned without running)
semgrep scan --config auto /path/to/code --dryrun

# JSON output
semgrep scan --config auto /path/to/code --json
```

### Custom Rules (YAML)

Create rules in `.semgrep/rules/` directory:

```yaml
rules:
  - id: my-custom-rule
    pattern: 'if ($P != *str) return 0;'
    message: |
      Description of the finding.
      Include what the vulnerability is and how to fix it.
    languages:
      - c
    severity: WARNING
    metadata:
      cve: CVE-XXXX-XXXX
      product: myproduct
```

### Rule Pattern Syntax

| Pattern | Meaning |
|---------|---------|
| `if ($X != *str)` | Match dereference of str |
| `...` | Ellipsis matches any code |
| `$VAR` | Metavariable captures any expression |
| `"string"` | Match literal string |

**Note**: Semgrep C parser does NOT support `!=` in pattern expressions directly from CLI (`-e`). Use YAML files instead.

### Severity Levels

- `ERROR` — Critical findings
- `WARNING` — Medium/high severity
- `INFO` — Informational
- `INVENTORY` — List of items

### Scanning Examples

```bash
# Scan a specific file
semgrep scan --config .semgrep/rules/rule.yaml src/file.c

# Scan with multiple rule files
semgrep scan --config .semgrep/rules/ /path/to/code

# Show verbose output
semgrep scan --config auto /path/to/code --verbose

# Limit to specific language rules
semgrep scan --config auto --lang c /path/to/code
```

## Semgrep Rule Schema

```yaml
rules:
  - id: unique-rule-id
    pattern: 'code pattern to match'
    message: |
      What this finding means and how to fix it.
    languages:
      - c
      - python
    severity: WARNING
    metadata:
      cve: CVE-2024-5991
      references:
        - https://example.com/advisory
```

## Common Workflows

### Detect CVE Pattern

```bash
# Create rule for specific CVE
cat > .semgrep/rules/CVE-YYYY-XXXX.yaml << 'EOF'
rules:
  - id: CVE-YEAR-XXXX
    pattern: 'vulnerable code pattern'
    message: |
      Description of the vulnerability.
      Fix: suggested remediation.
    languages:
      - c
    severity: WARNING
    metadata:
      cve: CVE-YEAR-XXXX
EOF

# Run scan
semgrep scan --config .semgrep/rules/CVE-YEAR-XXXX.yaml /path/to/vulnerable/code
```

### Vulnerability Research

```bash
# Find all buffer operations without bounds checks
semgrep scan --config .semgrep/rules/ /path/to/code

# Search for dangerous functions
semgrep scan --config p/security-audit /path/to/code
```

## Recon Rules (Built-in)

Pre-written rules live in `skills/semgrep/rules/`. Use them during the recon **Pattern Hunt** step:

| File | What it finds | Severity |
|------|--------------|----------|
| `entry-points.yaml` | `main()`, `recv`, `fread`, `fgets`, `getenv` — where untrusted input enters | INFO |
| `dangerous-functions.yaml` | `strcpy`, `strcat`, `gets`, `sprintf`, `memcpy` with variable length | WARNING/ERROR |
| `format-string.yaml` | `printf`/`fprintf`/`syslog` with non-literal format string (CWE-134) | WARNING/ERROR |
| `memory-safety.yaml` | `malloc` without NULL check, `realloc` pointer overwrite, `malloc(user_len)` | WARNING/INFO |

### Run all recon rules at once

```bash
# From the target repository root
semgrep scan --config /path/to/vulseek/skills/semgrep/rules/ . --json \
  | python3 -c "
import json,sys
r=json.load(sys.stdin)
for f in r.get('results',[]):
    print(f\"{f['path']}:{f['start']['line']}  [{f['check_id']}]  {f['extra']['message'].splitlines()[0]}\")
"
```

### Run a single category

```bash
# Entry points only
semgrep scan --config skills/semgrep/rules/entry-points.yaml .

# Dangerous functions only
semgrep scan --config skills/semgrep/rules/dangerous-functions.yaml .

# Format string bugs only
semgrep scan --config skills/semgrep/rules/format-string.yaml .

# Memory safety only
semgrep scan --config skills/semgrep/rules/memory-safety.yaml .
```

### Scope: C/C++ only

These rules target C and C++ codebases. For other languages fall back to `semgrep --config p/security-audit`.

## Notes

- Semgrep requires semicolons in patterns for C code
- Pattern expressions cannot use `!=` directly in CLI `-e` flag
- Use YAML files for complex patterns with `!=`
- Community rules: `semgrep --config p/` (e.g., `p/security-audit`)
- Run `semgrep --help` for full command reference
- Run `semgrep --version` to verify installation
