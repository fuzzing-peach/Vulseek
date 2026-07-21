---
name: research-db
description: Read the current research Registry through the Vulseek internal read-only broker.
---

# Research Database Queries

Use the helper instead of connecting to PostgreSQL or writing SQL:

```bash
python3 /workspace/repo/.agents/skills/research-db/research_db.py list-tracks
python3 /workspace/repo/.agents/skills/research-db/research_db.py list-findings
python3 /workspace/repo/.agents/skills/research-db/research_db.py list-primitives
python3 /workspace/repo/.agents/skills/research-db/research_db.py list-chains
python3 /workspace/repo/.agents/skills/research-db/research_db.py get-chain <chain-id>
```

The helper is read-only and scoped to the current `scanJobId` and `taskId`. Do not attempt writes, arbitrary SQL, cross-job reads, or direct database connections. Treat broker failures as missing evidence rather than inventing Registry state.
