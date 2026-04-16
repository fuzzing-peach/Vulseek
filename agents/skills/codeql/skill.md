# codeql skill

CodeQL integration for static analysis and vulnerability finding.

## Prerequisites

Generate compile_commands.json first (see compile-commands skill).

## Create Database

```bash
mkdir -p .vulseek/analysis/codeql
codeql database create .vulseek/analysis/codeql/<db-name> \
  --source-root <source-dir> \
  --language cpp \
  --threads 4
```

Example:

```bash
codeql database create .vulseek/analysis/codeql/<project>-db \
  --source-root <source-dir> \
  --language cpp \
  --threads 4
```

## Analyze with query packs

```bash
mkdir -p .vulseek/analysis/codeql
codeql database analyze .vulseek/analysis/codeql/<db-name> \
  --format=sarif-latest \
  --output=.vulseek/analysis/codeql/results.sarif \
  codeql/cpp-queries
```

## Custom queries with codeql query run

Custom queries require a qlpack directory:

```bash
mkdir -p /tmp/my-query
cd /tmp/my-query

# Create qlpack.yml
cat > qlpack.yml << 'EOF'
name: my-query
version: 0.0.0
dependencies:
  codeql/cpp-all: ~0.9.0
EOF

# Write your .ql file
cat > my-query.ql << 'EOF'
/**
 * Find all calls to InitSuites
 */
import cpp

from FunctionCall c
where c.getTarget().getName() = "InitSuites"
select
  c.getLocation().getFile().getRelativePath(),
  c.getLocation().getStartLine()
EOF

# Run
codeql query run -d <database> my-query.ql
```

## Query API reference

### Import

```ql
import cpp
```

### Common predicates

| Predicate | Description |
|-----------|-------------|
| `c.getTarget().getName()` | Get function name from a call |
| `c.getLocation().getFile().getRelativePath()` | File path of call site |
| `c.getLocation().getStartLine()` | Line number of call site |
| `c.getAnArgument()` | Get arguments passed to call |
| `f.getQualifiedName()` | Fully qualified function name |

### Common types

| Type | Description |
|------|-------------|
| `FunctionCall` | A function call expression |
| `Function` | A function declaration |
| `File` | A source file |
| `Location` | A code location |

## Common Issues

### import cpp fails

Usually means the query pack version doesn't match the database. Use `codeql database analyze` instead, which handles this automatically.

### getCaller() not resolved

This predicate doesn't exist in the standard library. There is no direct way to get the enclosing function from a `FunctionCall`. Consider using `FunctionCall.getLocation()` and cross-referencing with function source ranges.

### No query packs found

Download packs first:

```bash
codeql pack download codeql/cpp-queries
```

### Version mismatch between CLI and packs

CodeQL CLI and query packs have independent versioning. This is normal — the `cliVersion` field in qlpack.yml is informational only. Use `codeql database analyze` for reliable analysis; it works across versions.
