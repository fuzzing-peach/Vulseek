# Pipeline Definition Workbench Browser Test Plan

## Objective

Use a real authenticated browser against the local dev environment to validate the Pipeline Definition Workbench end to end. Cover Definition, Visual, and Raw YAML behavior; cross-view synchronization; draft and version workflows; responsive layouts; accessibility; performance; and failure recovery.

All testing is dev-only. Do not connect to, modify, restart, or benchmark release.

## Test Environment

- Base URL: `http://127.0.0.1:23000`
- Browser driver: `agent-browser` with a persistent authenticated session
- Viewports: `1440x900`, `1024x768`, and `390x844`
- Capture before each scenario: URL, pipeline ID, draft revision, published version, console errors, failed requests, and an accessibility snapshot
- Clear console errors before each scenario so failures can be attributed to the current action

Use one browser session throughout a scenario so authentication, navigation history, and unsaved state behave like a real user session.

## Pipeline Fixtures

| Fixture | Purpose | Mutation policy |
| --- | --- | --- |
| Full Scan | Large schema set and normal production topology | Read-only regression |
| Delta Scan | Medium linear and branching topology | Read-only regression |
| Research | Cycles, dynamic routes, and many outgoing edges | Read-only regression |
| ToB Goal | Goal-oriented stages and routing | Read-only regression |
| Custom baseline | CRUD, save, publish, and version tests | Copy to a temporary pipeline first |
| Stress fixture | 100 stages, 200 edges, groups, cycles, self-loops, multi-edges, and disconnected nodes | Temporary pipeline only |

Create a uniquely named temporary custom pipeline before mutation tests. Record its ID and archive it during cleanup. Never edit a system pipeline merely to exercise destructive behavior.

## Execution Flow

### 1. Preflight

- Confirm the dev page responds and the authenticated session can open `/dashboard/pipelines`.
- Confirm Full Scan, Delta Scan, Research, ToB Goal, and Custom baseline are present.
- Record the current Git commit and verify no release URL is open in the browser session.
- Clear browser errors and failed-request history.
- Create the temporary Custom and Stress fixtures required by later phases.

Stop immediately if authentication fails, the dev API is unavailable, or the test would target a system pipeline for mutation.

### 2. Navigation and Shell

- Open every fixture from the Pipelines list.
- Verify breadcrumb, Back to Pipelines, browser Back, and browser Forward.
- Verify Definition, Visual, and Raw YAML tabs are present and retain the same pipeline identity.
- Verify returning to the list is responsive and does not trigger duplicate pipeline queries.
- Verify loading, empty, and unavailable-version states do not leave a blank editor shell.

### 3. Definition View

- Verify Overview fields, supported targets, root stage, limits, and entity counts.
- Verify Stage, Edge, Schema, and Group lists support search and keyboard selection.
- Exercise every Stage section: General, Runtime, Prompt, Input/Output, Artifacts, and Effects.
- Exercise Edge General, Route, Transform, Artifacts, and Output Contract fields.
- Verify Schema Form and JSON Schema modes remain synchronized.
- Verify Schema Used by and References navigate to the correct entity.
- Verify Group leader, member, duplicate membership, and disconnected-member diagnostics.
- Verify Layout actions: Apply ELK layout, Reset layout, and Clear edge routing.

### 4. CRUD and Validation

- Create a stage, edge, schema, and group with valid IDs.
- Attempt duplicate IDs and invalid IDs; creation must remain blocked with an actionable message.
- Modify display names without changing stable IDs.
- Duplicate or copy supported entities and verify references remain explicit.
- Attempt to delete referenced entities; blockers must list inbound and outbound references.
- Delete unreferenced entities and confirm they disappear from Definition, Visual, Raw YAML, and quick navigation.
- Undo and redo every CRUD operation.

### 5. Cross-View Synchronization

- Select an entity in Definition and verify Visual highlights the same entity.
- Select a node or edge in Visual and verify Definition opens the matching editor.
- Move a node in Visual and verify Raw YAML updates `ui.nodes` only after drag stop.
- Edit a structured field and verify Raw YAML changes without replacing unrelated content.
- Edit valid Raw YAML and verify Definition and Visual refresh atomically.
- Use `Ctrl/Cmd+P` to navigate to stages, edges, schemas, groups, and diagnostics.
- Verify one shared undo/redo history across all three views.

### 6. Raw YAML and Error Recovery

