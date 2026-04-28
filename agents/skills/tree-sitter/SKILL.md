name: tree-sitter
description: Use tree-sitter-based parsing to enumerate concrete function definitions from source files, currently optimized for C/C++. Use when module-level scanning needs a reliable function inventory before generating function scan tasks.
---

# Tree-Sitter

Use this skill when you need a concrete function inventory from source files before planning function-level scan tasks.

Current first-class support:

- C
- C++

## Extraction Method

Use tree-sitter directly through the tooling available in the environment.

Do not rely on the deprecated `extract_functions.py` helper.

You may use:

- tree-sitter bindings already installed in the image
- a small one-off parser script you write for the current run
- an equivalent tree-sitter-capable tool already present in the environment

Expected input:

- `file-list.txt`: newline-delimited absolute or repository-relative file paths

Expected output:

```json
{
  "functions": [
    {
      "functionId": "fn-...",
      "functionName": "foo",
      "filePath": "src/foo.c",
      "line": 10,
      "endLine": 30,
      "language": "c",
      "signature": "int foo(bar_t *x)"
    }
  ]
}
```

## Usage Rules

1. use tree-sitter extraction first
2. do not invent function lists manually when the extractor can run
3. if some files fail to parse, keep the successful results and note the failures
4. use the extracted functions as the base for `function_plan.json`
5. filtering and prioritization happen after extraction, not before

## Typical Workflow

1. obtain the module file list
2. run tree-sitter-based extraction over the module file list
3. inspect the resulting function inventory
4. remove clearly irrelevant functions if needed
5. write `function_plan.json`

## Non-Goals

This skill does not:

- emit `candidate` events
- prove vulnerabilities
- do semantic scoring by itself

It only provides reliable syntax-level function extraction.
