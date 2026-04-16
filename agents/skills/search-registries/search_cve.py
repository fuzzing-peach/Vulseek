#!/usr/bin/env python3
"""
CVE Search Tool - Search CVE.org, NVD, MITRE, and GitHub Advisory databases.

Usage:
    python3 search_cve.py --keyword <keyword> [--source cveorg|nvd|mitre|github|all]
    python3 search_cve.py --cve <CVE-ID>
    python3 search_cve.py --product <product> [--version <version>]
"""

import argparse
import json
import sys
import urllib.request
import urllib.parse
import urllib.error
from datetime import datetime

NVD_API_BASE = "https://services.nvd.nist.gov/rest/json/cves/2.0"
MITRE_API_BASE = "https://cveawg.mitre.org/api/cve"
GITHUB_ADVISORY_API = "https://api.github.com/advisories"
GITHUB_HEADERS = {"Accept": "application/vnd.github+json"}
CVE_ORG_API = "https://www.cve.org/restapiv1/search"
CVE_ORG_HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "Origin": "https://www.cve.org",
    "Referer": "https://www.cve.org/",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0"
}

def search_cve_org_keyword(keyword, recent=None):
    """Search CVE.org for CVEs matching a keyword (primary source).

    Args:
        keyword: Search term
        recent: If set, only return CVEs published within this many months
    """
    try:
        from datetime import datetime, timedelta, timezone
        post_data = {
            "query": keyword,
            "from": 0,
            "size": 200,
            "sort": {"property": "cveId", "order": "desc"}
        }

        req = urllib.request.Request(
            CVE_ORG_API,
            data=json.dumps(post_data).encode(),
            headers=CVE_ORG_HEADERS
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode())

        results = []
        cutoff_date = None
        if recent:
            cutoff_date = datetime.now(timezone.utc) - timedelta(days=recent * 30)

        for item in data.get("data", []):
            source = item.get("_source", {})
            cve_meta = source.get("cveMetadata", {})
            cve_id = cve_meta.get("cveId", "")
            if not cve_id or not cve_id.startswith("CVE-"):
                continue

            date_str = cve_meta.get("datePublished", "")[:10]
            if cutoff_date and date_str:
                item_date = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
                if item_date < cutoff_date:
                    continue

            containers = source.get("containers", {}).get("cna", {})
            desc = next((d.get("value", "") for d in containers.get("descriptions", []) if d.get("lang") == "en"), "")

            metrics = containers.get("metrics", [])
            cvss_score = "N/A"
            cvss_vector = "N/A"
            for m in metrics:
                if m.get("cvssV4_0"):
                    cvss_score = m["cvssV4_0"].get("baseScore", "N/A")
                    cvss_vector = m["cvssV4_0"].get("vectorString", "N/A")
                    break
                elif m.get("cvssV3_1"):
                    cvss_score = m["cvssV3_1"].get("baseScore", "N/A")
                    cvss_vector = m["cvssV3_1"].get("vectorString", "N/A")
                    break

            results.append({
                "id": cve_id,
                "description": desc[:200],
                "cvss_score": cvss_score,
                "cvss_vector": cvss_vector,
                "source": "CVE.org",
                "published": date_str
            })

        return results
    except Exception as e:
        return [{"error": f"CVE.org search failed: {str(e)}"}]

def search_nvd_keyword(keyword, source="all", recent=None):
    """Search NVD for CVEs matching a keyword.

    Args:
        keyword: Search term
        source: Data source (unused, kept for compatibility)
        recent: If set, only return CVEs published within this many months
    """
    params = {
        "keywordSearch": keyword,
        "resultsPerPage": 50
    }

    if recent:
        from datetime import datetime, timedelta, timezone
        end_date = datetime.now(timezone.utc)
        start_date = end_date - timedelta(days=recent * 30)
        params["pubStartDate"] = start_date.strftime("%Y-%m-%dT%H:%M:%S.000")
        params["pubEndDate"] = end_date.strftime("%Y-%m-%dT%H:%M:%S.000")

    params_encoded = urllib.parse.urlencode(params)
    url = f"{NVD_API_BASE}?{params_encoded}"

    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode())

        results = []
        for item in data.get("vulnerabilities", []):
            cve = item.get("cve", {})
            cve_id = cve.get("id", "N/A")
            desc = cve.get("descriptions", [{}])
            english_desc = next((d["value"] for d in desc if d.get("lang") == "en"), "")
            metrics = cve.get("metrics", {})

            # Extract CVSS score
            cvss_v3 = metrics.get("cvssMetricV31", [{}]) or metrics.get("cvssMetricV30", [])
            cvss_v2 = metrics.get("cvssMetricV2", [])
            cvss_score = "N/A"
            if cvss_v3 and isinstance(cvss_v3, list):
                cvss_score = cvss_v3[0].get("cvssData", {}).get("baseScore", "N/A")

            results.append({
                "id": cve_id,
                "description": english_desc[:200],
                "cvss_score": cvss_score,
                "source": "NVD"
            })
        return results
    except Exception as e:
        return [{"error": f"NVD search failed: {str(e)}"}]

