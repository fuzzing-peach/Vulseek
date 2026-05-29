---
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

For C/C++, identify the function name from the `function_declarator` node by recursively following its `declarator` field until the real `identifier`, `field_identifier`, `qualified_identifier`, or `operator_name` for the function is reached.

Do not choose the last identifier in the declaration text. That often returns a parameter name such as `len`, `ctx`, `buf`, or `arg` instead of the function name.

Validate extraction quality before using the inventory:

- check at least 20 extracted functions from C/C++ files
- confirm function names appear in the signature before the opening parenthesis
- reject and fix the extractor if common parameter names dominate the output
- record parse failures and extractor limitations in the module notes

## Function Name Fallback

Treat function-name extraction as suspect when any of these checks fail:

- extracted names are common parameter or local-variable names, such as `len`, `buf`, `ctx`, `arg`, `ret`, `i`, `n`, or `size`
- many extracted names do not appear before the first `(` in their reported signature
- many extracted names are repeated across unrelated files with different signatures
- the reported line points inside a function body instead of at a function definition
- the signature text starts with a control statement such as `if`, `for`, `while`, or `switch`

If function-name extraction looks suspect:

1. Fix the tree-sitter extraction logic and rerun it once.
2. Run the extraction quality check again.
3. If the extractor is still suspect, manually read the affected source files and extract function names from the source definitions.

Manual extraction should use repository-local source only. Use small file slices around likely definitions, for example with `sed`, `awk`, or symbol-aware navigation, and identify the function name from the definition header immediately before the body `{`.

When manual fallback is used, include a short module note that says tree-sitter function-name extraction was suspect and that kept function names were confirmed from source text.

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
2. validate function-name quality before using the inventory
3. fix and rerun the extractor once when function names look wrong
4. manually read source definitions for affected files when the extractor remains suspect
5. if some files fail to parse, keep the successful results and note the failures
6. use the extracted or manually confirmed functions as the base for the module scanner's function list
7. filtering happens after extraction or manual confirmation, not before

## Typical Workflow

1. obtain the module file list
2. run tree-sitter-based extraction over the module file list
3. inspect the resulting function inventory
4. validate function-name quality by checking extracted names against source signatures
5. fix and rerun extraction, or manually confirm names from source text, if the sanity check fails
6. remove clearly irrelevant functions if needed
7. pass the filtered inventory back to the module scanner's structured result

## Non-Goals

This skill does not:

- emit `candidate` events
- prove vulnerabilities
- do semantic scoring by itself

It only provides reliable syntax-level function extraction.
