# search-registries skill

Search and cross-reference CVE databases (NVD, MITRE, OSV) for known vulnerabilities.

## Capabilities

- **CVE Search**: Query NVD and MITRE for CVE records by ID, keyword, or product
- **OSV Search**: Query Open Source Vulnerabilities database by package, CVE ID, or git commit
- **Vulnerability Lookup**: Get detailed information including CVSS scores, CWE, affected products
- **Cross-Reference**: Link CVEs to their OSV entries and vice versa
- **PR Search**: Query historical GitHub pull requests for fixes, hardening, regressions, and related discussions
- **Recent First**: By default, searches prioritize recently published vulnerabilities


## Project-Scoped Cache

See also: `/root/.codex/skills/cache-schema/project-intel.md` for the normalized file layout and merge rules.


Before querying external registries, use the shared project/profile cache directory. The Python tools resolve it from `VULSEEK_PROJECT_CACHE_DIR`.

Cache files:

- `${VULSEEK_PROJECT_CACHE_DIR}/cve-cache.json`
- `${VULSEEK_PROJECT_CACHE_DIR}/pr-cache.json`

The Python tools handle cache reuse, staleness checks, refresh, merge, and `updatedAt` updates internally. Agents should treat cache management as an implementation detail of the tool.

Built-in defaults:

- CVE cache TTL: 7 days
- PR cache TTL: 1 day

Normalized cache requirements:

- CVE cache must be stored as structured JSON with top-level keys: `schemaVersion`, `kind`, `project`, `updatedAt`, `coverage`, `items`
- PR cache must be stored as structured JSON with top-level keys: `schemaVersion`, `kind`, `project`, `updatedAt`, `coverage`, `items`
- merge CVEs by `items[].id`
- merge PRs by `items[].id` or `items[].number`
- preserve useful existing fields and union arrays such as references, tags, labels, related commits, and CWE entries

When reporting findings, explicitly say whether the result came from:

- cache only
- cache plus refresh
- fresh fetch because cache was missing or unusable

Both tools support:

- `--cache-path`
- `--refresh`

## Data Sources

| Source | API | Strengths |
|--------|-----|-----------|
| NVD | `https://services.nvd.nist.gov/rest/json/cves/2.0` | CVSS scores, CPE data, comprehensive |
| MITRE | `https://cveawg.mitre.org/api/cve` | CVE details, references |
| OSV | `https://api.osv.dev/v1` | Open source focus, ecosystem-specific |

## Usage

### CVE Search (NVD/MITRE/CVE.org/GitHub Advisory)

```bash
# Search by CVE ID
python3 skills/search-registries/search_cve.py --cve CVE-2021-44228

# Search by keyword
python3 skills/search-registries/search_cve.py --keyword "log4j"
python3 skills/search-registries/search_cve.py --keyword "log4j" --recent 24

# Search by product
python3 skills/search-registries/search_cve.py --product nginx --version 1.18.0
python3 skills/search-registries/search_cve.py --product wolfssl --repository wolfSSL/wolfssl --project-name wolfssl

# Force refresh and merge the CVE cache
python3 skills/search-registries/search_cve.py --product wolfssl --repository wolfSSL/wolfssl --project-name wolfssl --refresh

# Output as JSON
python3 skills/search-registries/search_cve.py --keyword "heartbleed" --json
```

### OSV Search

```bash
# Search by package name
python3 skills/search-registries/search_osv.py --package tensorflow

# Search by package + ecosystem
python3 skills/search-registries/search_osv.py --package lodash --ecosystem npm

# Search by specific version
python3 skills/search-registries/search_osv.py --package django --ecosystem pypi --version 3.2.0

# Search by CVE ID
python3 skills/search-registries/search_osv.py --cve CVE-2021-44228

# Search by git commit hash
python3 skills/search-registries/search_osv.py --git abc123def456
```

### PR Search

```bash
# Search PRs in a repository by keyword
python3 skills/search-registries/search_prs.py --repository wolfSSL/wolfssl --query security

# Search only merged PRs
python3 skills/search-registries/search_prs.py --repository wolfSSL/wolfssl --query pem --state merged

# Limit to a base branch
python3 skills/search-registries/search_prs.py --repository wolfSSL/wolfssl --query tls --base-branch master

# Force refresh and merge the PR cache
python3 skills/search-registries/search_prs.py --repository wolfSSL/wolfssl --query security --refresh

# Output as JSON
python3 skills/search-registries/search_prs.py --repository wolfSSL/wolfssl --query cve --json
```

## Output Formats

### CVE Output

```text
{
  "cacheMode": "cache+refresh",
  "cachePath": "/scan-context/cache/cve-cache.json",
  "results": [
    {
      "id": "CVE-2026-5500",
      "description": "...",
      "cvss_score": 8.7,
      "cvss_vector": "CVSS:4.0/...",
      "source": "cveorg",
      "published": "2026-04-10"
    }
  ]
}
```

### PR Output

```text
{
  "count": 3,
  "pullRequests": [
    {
      "number": 10207,
      "title": "Add signed-length validation to d2i, PEM, and buffer-load APIs",
      "state": "open",
      "isMerged": false,
      "baseRef": "master",
      "url": "https://github.com/wolfSSL/wolfssl/pull/10207"
    }
  ],
  "cacheMode": "cache+refresh",
  "cachePath": "/scan-context/cache/pr-cache.json"
}
```

## Common Workflows

### Before Fuzzing: Check Known Vulnerabilities

```bash
python3 skills/search-registries/search_cve.py --product openssl --version 1.1.1 --recent 24
python3 skills/search-registries/search_cve.py --cve CVE-2014-0160
```

### Vulnerability Research: Find Similar Issues

```bash
python3 skills/search-registries/search_cve.py --keyword "buffer overflow" --source nvd --recent 12
python3 skills/search-registries/search_osv.py --keyword "prototype pollution" --recent 12
```

### Fix-History Research

```bash
python3 skills/search-registries/search_cve.py --product wolfssl --repository wolfSSL/wolfssl --project-name wolfssl
python3 skills/search-registries/search_prs.py --repository wolfSSL/wolfssl --query security
```

## Notes

- OSV API is faster and better for open source packages
- NVD provides more detailed CVSS and CPE information
- MITRE is the authoritative source for CVE metadata
- Rate limits apply: NVD ~50 requests/30s, OSV ~1000/minute
- For bulk queries, add delays between requests
- Use `--recent` to filter to recently published vulnerabilities (default: all time)
- Note: `--recent` filter uses the NVD publication date API; it may not work in all environments due to API rate limits or network restrictions
