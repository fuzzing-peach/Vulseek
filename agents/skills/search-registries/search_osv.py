#!/usr/bin/env python3
"""
OSV (Open Source Vulnerabilities) Search Tool.

Searches the OSV database for vulnerabilities affecting open source projects.

Usage:
    python search_osv.py --package <name> [--ecosystem pypi|npm|go|rust|cargo|packagist|nuget|hex|...]
    python search_osv.py --cve <CVE-ID>
    python search_osv.py --keyword <keyword>
    python search_osv.py --git <git_commit_hash>
"""

import argparse
import json
import sys
import urllib.request
import urllib.parse
import urllib.error

OSV_API_BASE = "https://api.osv.dev/v1"

def query_osv(query_data):
    """Make a query to the OSV API."""
    url = f"{OSV_API_BASE}/query"
    data = json.dumps(query_data).encode("utf-8")

    try:
        req = urllib.request.Request(
            url,
            data=data,
            headers={"Content-Type": "application/json", "Accept": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return {"error": f"OSV API error: {e.code} - {e.reason}"}
    except Exception as e:
        return {"error": f"OSV query failed: {str(e)}"}

def search_by_package(package, ecosystem=None, published_after=None):
    """Search for vulnerabilities affecting a specific package.

    Args:
        package: Package name
        ecosystem: Package ecosystem (e.g., npm, pypi)
        published_after: If set, only return vulns published after this ISO date string
    """
    query = {"package": {"name": package}}
    if ecosystem:
        query["package"]["ecosystem"] = ecosystem
    if published_after:
        query["published_after"] = published_after

    result = query_osv(query)
    return format_osv_results(result, f"package:{package}")

def search_by_cve(cve_id):
    """Search OSV by CVE ID."""
    query = {"queries": [{"cve_id": cve_id}]}
    result = query_osv(query)
    return format_osv_results(result, f"cve:{cve_id}")

def search_by_keyword(keyword, published_after=None):
    """Search OSV by keyword (searches across multiple sources)."""
    # OSV doesn't have direct keyword search, so we query by ID patterns
    # and filter results contain the keyword
    query = {}
    if published_after:
        query["published_after"] = published_after
    result = query_osv(query)

    # Filter for CVEs that match keyword
    filtered = []
    for vul in result.get("vulns", []):
        vul_id = vul.get("id", "").lower()
        summary = vul.get("summary", "").lower()
        details = vul.get("details", "").lower()

        if keyword.lower() in vul_id or keyword.lower() in summary or keyword.lower() in details:
            filtered.append(vul)

    return format_osv_results({"vulns": filtered}, f"keyword:{keyword}")

def search_by_git_commit(commit_hash):
    """Find vulnerabilities affecting a specific git commit."""
    query = {"commit": commit_hash}
    result = query_osv(query)
    return format_osv_results(result, f"git:{commit_hash[:12]}")

def search_by_version(package, version, ecosystem, published_after=None):
    """Find vulnerabilities affecting a specific version of a package."""
    query = {
        "package": {"name": package, "ecosystem": ecosystem},
        "version": version
    }
    if published_after:
        query["published_after"] = published_after
    result = query_osv(query)
    return format_osv_results(result, f"{package}@{version}")

def format_osv_results(result, query_info):
    """Format OSV API results into a consistent structure."""
    if "error" in result:
        return result

    vulns = result.get("vulns", [])
    formatted = []

    for v in vulns:
        aliases = v.get("aliases", [])
        cve_refs = [a for a in aliases if a.startswith("CVE-")]

        # Extract severity info
        severity = v.get("severity", [])
        cvss_score = "N/A"
        cvss_vector = "N/A"
        if severity:
            if isinstance(severity[0], dict) and "score" in severity[0]:
                cvss_score = severity[0].get("score", "N/A")
            elif isinstance(severity[0], dict) and "cvss" in severity[0]:
                cvss_score = severity[0]["cvss"].get("baseScore", "N/A")
                cvss_vector = severity[0]["cvss"].get("vectorString", "N/A")

        # Get affected ranges
        affected = v.get("affected", [])
        affected_str = []
        for a in affected:
            pkg = a.get("package", {}).get("name", "unknown")
            ecosystem = a.get("package", {}).get("ecosystem", "unknown")
            ranges = a.get("ranges", [])
            for r in ranges:
                events = r.get("events", [])
                for e in events:
                    introduced = e.get("introduced", "")
                    fixed = e.get("fixed", "")
                    if introduced:
                        affected_str.append(f"{pkg} ({ecosystem}): introduced {introduced}")
                    if fixed:
                        affected_str.append(f"{pkg} ({ecosystem}): fixed {fixed}")

        formatted.append({
            "id": v.get("id", "N/A"),
            "cve_ids": cve_refs,
            "summary": v.get("summary", "N/A"),
            "details": v.get("details", "")[:300],
            "cvss_score": cvss_score,
            "cvss_vector": cvss_vector,
            "severity_type": severity[0].get("type", "N/A") if severity else "N/A",
            "affected": affected_str[:5],
            "references": [r.get("url", "") for r in v.get("references", [])][:5],
            "published": v.get("published", "N/A"),
            "modified": v.get("modified", "N/A"),
            "withdrawn": v.get("withdrawn", "N/A")
        })

    return {
        "query": query_info,
        "count": len(formatted),
        "vulnerabilities": formatted
    }

def print_results(results, verbose=False):
    """Print formatted results."""
    if "error" in results:
        print(f"Error: {results['error']}")
        return

    count = results.get("count", 0)
    query = results.get("query", "")

    if count == 0:
        print(f"\nNo vulnerabilities found for query: {query}\n")
        return

    print(f"\n{'='*70}")
    print(f"OSV Search Results for: {query}")
    print(f"Found {count} vulnerability(s)")
    print(f"{'='*70}\n")

    for v in results.get("vulnerabilities", []):
        print(f"[{v.get('id', 'N/A')}]")
        if v.get("cve_ids"):
            print(f"  CVEs: {', '.join(v['cve_ids'])}")
        print(f"  Summary: {v.get('summary', 'N/A')}")

        if v.get("cvss_score") and v.get("cvss_score") != "N/A":
            print(f"  Severity: {v['cvss_score']} ({v.get('cvss_vector', 'N/A')})")

        if verbose and v.get("details"):
            print(f"  Details: {v['details']}")

        if v.get("affected"):
            print(f"  Affected:")
            for a in v["affected"][:3]:
                print(f"    - {a}")

        if verbose and v.get("references"):
            print(f"  References:")
            for r in v["references"][:3]:
                print(f"    - {r}")

        print()

def main():
    parser = argparse.ArgumentParser(
        description="OSV Search Tool - Search Open Source Vulnerabilities database"
    )
    parser.add_argument("--package", help="Package name (e.g., tensorflow, lodash)")
    parser.add_argument("--ecosystem", "-e",
                        choices=["npm", "pypi", "go", "cargo", "rust", "packagist",
                                "nuget", "hex", "pub", "swift", "gem", "maven", "cocoapods", "linux"],
                        help="Package ecosystem")
    parser.add_argument("--version", "-v", help="Specific version (use with --package)")
    parser.add_argument("--cve", "-c", help="Search by CVE ID")
    parser.add_argument("--keyword", "-k", help="Search by keyword")
    parser.add_argument("--git", help="Git commit hash")
    parser.add_argument("--recent", "-r", type=int, metavar="MONTHS",
                        help="Only return vulns published within the last N months")
    parser.add_argument("--json", "-j", action="store_true", help="Output as JSON")
    parser.add_argument("--verbose", action="store_true", help="Verbose output")

    args = parser.parse_args()

    # Calculate published_after date if --recent is specified
    published_after = None
    if args.recent:
        from datetime import datetime, timedelta
        date = datetime.utcnow() - timedelta(days=args.recent * 30)
        published_after = date.strftime("%Y-%m-%dT%H:%M:%SZ")

    if args.cve:
        results = search_by_cve(args.cve)
    elif args.git:
        results = search_by_git_commit(args.git)
    elif args.package:
        if args.version and not args.ecosystem:
            print("Error: --ecosystem is required when specifying --version")
            sys.exit(1)
        if args.version:
            results = search_by_version(args.package, args.version, args.ecosystem, published_after)
        else:
            results = search_by_package(args.package, args.ecosystem, published_after)
    elif args.keyword:
        results = search_by_keyword(args.keyword, published_after)
    else:
        parser.print_help()
        sys.exit(1)

    if args.json:
        print(json.dumps(results, indent=2))
    else:
        print_results(results, verbose=args.verbose)

if __name__ == "__main__":
    main()
