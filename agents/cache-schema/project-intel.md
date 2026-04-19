# Project Profile Cache Schema

This document defines project-scoped structured cache files that survive across scan jobs.

Base directory in shared scan context volume:

- `${VULSEEK_PROJECT_CACHE_DIR}` or, by default, `/scan-context/cache`

Files:

- `${VULSEEK_PROJECT_CACHE_DIR}/cve-cache.json`
- `${VULSEEK_PROJECT_CACHE_DIR}/pr-cache.json`

## Common rules

- These files are project-scoped, not scan-job-scoped.
- Agents must read them before making network requests.
- If a file is stale or incomplete, agents should fetch only the missing portion.
- New data must be merged back into the same file.
- Top-level `updatedAt` must be updated after a successful merge.
- Malformed files may be repaired by rewriting them into the normalized structure.

## CVE cache schema

```json
{
  "schemaVersion": 1,
  "kind": "cve-cache",
  "project": {
    "name": "wolfssl",
    "repository": "wolfSSL/wolfssl",
    "aliases": ["wolfssl", "wolfSSL"]
  },
  "updatedAt": "2026-04-18T00:00:00Z",
  "coverage": {
    "sources": ["nvd", "mitre", "osv"],
    "query": {
      "product": "wolfssl",
      "repository": "wolfSSL/wolfssl",
      "keywords": []
    },
    "from": null,
    "to": null,
    "notes": "all known project CVEs collected so far"
  },
  "items": [
    {
      "id": "CVE-2025-0001",
      "source": "nvd",
      "publishedAt": "2025-01-10T00:00:00Z",
      "modifiedAt": "2025-01-12T00:00:00Z",
      "summary": "short summary",
      "severity": {
        "score": 7.5,
        "vector": "CVSS:3.1/...",
        "cwe": ["CWE-787"]
      },
      "affected": {
        "product": "wolfssl",
        "versions": ["<=5.7.0"]
      },
      "references": [
        "https://nvd.nist.gov/vuln/detail/CVE-2025-0001"
      ],
      "tags": ["buffer-overflow", "tls", "parsing"],
      "notes": "local normalized notes"
    }
  ]
}
```

## PR cache schema

```json
{
  "schemaVersion": 1,
  "kind": "pr-cache",
  "project": {
    "name": "wolfssl",
    "repository": "wolfSSL/wolfssl",
    "host": "github"
  },
  "updatedAt": "2026-04-18T00:00:00Z",
  "coverage": {
    "states": ["open", "closed", "merged"],
    "baseBranches": ["master"],
    "from": null,
    "to": null,
    "notes": "recent and relevant historical PRs"
  },
  "items": [
    {
      "id": 1234,
      "number": 1234,
      "title": "Fix negative size handling in pem path",
      "state": "merged",
      "isMerged": true,
      "createdAt": "2026-01-01T00:00:00Z",
      "updatedAt": "2026-01-03T00:00:00Z",
      "mergedAt": "2026-01-03T00:00:00Z",
      "url": "https://github.com/wolfSSL/wolfssl/pull/1234",
      "author": "example",
      "baseRef": "master",
      "headRef": "fix/pem-neg-size",
      "labels": ["bug", "security"],
      "relatedCommits": ["abcdef123456"],
      "summary": "normalized short summary",
      "tags": ["pem", "input-validation", "bounds"],
      "notes": "local normalized notes"
    }
  ]
}
```

## Merge rules

- CVE cache: merge by `items[].id`
- PR cache: merge by `items[].id`, fallback to `items[].number`
- Prefer non-empty normalized fields over empty fields.
- Union arrays such as `references`, `tags`, `labels`, `relatedCommits`, and `severity.cwe`.
- Do not drop older valid records during refresh.
