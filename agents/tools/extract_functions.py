#!/usr/bin/env python3
"""
Extract function definitions from source files using tree-sitter.

Current scope:
- C
- C++

Output schema:
{
  "functions": [
    {
      "functionId": "...",
      "functionName": "...",
      "filePath": "...",
      "line": 123,
      "endLine": 140,
      "language": "c",
      "signature": "int foo(bar_t *x)"
    }
  ]
}
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path
from typing import Iterable

from tree_sitter import Language, Parser

try:
    import tree_sitter_c as ts_c
except Exception:
    ts_c = None

try:
    import tree_sitter_cpp as ts_cpp
except Exception:
    ts_cpp = None


FUNCTION_NAME_RE = re.compile(r"([A-Za-z_~][A-Za-z0-9_:~]*)\s*\(")


def load_language(language_name: str) -> Language | None:
    if language_name == "c" and ts_c is not None:
        return Language(ts_c.language())
    if language_name == "cpp" and ts_cpp is not None:
        return Language(ts_cpp.language())
    return None


def detect_language(file_path: str) -> str | None:
    suffix = Path(file_path).suffix.lower()
    if suffix in {".c", ".h"}:
        return "c"
    if suffix in {".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"}:
        return "cpp"
    return None


def iter_source_files(file_list: Iterable[str]) -> Iterable[str]:
    for raw in file_list:
        value = raw.strip()
        if not value:
            continue
        if not os.path.isfile(value):
            continue
        yield value


def parser_for_language(language_name: str) -> Parser | None:
    language = load_language(language_name)
    if language is None:
        return None
    parser = Parser()
    parser.language = language
    return parser


def node_text(source: bytes, node) -> str:
    return source[node.start_byte : node.end_byte].decode("utf-8", errors="replace")


def extract_function_name(declarator_text: str) -> str:
    matches = FUNCTION_NAME_RE.findall(declarator_text)
    if not matches:
        return declarator_text.strip().splitlines()[0][:120]
    return matches[-1]


def stable_function_id(file_path: str, name: str, line: int) -> str:
    raw = f"{file_path}:{name}:{line}"
    digest = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]
    return f"fn-{digest}"


def collect_functions(file_path: str) -> list[dict]:
    language_name = detect_language(file_path)
    if language_name is None:
        return []

    parser = parser_for_language(language_name)
    if parser is None:
        return []

    source = Path(file_path).read_bytes()
    tree = parser.parse(source)
    results: list[dict] = []

    stack = [tree.root_node]
    while stack:
        node = stack.pop()
        if node.type == "function_definition":
            declarator = None
            for child in node.children:
                if "declarator" in child.type:
                    declarator = child
                    break
            declarator_text = node_text(source, declarator or node)
            function_name = extract_function_name(declarator_text)
            start_line = node.start_point[0] + 1
            end_line = node.end_point[0] + 1
            signature = declarator_text.strip().replace("\n", " ")
            results.append(
                {
                    "functionId": stable_function_id(file_path, function_name, start_line),
                    "functionName": function_name,
                    "filePath": file_path,
                    "line": start_line,
                    "endLine": end_line,
                    "language": language_name,
                    "signature": signature[:300],
                }
            )
            continue

        for child in reversed(node.children):
            stack.append(child)

    return results


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract functions using tree-sitter")
    parser.add_argument("--file-list", required=True, help="Path to newline-delimited file list")
    parser.add_argument("--out", required=True, help="Output JSON path")
    args = parser.parse_args()

    file_list_path = Path(args.file_list)
    if not file_list_path.is_file():
        print(f"file list not found: {file_list_path}", file=sys.stderr)
        return 1

    files = list(iter_source_files(file_list_path.read_text().splitlines()))
    functions: list[dict] = []
    for file_path in files:
        try:
            functions.extend(collect_functions(file_path))
        except Exception as exc:
            print(f"[warn] failed to parse {file_path}: {exc}", file=sys.stderr)

    output_path = Path(args.out)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps({"functions": functions}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
