# React Flow Pipeline Visual Editor

## Summary

Retain `@xyflow/react` and replace the current handwritten graph layout with the already-installed `elkjs`. The Visual tab will become a full-height, interactive editor for the complete V3 pipeline document, including cyclic flows, groups, schemas, runtime settings, and routed edges.

The default layout is top-to-bottom. Node positions, edge bend points, and layout direction are stored in the V3 `ui` section. Changes remain local to the draft until the user explicitly saves with Save Draft or `Ctrl/Cmd+S`.

## Canvas and Layout

- Give the pipeline editor a dedicated full-height workspace and fix the collapsed React Flow container. Make the Inspector a collapsible, resizable right drawer.
- Replace the longest-path layout with ELK Layered using `DOWN` by default, orthogonal edge routing, cycle breaking, port constraints, edge labels, and compound layout.
- Support cycles, self-loops, multiple edges between the same stages, disconnected stages, and groups without placing nodes outside the usable viewport.
- Restore complete saved `ui.nodes` layouts. When positions are missing, calculate a temporary ELK layout without dirtying the draft; persist it only after Apply Layout or a completed node drag.
- Ignore stale asynchronous layout results with a generation token. Re-run `fitView()` after node measurement, container resize, Inspector toggles, and successful layout.
- Add Zoom, Fit, Center Root, Auto Layout, direction, MiniMap, interaction lock, and Inspector controls.

## Complete V3 Editing

- Add a Stage Palette and creation dialog. New stages receive a stable slug, name, role, and group; existing IDs remain immutable.
- Expand the Stage Inspector to cover mode, concurrency, runtime, agent profile, skills, plugins, persistence, container reuse, cwd, prompt, artifacts, effects, schemas, prompt values, and task naming.
- Expand the Edge Inspector to cover map/fanOut, foreach, route, default route, fork, input, artifacts, output schema, and descriptions.
- Permit multiple same-source/same-target edges when their IDs or routes differ. Creating a connection generates a unique edge ID and opens its Inspector.
- Render groups as swimlanes or compound nodes and support group creation, deletion, leader selection, and member management.
- Provide embedded JSON editors for arbitrary JSON Schema, edge input, and prompt values instead of requiring full-YAML editing.
- Add Pipeline-level editing for name, description, supported targets, root stage, and limits.
- Convert diagnostics into an expandable bottom panel. Selecting a diagnostic focuses the corresponding stage, edge, schema, or group.
- Add undo/redo, copy/paste, multi-select, keyboard deletion, and destructive-action confirmation. Persist node positions only on drag stop.

## State, Versions, and Interfaces

- Extend optional V3 UI metadata with `direction?: "DOWN" | "RIGHT"`; continue using `ui.nodes[id].{x,y}` and begin consuming and persisting `ui.edges[id].bendPoints`.
- Keep all UI fields optional so existing V3 documents remain valid. Runtime compilation continues to ignore `ui`.
- Add history and transient layout state to the editor reducer. Layout previews do not mark the draft dirty; applied layouts and model edits do.
- Fix published-version selection: selecting `v1`, `v2`, or `v3` loads that version through the existing `pipeline.getVersion` API and opens a read-only Published View. Editing starts only after Copy to Draft.
- Add a full-height workspace option to the dashboard layout without changing other dashboard pages.
- Do not add a database migration or alter published pipeline and Scan Job execution semantics.

## Test Plan

- Layout unit tests cover linear flows, branches, joins, cycles, self-loops, multi-edges, disconnected stages, groups, partial UI metadata, and stale asynchronous results.
- Editor tests cover stage/edge CRUD, multiple routes, complete Inspector mappings, undo/redo, drag-stop persistence, and no dirty state from initial layout.
- V3 contract tests cover `ui.direction`, stable bend-point serialization, and compatibility with existing YAML.
- Version tests cover Draft, read-only Published View, version switching, Copy to Draft, and protection of the current published version.
- Use agent-browser against dev to verify Full, Research, ToB Goal, and a custom pipeline at 1366x768, 1440x900, and widescreen sizes.
- Verify the root and main path are visible on first load, loops do not cross nodes unnecessarily, Fit View includes every stage, and layout survives save and reload.
- Validate a 100-stage/200-edge fixture with layout under one second and responsive pan, zoom, selection, and dragging.
- Run `pnpm --filter vulseek test`, server and frontend typechecks, and `git diff --check`.

## Assumptions

- Visual editing covers the complete V3 contract; YAML remains an advanced and diagnostic interface.
- The default orientation is top-to-bottom, with an optional saved left-to-right orientation.
- Layout metadata is part of the published pipeline document but has no runtime meaning.
- Implementation and runtime verification operate only on dev; release is not modified or restarted.
