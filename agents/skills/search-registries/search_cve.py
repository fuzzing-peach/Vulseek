#!/usr/bin/env python3
"""
CVE Search Tool - Search CVE.org, NVD, MITRE, and GitHub Advisory databases.
Supports project/profile-scoped structured cache persisted under VULSEEK_PROJECT_CACHE_DIR.
"""

import argparse
import json
import os
import sys
import urllib.request
import urllib.parse
import urllib.error
from datetime import datetime

from cache_utils import (
    CVE_CACHE_PATH,
    build_empty_cve_cache,
    is_cache_stale,
    load_json_file,
    merge_items,
    normalize_cache_doc,
    utc_now_iso,
    write_json_file,
)

NVD_API_BASE = "https://services.nvd.nist.gov/rest/json/cves/2.0"
MITRE_API_BASE = "https://cveawg.mitre.org/api/cve"
GITHUB_ADVISORY_API = "https://api.github.com/advisories"
GITHUB_HEADERS = {"Accept": "application/vnd.github+json", "User-Agent": "vulseek-search-cve"}
CVE_ORG_API = "https://www.cve.org/restapiv1/search"
CVE_ORG_HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "Origin": "https://www.cve.org",
    "Referer": "https://www.cve.org/",
    "User-Agent": "Mozilla/5.0"
}


def search_cve_org_keyword(keyword, recent=None):
    try:
        from datetime import datetime, timedelta, timezone
        post_data = {"query": keyword, "from": 0, "size": 200, "sort": {"property": "cveId", "order": "desc"}}
        req = urllib.request.Request(CVE_ORG_API, data=json.dumps(post_data).encode(), headers=CVE_ORG_HEADERS)
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
                if m.get("cvssV3_1"):
                    cvss_score = m["cvssV3_1"].get("baseScore", "N/A")
                    cvss_vector = m["cvssV3_1"].get("vectorString", "N/A")
                    break
            results.append({
                "id": cve_id,
                "description": desc[:200],
                "cvss_score": cvss_score,
                "cvss_vector": cvss_vector,
                "source": "cveorg",
                "published": date_str,
            })
        return results
    except Exception as exc:
        return [{"error": "CVE.org search failed: %s" % exc}]


def search_nvd_keyword(keyword, recent=None):
    params = {"keywordSearch": keyword, "resultsPerPage": 50}
    if recent:
        from datetime import datetime, timedelta, timezone
        end_date = datetime.now(timezone.utc)
        start_date = end_date - timedelta(days=recent * 30)
        params["pubStartDate"] = start_date.strftime("%Y-%m-%dT%H:%M:%S.000")
        params["pubEndDate"] = end_date.strftime("%Y-%m-%dT%H:%M:%S.000")
    url = "%s?%s" % (NVD_API_BASE, urllib.parse.urlencode(params))
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode())
        results = []
        for item in data.get("vulnerabilities", []):
            cve = item.get("cve", {})
            cve_id = cve.get("id", "N/A")
            descriptions = cve.get("descriptions", [{}])
            english_desc = next((d.get("value", "") for d in descriptions if d.get("lang") == "en"), "")
            metrics = cve.get("metrics", {})
            cvss_v3 = metrics.get("cvssMetricV31", [{}]) or metrics.get("cvssMetricV30", [])
            cvss_score = "N/A"
            if cvss_v3 and isinstance(cvss_v3, list):
                cvss_score = cvss_v3[0].get("cvssData", {}).get("baseScore", "N/A")
            results.append({
                "id": cve_id,
                "description": english_desc[:200],
                "cvss_score": cvss_score,
                "source": "nvd",
            })
        return results
    except Exception as exc:
        return [{"error": "NVD search failed: %s" % exc}]


def search_github_advisory(keyword, recent=None):
    try:
        params = urllib.parse.urlencode({"affects": keyword, "type": "reviewed", "per_page": 50})
        url = "%s?%s" % (GITHUB_ADVISORY_API, params)
        req = urllib.request.Request(url, headers=GITHUB_HEADERS)
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode())
        results = []
        for item in data:
            cve_id = item.get("cve_id", "") or item.get("ghsa_id", "")
            cvss_score = item.get("cvss", {}).get("score", "N/A") if item.get("cvss") else "N/A"
            results.append({
                "id": cve_id,
                "description": item.get("description", "")[:200],
                "cvss_score": cvss_score,
                "source": "github",
                "severity": item.get("severity", "N/A"),
            })
        return results
    except Exception as exc:
        return [{"error": "GitHub Advisory search failed: %s" % exc}]


