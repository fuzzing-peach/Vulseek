#!/usr/bin/env python3
import json
import os
import sys
import urllib.error
import urllib.request


def main() -> int:
    if len(sys.argv) not in (2, 3):
        print("usage: research_db.py <operation> [entity-id]", file=sys.stderr)
        return 2
    operation = sys.argv[1]
    allowed = {
        "list-tracks",
        "get-track",
        "list-track-events",
        "list-findings",
        "list-primitives",
        "list-chains",
        "get-chain",
        "list-chain-events",
    }
    if operation not in allowed:
        print("unsupported read operation", file=sys.stderr)
        return 2

    base_url = os.environ.get("VULSEEK_RESEARCH_BROKER_URL", "").rstrip("/")
    token = os.environ.get("VULSEEK_RESEARCH_BROKER_TOKEN", "")
    scan_job_id = os.environ.get("VULSEEK_SCAN_JOB_ID", "")
    task_id = os.environ.get("VULSEEK_TASK_ID", "")
    entity_id = sys.argv[2] if len(sys.argv) == 3 else ""
    if not base_url or not token or not scan_job_id or not task_id:
        print("research broker context is not configured", file=sys.stderr)
        return 1

    payload = json.dumps(
        {
            "operation": operation,
            "scanJobId": scan_job_id,
            "taskId": task_id,
            **({"entityId": entity_id} if entity_id else {}),
        }
    ).encode("utf-8")
    endpoint = (
        base_url
        if base_url.endswith("/research-broker")
        else f"{base_url}/internal/scan/research-broker"
    )
    request = urllib.request.Request(
        endpoint,
        data=payload,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            raw = response.read(1024 * 1024 + 1)
            if len(raw) > 1024 * 1024:
                print("research broker response exceeds 1 MiB", file=sys.stderr)
                return 1
            result = json.loads(raw)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        print(f"research broker request failed: {error}", file=sys.stderr)
        return 1

    print(json.dumps(result, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
