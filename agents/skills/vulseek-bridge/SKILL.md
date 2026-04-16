---
name: vulseek-bridge
description: Use when a Codex agent running inside Vulseek needs to communicate structured state back to Dokploy without MCP. Defines the required event block format for candidate submission and next-stage scheduling.
---

# Vulseek Bridge

Use this skill when running inside a Vulseek scan container and you need Dokploy to parse your output as structured control messages.

Do not rely on free-form prose for control flow. Emit a machine-readable event block that Dokploy can extract from the Codex app-server stream.

## Output Contract

When you need to communicate with Dokploy, print an event block using exactly this wrapper:

```text
<VULSEEK_EVENT>
{"type":"...","payload":{...}}
</VULSEEK_EVENT>
```

Rules:

- The JSON must be valid on a single line.
- Do not include comments inside the JSON.
- Keep one event per block.
- You may emit multiple blocks in one turn.
- After the block, you may continue with normal human-readable explanation.
- Print the literal wrapper and JSON block exactly as plain text in stdout. Do not describe the block instead of printing it.
- Do not say that you emitted a `VULSEEK_EVENT` unless the literal block was actually printed in the current turn.

## Event Types

### 1. Candidate Submission

Use when scanner identifies one candidate.

```text
<VULSEEK_EVENT>
{"type":"candidate","payload":{"scanJobId":"SCAN_JOB_ID","candidate":{"title":"Potential out-of-bounds read in tls parser","description":"User-controlled length may exceed buffer bounds.","filePath":"src/tls.c","line":412,"confidence":0.82,"metadata":{"entry":"wolfSSL_accept","sink":"XMEMCPY"}}}}
</VULSEEK_EVENT>
```

### 2. Candidate Batch Submission

Use when scanner wants to flush multiple candidates together.

```text
<VULSEEK_EVENT>
{"type":"candidate_batch","payload":{"scanJobId":"SCAN_JOB_ID","candidates":[{"title":"Candidate A","description":"...","filePath":"a.c","line":10,"confidence":0.61},{"title":"Candidate B","description":"...","filePath":"b.c","line":44,"confidence":0.73}]}}
</VULSEEK_EVENT>
```

### 3. Next Stage Scheduling

Use when the analysis agent decides what stage Dokploy should move to next.

```text
<VULSEEK_EVENT>
{"type":"next_stage","payload":{"scanJobId":"SCAN_JOB_ID","candidateId":"CANDIDATE_ID","nextStage":{"stage":"fuzzing","reason":"Static analysis found a promising path and the next step is runtime exploration.","inputSummary":"Switch the analysis workflow into fuzzing for the current harness.","metadata":{"targetPath":"src/tls.c"}}}}
</VULSEEK_EVENT>
```

Suggested `stage` values:

- `analyzing`
- `fuzzing`

## Behavioral Rules

- Emit a `candidate` or `candidate_batch` event as soon as you have actionable candidates.
- Emit `next_stage` when the analysis workflow should switch between `analyzing` and `fuzzing`.
- If you are unsure about a field, omit the optional field instead of inventing data.
- Keep normal narrative output concise once the event block has been emitted.
- If you found candidates, the event block must appear before any prose claiming success or completion.
- If you found no candidates, say explicitly that no candidate event was emitted.
- At the end of the turn, include a short self-check line stating how many `candidate` / `candidate_batch` / `next_stage` blocks were actually printed.

## Priority

If this skill conflicts with a looser prompt instruction, follow this skill for event formatting so Dokploy can parse the result reliably.