- Verify comments, ordering, quoted scalars, block scalars, anchors, and untouched sections survive structured edits where supported.
- Introduce incomplete YAML, invalid YAML, duplicate IDs, unknown stages, invalid `$ref`, and invalid route data.
- Confirm the raw buffer is never replaced by the last valid document.
- Confirm Definition and Visual mutation controls are disabled while the document is invalid.
- Confirm Diagnostics reports source location and clicking a source-only diagnostic reveals the correct YAML line.
- Repair the YAML and verify structured editing becomes available without reloading the page.
- Confirm Save Draft and Publish remain blocked while validation errors exist.

### 7. Visual Workspace

- Verify linear paths, branches, joins, cycles, self-loops, multi-edges, groups, and disconnected stages.
- Verify routed edges are orthogonal, distinguishable, and do not cross stage nodes.
- Verify node drag, selection, multi-selection, copy/paste, deletion, Fit View, Center Root, Auto Layout, direction, MiniMap, and interaction lock.
- Verify Inspector open, close, resize, persisted width, and narrow-screen overlay behavior.
- Verify stale asynchronous layout results cannot overwrite newer edits.
- Save and reload; node positions and bend points must remain stable.

### 8. Draft, Publish, and Version Lifecycle

- Make a change and verify the page becomes dirty.
- Save with the button and `Ctrl/Cmd+S`; both must persist the same YAML and clear dirty state.
- Simulate a failed save; local edits must remain available and an error must be visible.
- Reload after a successful save and verify all three views match the saved draft.
- Publish the temporary pipeline and verify a new immutable version is created.
- Open the published version and verify all mutation controls are disabled.
- Use Copy to Draft and verify the published version remains unchanged.
- Create a revision conflict and verify the stale client cannot silently overwrite the newer draft.
- Navigate away with unsaved changes and verify the configured unsaved-change protection.

### 9. Responsive and Accessibility

- At `1440x900`, verify the three-column Definition layout and resizable Inspector.
- At `1024x768`, verify the Inspector collapses or becomes an overlay without covering primary controls.
- At `390x844`, verify rail, list, and editor are separate drill-down screens with a visible back path.
- Verify keyboard Tab order, Enter/Space activation, Escape handling, focus restoration, and visible focus styles.
- Verify dialogs have accessible titles and descriptions and interactive controls have stable accessible names.
- Verify no content, toolbar, diagnostic, or action is clipped at any target viewport.

### 10. Performance and Stability

- Measure initial editor readiness; target less than `2s` on the dev host.
- Measure ordinary structured-field feedback; target less than `100ms` perceived latency.
- Measure the Stress fixture layout; target less than `2s`.
- Measure return to Pipelines; target less than `500ms` after prefetch.
- Switch views 20 times and confirm no duplicate requests, runaway memory growth, or React errors.
- Confirm ordinary field edits do not re-render or relayout the full canvas unnecessarily.

## Failure Diagnosis

For every failed scenario, diagnose in this order:

1. Capture the current accessibility snapshot and screenshot.
2. Record the active URL, pipeline ID, selected entity, viewport, and unsaved state.
3. Inspect console errors and failed network requests.
4. Inspect the relevant API response and dev service logs.
5. Compare the persisted draft/version with the browser's Raw YAML.
6. Trace the workbench reducer, YAML patch operation, router mutation, and affected component.

Do not continue a destructive scenario after state becomes ambiguous. Preserve the temporary fixture for diagnosis and create a new fixture for later tests.

## Evidence and Reporting

For each scenario, record:

- Pass, fail, or blocked result
- Pipeline type and ID
- Browser viewport
- Important timings
- Before and after draft revision
- Published version when applicable
- Screenshot paths for key states
- Console errors and failed-request summaries
- Created entities and cleanup status

The final report must separate product defects, test-environment failures, flaky timing checks, and accessibility warnings.

## Cleanup

- Archive all temporary Custom and Stress pipelines created by the test.
- Confirm system pipelines were not modified.
- Confirm no temporary draft or published version remains attached to a shared fixture.
- Restore the browser viewport and leave the authenticated browser session reusable.
- Do not stop or restart release services.

## Exit Criteria

The browser test passes only when:

- All five real pipeline types open successfully in all three views.
- The temporary Custom pipeline completes the CRUD, save, publish, version, and Copy to Draft lifecycle.
- Cross-view selection, data, diagnostics, and undo/redo remain consistent.
- Invalid YAML is recoverable without losing user text.
- Complex Visual routes remain readable and avoid stage nodes.
- Desktop, laptop, and narrow layouts remain fully operable.
- No unexplained console error, failed request, duplicate write, or data loss remains.
- All temporary data is archived and release remains untouched.

## Supporting Automated Checks

Run these before and after the browser suite:

```bash
pnpm --filter vulseek test
pnpm --filter @vulseek/server typecheck
pnpm --filter vulseek typecheck
git diff --check
```

Browser verification complements these checks; it does not replace unit, component, synchronization, or layout tests.