def format_cve_detail(cve, source):
    cve_id = cve.get("id", "N/A")
    descriptions = cve.get("descriptions", [])
    desc = next((d.get("value", "") for d in descriptions if d.get("lang") == "en"), "")
    metrics = cve.get("metrics", {})
    cvss_v3 = metrics.get("cvssMetricV31", []) or metrics.get("cvssMetricV30", [])
    cvss_score = "N/A"
    cvss_vector = "N/A"
    if cvss_v3:
        cvss_data = cvss_v3[0].get("cvssData", {})
        cvss_score = cvss_data.get("baseScore", "N/A")
        cvss_vector = cvss_data.get("vectorString", "N/A")
    weaknesses = cve.get("weaknesses", [])
    cwe_ids = []
    for weakness in weaknesses:
        for desc_item in weakness.get("description", []):
            if desc_item.get("type") == "CWE":
                cwe_ids.append(desc_item.get("value", ""))
    references = [r.get("url", "") for r in cve.get("references", [])[:10]]
    affected = []
    for config in cve.get("configurations", []):
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
        "references": references,
        "published": cve.get("published", "N/A"),
        "last_modified": cve.get("lastModified", "N/A"),
    }


def search_nvd_cve(cve_id):
    url = "%s?%s" % (NVD_API_BASE, urllib.parse.urlencode({"cveId": cve_id}))
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode())
        items = data.get("vulnerabilities", [])
        if not items:
            return {"error": "CVE %s not found in NVD" % cve_id}
        return format_cve_detail(items[0].get("cve", {}), "nvd")
    except Exception as exc:
        return {"error": "NVD lookup failed: %s" % exc}


def search_mitre_cve(cve_id):
    url = "%s/%s" % (MITRE_API_BASE, cve_id)
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode())
        return format_cve_detail(data, "mitre")
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return {"error": "CVE %s not found in MITRE" % cve_id}
        return {"error": "MITRE API error: %s" % exc}
    except Exception as exc:
        return {"error": "MITRE lookup failed: %s" % exc}


def search_product(product, version=None, recent=None):
    keyword = "%s %s" % (product, version) if version else product
    cveorg_results = search_cve_org_keyword(keyword, recent=recent)
    nvd_results = search_nvd_keyword(keyword, recent=recent)
    gh_results = search_github_advisory(keyword, recent=recent)
    seen = set()
    merged = []
    for result in cveorg_results + nvd_results + gh_results:
        cve_id = result.get("id", "")
        if cve_id and cve_id not in seen:
            seen.add(cve_id)
            merged.append(result)
    return merged


def normalize_cve_cache_item(item, product=None, repository=None):
    cwe_values = []
    cwe = item.get("cwe")
    if cwe and cwe != "N/A":
        cwe_values.append(cwe)
    tags = []
    if product:
        tags.append(product)
    if repository:
        tags.append(repository)
    return {
        "id": item.get("id"),
        "source": item.get("source"),
        "publishedAt": item.get("published"),
        "modifiedAt": item.get("last_modified") or item.get("modified"),
        "summary": item.get("description"),
        "severity": {
            "score": item.get("cvss_score"),
            "vector": item.get("cvss_vector"),
            "cwe": cwe_values,
        },
        "affected": {
            "product": product,
            "versions": [item.get("version")] if item.get("version") else [],
            "repository": repository,
        },
        "references": item.get("references", []),
        "tags": tags,
        "notes": "",
    }


def filter_cache_items(cache_items, keyword=None, cve_id=None, product=None):
    results = []
    keyword_l = keyword.lower() if keyword else None
    product_l = product.lower() if product else None
    for item in cache_items:
        if cve_id and item.get("id") != cve_id:
            continue
        text_parts = [item.get("id", ""), item.get("summary", "")] + item.get("tags", [])
        text = " ".join([p for p in text_parts if p]).lower()
        if keyword_l and keyword_l not in text:
            continue
        if product_l and product_l not in text:
            affected = item.get("affected", {})
            if product_l != str(affected.get("product", "")).lower():
                continue
        results.append(item)
    return results


def refresh_cve_cache(cache_doc, product=None, version=None, cve_id=None, keyword=None, recent=None, source="all"):
    fetched = []
    if cve_id:
        for func in (search_nvd_cve, search_mitre_cve):
            detail = func(cve_id)
            if detail and "error" not in detail:
                fetched.append(detail)
                break
    elif product:
        fetched = search_product(product, version=version, recent=recent)
    elif keyword:
        if source == "github":
            fetched = search_github_advisory(keyword, recent=recent)
        elif source == "nvd":
            fetched = search_nvd_keyword(keyword, recent=recent)
        elif source == "cveorg":
            fetched = search_cve_org_keyword(keyword, recent=recent)
        else:
            fetched = search_product(keyword, version=None, recent=recent)
    normalized = []
    for item in fetched:
        if item.get("error") or not item.get("id"):
            continue
        normalized.append(normalize_cve_cache_item(item, product=product or keyword, repository=cache_doc.get("project", {}).get("repository")))
    cache_doc["items"] = merge_items(cache_doc.get("items", []), normalized, ["id"])
    cache_doc["updatedAt"] = utc_now_iso()
    return cache_doc, fetched


def load_or_init_cache(cache_path, project_name, repository=None):
    data, _ = load_json_file(cache_path)
    if data is None:
        data = build_empty_cve_cache(project_name, repository=repository, aliases=[project_name])
    return normalize_cache_doc("cve-cache", data, project_name, repository=repository)


