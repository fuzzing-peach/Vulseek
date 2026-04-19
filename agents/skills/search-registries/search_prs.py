#!/usr/bin/env python3
"""
GitHub Pull Request Search Tool with project-scoped structured cache.
"""

import argparse
import json
import sys
import urllib.request
import urllib.parse
import urllib.error

from cache_utils import (
    PR_CACHE_PATH,
    build_empty_pr_cache,
    is_cache_stale,
    load_json_file,
    merge_items,
    normalize_cache_doc,
    utc_now_iso,
    write_json_file,
)

GITHUB_API_BASE = "https://api.github.com"


def github_request(url, token=None):
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "vulseek-search-prs",
    }
    if token:
        headers["Authorization"] = "Bearer %s" % token
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def list_pull_requests(repository, state="all", per_page=100, max_pages=3, token=None):
    owner, repo = repository.split("/", 1)
    items = []
    for page in range(1, max_pages + 1):
        params = urllib.parse.urlencode({
            "state": state,
            "sort": "updated",
            "direction": "desc",
            "per_page": per_page,
            "page": page,
        })
        url = "%s/repos/%s/%s/pulls?%s" % (GITHUB_API_BASE, owner, repo, params)
        page_items = github_request(url, token=token)
        if not isinstance(page_items, list) or not page_items:
            break
        items.extend(page_items)
        if len(page_items) < per_page:
            break
    return items


def filter_pull_requests(items, query=None, base_branch=None):
    filtered = []
    query_l = query.lower() if query else None
    for item in items:
        if base_branch and item.get("base", {}).get("ref") != base_branch:
            continue
        if query_l:
            text = " ".join([
                item.get("title", ""),
                item.get("body", "") or "",
                " ".join([label.get("name", "") for label in item.get("labels", [])]),
            ]).lower()
            if query_l not in text:
                continue
        filtered.append(item)
    return filtered


def normalize_pr_item(item):
    return {
        "id": item.get("id"),
        "number": item.get("number"),
        "title": item.get("title"),
        "state": item.get("state"),
        "isMerged": bool(item.get("merged_at")),
        "createdAt": item.get("created_at"),
        "updatedAt": item.get("updated_at"),
        "mergedAt": item.get("merged_at"),
        "url": item.get("html_url"),
        "author": (item.get("user") or {}).get("login"),
        "baseRef": (item.get("base") or {}).get("ref"),
        "headRef": (item.get("head") or {}).get("ref"),
        "labels": [label.get("name") for label in item.get("labels", []) if label.get("name")],
        "relatedCommits": [item.get("head", {}).get("sha")] if item.get("head", {}).get("sha") else [],
        "summary": (item.get("body") or "")[:300],
        "tags": [],
        "notes": "",
    }


def load_or_init_cache(cache_path, project_name, repository):
    data, _ = load_json_file(cache_path)
    if data is None:
        data = build_empty_pr_cache(project_name, repository)
    return normalize_cache_doc("pr-cache", data, project_name, repository=repository)


def filter_cache_items(cache_items, query=None, state=None, base_branch=None):
    results = []
    query_l = query.lower() if query else None
    for item in cache_items:
        if state and state != "all":
            if state == "merged":
                if not item.get("isMerged"):
                    continue
            elif item.get("state") != state:
                continue
        if base_branch and item.get("baseRef") != base_branch:
            continue
        if query_l:
            text = " ".join([
                item.get("title", "") or "",
                item.get("summary", "") or "",
                " ".join(item.get("labels", []) or []),
                " ".join(item.get("tags", []) or []),
            ]).lower()
            if query_l not in text:
                continue
        results.append(item)
    return results


def refresh_pr_cache(cache_doc, repository, query=None, state="all", base_branch=None, max_pages=3, token=None):
    fetched = list_pull_requests(repository, state="all", max_pages=max_pages, token=token)
    filtered = filter_pull_requests(fetched, query=query, base_branch=base_branch)
    normalized = [normalize_pr_item(item) for item in filtered]
    cache_doc["items"] = merge_items(cache_doc.get("items", []), normalized, ["id", "number"])
    coverage = cache_doc.setdefault("coverage", {})
    coverage["states"] = ["open", "closed", "merged"]
    if base_branch:
        branches = coverage.get("baseBranches", []) or []
        if base_branch not in branches:
            branches.append(base_branch)
        coverage["baseBranches"] = branches
    cache_doc["updatedAt"] = utc_now_iso()
    return cache_doc


def cache_items_to_output(items):
    return {
        "count": len(items),
        "pullRequests": items,
    }


def print_results(results):
    count = results.get("count", 0)
    if count == 0:
        print("No pull requests found.")
        return
    print("Found %d pull request(s)\n" % count)
    for item in results.get("pullRequests", []):
        merged_marker = " merged" if item.get("isMerged") else ""
        print("[#%s] %s (%s%s)" % (item.get("number"), item.get("title"), item.get("state"), merged_marker))
        print("  base=%s head=%s" % (item.get("baseRef"), item.get("headRef")))
        print("  updated=%s" % item.get("updatedAt"))
        print("  url=%s" % item.get("url"))
        if item.get("labels"):
            print("  labels=%s" % ", ".join(item.get("labels")))
        if item.get("summary"):
            print("  %s" % item.get("summary")[:200].replace("\n", " "))
        print()


def main():
    parser = argparse.ArgumentParser(description="GitHub PR search tool with project-scoped cache support")
    parser.add_argument("--repository", "-R", required=True, help="Repository in owner/repo form")
    parser.add_argument("--query", "-q", help="Keyword query for title/body/labels")
    parser.add_argument("--state", choices=["open", "closed", "merged", "all"], default="all")
    parser.add_argument("--base-branch", help="Filter by base branch")
    parser.add_argument("--project-name", help="Project name for cache metadata")
    parser.add_argument("--cache-path", help="Override PR cache path")
    parser.add_argument("--refresh", action="store_true", help="Force refresh and merge cache")
    parser.add_argument("--max-pages", type=int, default=3, help="Number of GitHub PR pages to fetch when refreshing (default: 3)")
    parser.add_argument("--github-token", help="Optional GitHub token")
    parser.add_argument("--json", "-j", action="store_true", help="Output as JSON")
    args = parser.parse_args()

    project_name = args.project_name or args.repository.split("/")[-1]
    cache_path = args.cache_path or PR_CACHE_PATH

    if True:
        cache_doc = load_or_init_cache(cache_path, project_name, args.repository)
        stale = args.refresh or is_cache_stale(cache_doc.get("updatedAt"), 1)
        cache_items = filter_cache_items(cache_doc.get("items", []), query=args.query, state=args.state, base_branch=args.base_branch)
        cache_mode = "cache-only"
        if stale or not cache_items:
            cache_doc = refresh_pr_cache(cache_doc, args.repository, query=args.query, state=args.state, base_branch=args.base_branch, max_pages=args.max_pages, token=args.github_token)
            write_json_file(cache_path, cache_doc)
            cache_items = filter_cache_items(cache_doc.get("items", []), query=args.query, state=args.state, base_branch=args.base_branch)
            cache_mode = "cache+refresh"
        payload = cache_items_to_output(cache_items)
        payload["cacheMode"] = cache_mode
        payload["cachePath"] = cache_path
        if args.json:
            print(json.dumps(payload, indent=2))
        else:
            print("cache mode: %s" % cache_mode)
            print("cache path: %s\n" % cache_path)
            print_results(payload)
        return



if __name__ == "__main__":
    main()
