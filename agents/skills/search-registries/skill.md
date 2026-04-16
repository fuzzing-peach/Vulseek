# search-registries skill

Search and cross-reference CVE databases (NVD, MITRE, OSV) for known vulnerabilities.

## Capabilities

- **CVE Search**: Query NVD and MITRE for CVE records by ID, keyword, or product
- **OSV Search**: Query Open Source Vulnerabilities database by package, CVE ID, or git commit
- **Vulnerability Lookup**: Get detailed information including CVSS scores, CWE, affected products
- **Cross-Reference**: Link CVEs to their OSV entries and vice versa
- **Recent First**: By default, searches prioritize recently published vulnerabilities

## Data Sources

| Source | API | Strengths |
|--------|-----|-----------|
| NVD | `https://services.nvd.nist.gov/rest/json/cves/2.0` | CVSS scores, CPE data, comprehensive |
| MITRE | `https://cveawg.mitre.org/api/cve` | CVE details, references |
| OSV | `https://api.osv.dev/v1` | Open source focus, ecosystem-specific |

## Usage

### CVE Search (NVD/MITRE)

```bash
# Search by CVE ID (most detailed)
python3 skills/search-registries/search_cve.py --cve CVE-2021-44228

# Search by keyword (default: all time, use --recent to limit)
python3 skills/search-registries/search_cve.py --keyword "log4j"
python3 skills/search-registries/search_cve.py --keyword "log4j" --recent 24  # last 2 years

# Search by product
python3 skills/search-registries/search_cve.py --product nginx --version 1.18.0
python3 skills/search-registries/search_cve.py --product nginx --recent 12  # last year

# Output as JSON
python3 skills/search-registries/search_cve.py --keyword "heartbleed" --json
```

### OSV Search

```bash
# Search by package name (without ecosystem = search all)
python3 skills/search-registries/search_osv.py --package tensorflow

# Search by package + ecosystem
python3 skills/search-registries/search_osv.py --package lodash --ecosystem npm

# Search by specific version
python3 skills/search-registries/search_osv.py --package django --ecosystem pypi --version 3.2.0

# Search by CVE ID
python3 skills/search-registries/search_osv.py --cve CVE-2021-44228

# Search by git commit hash
python3 skills/search-registries/search_osv.py --git abc123def456

# Verbose output with full details
python3 skills/search-registries/search_osv.py --cve CVE-2021-44228 --verbose

# Recent vulnerabilities only (last N months)
python3 skills/search-registries/search_osv.py --package lodash --ecosystem npm --recent 12
```

## Output Formats

### CVE Output
```
============================================================
CVE ID: CVE-2021-44228
Source: NVD
CVSS Score: 10.0
CVSS Vector: CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H
CWE: CWE-502

Published: 2021-12-10T10:15:00.000
Last Modified: 2021-12-10T10:15:00.000

Description:
  Log4j JNDI features used in configuration, log messages, ...

Affected Products:
  - cpe:2.3:a:apache:log4j:2.0:*:*:*:*:*:*:*
  ...

References:
  - https://nvd.nist.gov/vuln/detail/CVE-2021-44228
  ...
============================================================
```

### OSV Output
```
======================================================================
OSV Search Results for: package:lodash
Found 5 vulnerability(ies)
======================================================================

[CVE-2021-23337]
  CVEs: CVE-2021-23337
  Summary: Prototype Pollution in lodash
  Severity: 7.2 (CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:L/L:H)
  Affected:
    - lodash (npm): introduced *
    - lodash (npm): fixed 4.17.21
```

## Common Workflows

### Before Fuzzing: Check Known Vulnerabilities

```bash
# Check if target has known CVEs (recent only - last 24 months)
python3 skills/search-registries/search_cve.py --product openssl --version 1.1.1 --recent 24

# Check specific CVE
python3 skills/search-registries/search_cve.py --cve CVE-2014-0160
```

### Vulnerability Research: Find Similar Issues

```bash
# Find recent CVEs related to a keyword
python3 skills/search-registries/search_cve.py --keyword "buffer overflow" --source nvd --recent 12

# Cross-reference with OSV
python3 skills/search-registries/search_osv.py --keyword "prototype pollution" --recent 12
```

### Dependency Audit

```bash
# Check Python package (recent vulnerabilities)
python3 skills/search-registries/search_osv.py --package requests --ecosystem pypi --recent 12

# Check JavaScript package
python3 skills/search-registries/search_osv.py --package moment --ecosystem npm --recent 12
```

## Notes

- OSV API is faster and better for open source packages
- NVD provides more detailed CVSS and CPE information
- MITRE is the authoritative source for CVE metadata
- Rate limits apply: NVD ~50 requests/30s, OSV ~1000/minute
- For bulk queries, add delays between requests
- Use `--recent` to filter to recently published vulnerabilities (default: all time)
- Note: `--recent` filter uses the NVD publication date API; it may not work in all environments due to API rate limits or network restrictions
