#!/usr/bin/env python3
import json
import os
from datetime import datetime, timedelta

DEFAULT_CACHE_DIR = os.environ.get("VULSEEK_PROJECT_CACHE_DIR", "/scan-context/cache")
CVE_CACHE_PATH = os.path.join(DEFAULT_CACHE_DIR, "cve-cache.json")
PR_CACHE_PATH = os.path.join(DEFAULT_CACHE_DIR, "pr-cache.json")


def utc_now_iso():
    return datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def ensure_parent_dir(path):
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)


def load_json_file(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh), None
    except FileNotFoundError:
        return None, "missing"
    except Exception as exc:
        return None, str(exc)


def write_json_file(path, data):
    ensure_parent_dir(path)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, sort_keys=False)
        fh.write("\n")


def parse_iso8601(value):
    if not value or not isinstance(value, str):
        return None
    normalized = value.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(normalized)
    except Exception:
        return None


def is_cache_stale(updated_at, ttl_days):
    if ttl_days is None:
        return False
    parsed = parse_iso8601(updated_at)
    if parsed is None:
        return True
    return datetime.utcnow() - parsed.replace(tzinfo=None) > timedelta(days=ttl_days)


def _merge_scalar(old, new):
    if new is None:
        return old
    if isinstance(new, str) and not new.strip():
        return old
    return new


def _merge_list(old, new):
    values = []
    for seq in (old or [], new or []):
        for item in seq:
            if item not in values:
                values.append(item)
    return values


def _merge_dict(old, new):
    result = dict(old or {})
    for key, value in (new or {}).items():
        if isinstance(value, list):
            result[key] = _merge_list(result.get(key, []), value)
        elif isinstance(value, dict):
            result[key] = _merge_dict(result.get(key, {}), value)
        else:
            result[key] = _merge_scalar(result.get(key), value)
    return result


def merge_items(existing_items, incoming_items, key_fields):
    merged = []
    index = {}

    def make_key(item):
        for field in key_fields:
            value = item.get(field)
            if value not in (None, ""):
                return str(value)
        return None

    for item in existing_items or []:
        key = make_key(item)
        if key is None:
            merged.append(item)
            continue
        index[key] = len(merged)
        merged.append(item)

    for item in incoming_items or []:
        key = make_key(item)
        if key is None:
            merged.append(item)
            continue
        if key in index:
            merged[index[key]] = _merge_dict(merged[index[key]], item)
        else:
            index[key] = len(merged)
            merged.append(item)

    return merged


def build_empty_cve_cache(project_name, repository=None, aliases=None):
    return {
        "schemaVersion": 1,
        "kind": "cve-cache",
        "project": {
            "name": project_name,
            "repository": repository,
            "aliases": aliases or [project_name],
        },
        "updatedAt": None,
        "coverage": {
            "sources": ["cveorg", "nvd", "mitre", "github", "osv"],
            "query": {
                "product": project_name,
                "repository": repository,
                "keywords": [],
            },
            "from": None,
            "to": None,
            "notes": "project-scoped CVE cache",
        },
        "items": [],
    }


def build_empty_pr_cache(project_name, repository, host="github"):
    return {
        "schemaVersion": 1,
        "kind": "pr-cache",
        "project": {
            "name": project_name,
            "repository": repository,
            "host": host,
        },
        "updatedAt": None,
        "coverage": {
            "states": ["open", "closed", "merged"],
            "baseBranches": [],
            "from": None,
            "to": None,
            "notes": "project-scoped PR cache",
        },
        "items": [],
    }


def normalize_cache_doc(kind, data, project_name, repository=None):
    if not isinstance(data, dict):
        return build_empty_cve_cache(project_name, repository) if kind == "cve-cache" else build_empty_pr_cache(project_name, repository or "")
    if data.get("kind") != kind:
        return build_empty_cve_cache(project_name, repository) if kind == "cve-cache" else build_empty_pr_cache(project_name, repository or "")
    if "items" not in data or not isinstance(data.get("items"), list):
        data["items"] = []
    if "project" not in data or not isinstance(data.get("project"), dict):
        data["project"] = {}
    data["project"]["name"] = data["project"].get("name") or project_name
    if repository is not None:
        data["project"]["repository"] = data["project"].get("repository") or repository
    return data