def search_github_advisory(keyword, recent=None):
    """Search GitHub Advisory Database for CVEs matching a keyword."""
    try:
        params = urllib.parse.urlencode({
            "affects": keyword,
            "type": "reviewed",
            "per_page": 50
        })
        url = f"{GITHUB_ADVISORY_API}?{params}"
        req = urllib.request.Request(url, headers=GITHUB_HEADERS)
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode())

        results = []
        for item in data:
            cve_id = item.get("cve_id", "")
            if not cve_id:
                ghsa_id = item.get("ghsa_id", "")
                cve_id = ghsa_id
            severity = item.get("severity", "N/A")
            cvss_score = "N/A"
            if item.get("cvss"):
                cvss_score = item["cvss"].get("score", "N/A")
            results.append({
                "id": cve_id,
                "description": item.get("description", "")[:200],
                "cvss_score": cvss_score,
                "source": "GitHub",
                "severity": severity
            })
        return results
    except Exception as e:
        return [{"error": f"GitHub Advisory search failed: {str(e)}"}]

def search_nvd_cve(cve_id):
    """Get detailed info for a specific CVE from NVD."""
    params = urllib.parse.urlencode({"cveId": cve_id})
    url = f"{NVD_API_BASE}?{params}"

    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode())

        items = data.get("vulnerabilities", [])
        if not items:
            return {"error": f"CVE {cve_id} not found in NVD"}

        cve = items[0].get("cve", {})
        return format_cve_detail(cve, "NVD")
    except Exception as e:
        return {"error": f"NVD lookup failed: {str(e)}"}

def search_mitre_cve(cve_id):
    """Get CVE details from MITRE API."""
    url = f"{MITRE_API_BASE}/{cve_id}"

    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode())
        return format_cve_detail(data, "MITRE")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return {"error": f"CVE {cve_id} not found in MITRE"}
        return {"error": f"MITRE API error: {str(e)}"}
    except Exception as e:
        return {"error": f"MITRE lookup failed: {str(e)}"}

def format_cve_detail(cve, source):
    """Format CVE data into a consistent structure."""
    cve_id = cve.get("id", "N/A")
    descriptions = cve.get("descriptions", [])
    desc = next((d["value"] for d in descriptions if d.get("lang") == "en"), "")

    metrics = cve.get("metrics", {})
    cvss_v3 = metrics.get("cvssMetricV31", []) or metrics.get("cvssMetricV30", [])
    cvss_score = "N/A"
    cvss_vector = "N/A"
    if cvss_v3:
        cvss_data = cvss_v3[0].get("cvssData", {})
        cvss_score = cvss_data.get("baseScore", "N/A")
        cvss_vector = cvss_data.get("vectorString", "N/A")

    # Extract CWE
    weaknesses = cve.get("weaknesses", [])
    cwe_ids = []
    for w in weaknesses:
        for d in w.get("description", []):
            if d.get("type") == "CWE":
                cwe_ids.append(d.get("value", ""))

    # Extract references
    references = cve.get("references", [])
    ref_urls = [r.get("url", "") for r in references[:5]]

    # CPE info
    configurations = cve.get("configurations", [])
    affected = []
    for config in configurations:
        for node in config.get("nodes", []):
            for cpe in node.get("cpeMatch", []):
                if cpe.get("vulnerable", False):
                    affected.append(cpe.get("criteria", ""))

    return {
        "id": cve_id,
        "description": desc,
        "cvss_score": cvss_score,
        "cvss_vector": cvss_vector,
        "cwe": cwe_ids[0] if cwe_ids else "N/A",
        "source": source,
        "affected_products": affected[:10],
        "references": ref_urls,
        "published": cve.get("published", "N/A"),
        "last_modified": cve.get("lastModified", "N/A")
    }

def search_product(product, version=None, recent=None):
    """Search for CVEs affecting a specific product."""
    keyword = product
    if version:
        keyword = f"{product} {version}"

    cveorg_results = search_cve_org_keyword(keyword, recent=recent)
    nvd_results = search_nvd_keyword(keyword, recent=recent)
    gh_results = search_github_advisory(keyword, recent=recent)

    # Merge and deduplicate by CVE ID
    seen = set()
    merged = []
    for r in cveorg_results + nvd_results + gh_results:
        cve_id = r.get("id", "")
        if cve_id and cve_id not in seen:
            seen.add(cve_id)
            merged.append(r)
    return merged