def maybe_use_cache(args):
    use_cache = bool(args.product or args.repository or args.cve)
    if not use_cache:
        return None, None, None
    project_name = args.project_name or args.product or (args.repository.split("/")[-1] if args.repository else "project")
    cache_path = args.cache_path or CVE_CACHE_PATH
    cache_doc = load_or_init_cache(cache_path, project_name, repository=args.repository)
    stale = args.refresh or is_cache_stale(cache_doc.get("updatedAt"), 7)
    cache_hit_results = filter_cache_items(cache_doc.get("items", []), keyword=args.keyword, cve_id=args.cve, product=args.product)
    if stale or (args.cve and not cache_hit_results) or (args.product and not cache_hit_results):
        cache_doc, fresh_results = refresh_cve_cache(cache_doc, product=args.product, version=args.version, cve_id=args.cve, keyword=args.keyword, recent=args.recent, source=args.source)
        write_json_file(cache_path, cache_doc)
        cache_hit_results = filter_cache_items(cache_doc.get("items", []), keyword=args.keyword, cve_id=args.cve, product=args.product)
        return cache_doc, cache_hit_results, "cache+refresh"
    return cache_doc, cache_hit_results, "cache-only"


def print_results(results):
    if not results:
        print("No results found.")
        return
    if isinstance(results, dict) and "error" in results:
        print("Error: %s" % results["error"])
        return
    if isinstance(results, dict):
        print("\n" + "=" * 60)
        print("CVE ID: %s" % results.get("id", "N/A"))
        print("Source: %s" % results.get("source", "N/A"))
        print("CVSS Score: %s" % results.get("cvss_score", "N/A"))
        if results.get("cvss_vector"):
            print("CVSS Vector: %s" % results.get("cvss_vector"))
        print("CWE: %s" % results.get("cwe", "N/A"))
        print("\nPublished: %s" % results.get("published", "N/A"))
        print("Last Modified: %s" % results.get("last_modified", "N/A"))
        print("\nDescription:\n  %s" % results.get("description", "N/A"))
        if results.get("affected_products"):
            print("\nAffected Products:")
            for item in results["affected_products"][:5]:
                print("  - %s" % item)
        if results.get("references"):
            print("\nReferences:")
            for ref in results["references"]:
                print("  - %s" % ref)
        print("=" * 60 + "\n")
        return
    print("\nFound %d results:\n" % len(results))
    for item in results:
        if "error" in item:
            print("Error: %s" % item["error"])
            continue
        print("[%s] %s - CVSS: %s" % (item.get("source"), item.get("id"), item.get("cvss_score", "N/A")))
        print("  %s...\n" % item.get("description", "")[:150])


def cache_items_to_cli_results(cache_items):
    results = []
    for item in cache_items:
        severity = item.get("severity", {})
        cwe_values = severity.get("cwe") or []
        results.append({
            "id": item.get("id"),
            "description": item.get("summary", ""),
            "cvss_score": severity.get("score", "N/A"),
            "cvss_vector": severity.get("vector", "N/A"),
            "cwe": cwe_values[0] if cwe_values else "N/A",
            "source": item.get("source", "cache"),
            "affected_products": (item.get("affected") or {}).get("versions", []),
            "references": item.get("references", []),
            "published": item.get("publishedAt", "N/A"),
            "last_modified": item.get("modifiedAt", "N/A"),
        })
    if len(results) == 1 and results[0].get("id"):
        return results[0]
    return results


def main():
    parser = argparse.ArgumentParser(description="CVE Search Tool with project-scoped cache support")
    parser.add_argument("--keyword", "-k", help="Search by keyword")
    parser.add_argument("--cve", "-c", help="Get details for specific CVE ID")
    parser.add_argument("--product", "-p", help="Search by product name")
    parser.add_argument("--version", "-v", help="Specific version (used with --product)")
    parser.add_argument("--recent", "-r", type=int, metavar="MONTHS", help="Only return CVEs published within the last N months")
    parser.add_argument("--source", "-s", choices=["nvd", "mitre", "github", "cveorg", "all"], default="all")
    parser.add_argument("--json", "-j", action="store_true", help="Output as JSON")
    parser.add_argument("--cache-path", help="Override cve cache path")
    parser.add_argument("--project-name", help="Project name used in cache metadata")
    parser.add_argument("--repository", help="Repository in owner/repo form for cache metadata")
    parser.add_argument("--refresh", action="store_true", help="Force refresh and merge cache")
    args = parser.parse_args()

    cache_doc, cache_results, cache_mode = maybe_use_cache(args)
    if cache_mode is not None:
        result_payload = cache_items_to_cli_results(cache_results)
        if args.json:
            print(json.dumps({"cacheMode": cache_mode, "cachePath": args.cache_path or CVE_CACHE_PATH, "results": result_payload}, indent=2))
        else:
            print("cache mode: %s" % cache_mode)
            print("cache path: %s" % (args.cache_path or CVE_CACHE_PATH))
            print_results(result_payload)
        return

    if args.cve:
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
        else:
            results = search_product(args.keyword, version=None, recent=args.recent)
    else:
        parser.print_help()
        sys.exit(1)

    if args.json:
        print(json.dumps(results, indent=2))
    else:
        print_results(results)


if __name__ == "__main__":
    main()