def print_results(results, verbose=False):
    """Print search results in a formatted way."""
    if not results:
        print("No results found.")
        return

    if isinstance(results, dict) and "error" in results:
        print(f"Error: {results['error']}")
        return

    if isinstance(results, dict):
        # Single CVE detail
        print(f"\n{'='*60}")
        print(f"CVE ID: {results.get('id', 'N/A')}")
        print(f"Source: {results.get('source', 'N/A')}")
        print(f"CVSS Score: {results.get('cvss_score', 'N/A')}")
        if results.get('cvss_vector'):
            print(f"CVSS Vector: {results['cvss_vector']}")
        print(f"CWE: {results.get('cwe', 'N/A')}")
        print(f"\nPublished: {results.get('published', 'N/A')}")
        print(f"Last Modified: {results.get('last_modified', 'N/A')}")
        print(f"\nDescription:")
        print(f"  {results.get('description', 'N/A')}")

        if results.get('affected_products'):
            print(f"\nAffected Products:")
            for p in results['affected_products'][:5]:
                print(f"  - {p}")

        if results.get('references'):
            print(f"\nReferences:")
            for ref in results['references']:
                print(f"  - {ref}")
        print(f"{'='*60}\n")
    else:
        # List of results
        print(f"\nFound {len(results)} results:\n")
        for r in results:
            if "error" in r:
                print(f"Error: {r['error']}")
                continue
            print(f"[{r.get('source')}] {r.get('id')} - CVSS: {r.get('cvss_score', 'N/A')}")
            print(f"  {r.get('description', '')[:150]}...")
            print()

def main():
    parser = argparse.ArgumentParser(
        description="CVE Search Tool - Search NVD, MITRE, and GitHub Advisory databases"
    )
    parser.add_argument("--keyword", "-k", help="Search by keyword")
    parser.add_argument("--cve", "-c", help="Get details for specific CVE ID (e.g., CVE-2021-44228)")
    parser.add_argument("--product", "-p", help="Search by product name")
    parser.add_argument("--version", "-v", help="Specific version (used with --product)")
    parser.add_argument("--recent", "-r", type=int, metavar="MONTHS",
                        help="Only return CVEs published within the last N months (default: all time)")
    parser.add_argument("--source", "-s", choices=["nvd", "mitre", "github", "cveorg", "all"], default="all",
                        help="Data source (default: all)")
    parser.add_argument("--json", "-j", action="store_true", help="Output as JSON")

    args = parser.parse_args()

    if args.cve:
        # Single CVE lookup - try CVE.org first, then MITRE, then NVD
        if args.source in ["cveorg", "all"]:
            cveorg_result = search_cve_org_keyword(args.cve)
            # Filter to exact CVE ID match
            exact_match = [r for r in cveorg_result if r.get("id", "") == args.cve] if cveorg_result else []
            if exact_match:
                results = exact_match[0]
            elif args.source == "cveorg":
                results = {"error": f"CVE {args.cve} not found in CVE.org"}
            else:
                # Fall back to MITRE
                results = search_mitre_cve(args.cve)
                if "error" in results and args.source == "all":
                    results = search_nvd_cve(args.cve)
        else:
            results = search_mitre_cve(args.cve)
            if "error" in results and args.source == "all":
                results = search_nvd_cve(args.cve)
    elif args.product:
        results = search_product(args.product, args.version, recent=args.recent)
    elif args.keyword:
        if args.source == "github":
            results = search_github_advisory(args.keyword, recent=args.recent)
        elif args.source == "nvd":
            results = search_nvd_keyword(args.keyword, recent=args.recent)
        elif args.source == "cveorg":
            results = search_cve_org_keyword(args.keyword, recent=args.recent)
        else:  # all - use CVE.org first, then supplement with NVD and GitHub
            cveorg_results = search_cve_org_keyword(args.keyword, recent=args.recent)
            if cveorg_results and not any("error" in r for r in cveorg_results) and len(cveorg_results) > 0:
                results = cveorg_results
            else:
                # CVE.org failed or empty, fall back to NVD and GitHub
                nvd_results = search_nvd_keyword(args.keyword, recent=args.recent)
                gh_results = search_github_advisory(args.keyword, recent=args.recent)
                seen = set()
                merged = []
                for r in nvd_results + gh_results:
                    cve_id = r.get("id", "")
                    if cve_id and cve_id not in seen:
                        seen.add(cve_id)
                        merged.append(r)
                results = merged
    else:
        parser.print_help()
        sys.exit(1)

    if args.json:
        print(json.dumps(results, indent=2))
    else:
        print_results(results)

if __name__ == "__main__":
    main()
