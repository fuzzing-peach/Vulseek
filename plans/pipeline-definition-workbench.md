# Pipeline Definition Workbench

## Summary

Replace the current long-form YAML editing experience with a unified pipeline definition workbench. A V3 pipeline remains one canonical YAML document for versioning, hashing, publishing, and Scan Job snapshots, but users edit it through three synchronized views:

- **Definition**: type-oriented structured editing for pipeline metadata, stages, edges, schemas, groups, and layout.
- **Visual**: a full-height React Flow topology editor with ELK layout and routed cyclic edges.
- **Raw YAML**: the existing CodeMirror editor, retained as an advanced and diagnostic interface.

All views operate on one local draft with shared diagnostics, selection, undo/redo, dirty state, and explicit **Save Draft** behavior. No runtime semantics, database schema, or published document format changes are required.

## Design Direction

The workbench should resemble a focused pipeline IDE rather than a dashboard made from nested cards. The persistent workspace uses a compact three-column structure:

```text
+----------------+----------------------+----------------------------------+
| Definition     | Entity list          | Entity editor                    |
|                |                      |                                  |
| Overview       | Search stages...     | Stage: Finding Review            |
| Stages      12 | Finding Discovery    | General | Runtime | Prompt | I/O |
| Edges       18 | Finding Review       |                                  |
| Schemas     24 | Track Review         | Structured fields and editors    |
| Groups       4 | ...                  |                                  |
| Layout         |                      |                                  |
+----------------+----------------------+----------------------------------+
| Diagnostics: 2 errors, 3 warnings                                        |
+---------------------------------------------------------------------------+
```

- The left rail switches entity types and displays counts and diagnostic badges.
- The middle pane provides searchable, keyboard-navigable entity lists; it is hidden for Overview and Layout.
- The right pane edits only the selected entity and uses compact tabs for complex types.
- The diagnostics panel is collapsible and focuses the referenced entity and field when selected.
- `Ctrl/Cmd+P` opens a shared quick switcher for stages, edges, schemas, groups, and diagnostics.
- On narrow screens, the three panes become drill-down screens with a visible back path rather than compressed columns.

## Third-Party Libraries

- Add `@rjsf/core`, `@rjsf/utils`, `@rjsf/validator-ajv8`, and the RJSF Shadcn theme. Use RJSF for ordinary scalar, enum, array, conditional, and validation-driven fields.
- Keep custom Vulseek widgets for stage references, schema references, agent profiles, prompt editors, route maps, artifacts, effects, JSON values, and destructive operations. RJSF is a field engine, not the page layout owner.
- Continue using the installed `@xyflow/react` and `elkjs` for the Visual view.
- Continue using the installed `cmdk` for quick navigation and the existing CodeMirror YAML editor for Raw YAML.
- Use the installed `yaml` package through `parseDocument()` and `Document` path operations so structured edits preserve comments, scalar styles, ordering, anchors, and untouched content as far as the library permits.
- Do not add React Arborist or a virtualization package initially. The navigation hierarchy is shallow and current entity counts do not justify the dependency. Introduce virtualization behind the list component only after measured rendering degradation, such as more than 200 visible entities.

## Definition Information Architecture

### Overview

Edit `name`, `description`, `supportedTargets`, `root`, and pipeline limits. Show a compact read-only summary of stage, edge, schema, and group counts, plus the current draft and published version state.

### Stages

List stages by stable ID, display name, mode, and group. Provide filters for mode, group, agent provider, and diagnostics. The editor is divided into:

- **General**: immutable ID, display name, role, description, group, and task naming.
- **Runtime**: mode, concurrency, persistence, container reuse, cwd, agent profile, skills, and plugins.
- **Prompt**: prompt template and prompt values with reference-aware completion.
- **Input / Output**: input schema, output schema, route envelope, and stage contracts.
- **Artifacts**: produced and consumed files, paths, and validation rules.
- **Effects**: pipeline effects and Research Registry operations.

Creating a stage requires an ID, name, role, and optional group. IDs become immutable after creation; rename changes the display name only. Deletion shows inbound/outbound references and requires explicit resolution.

### Edges

List edges as `source -> target`, with route and fan-out badges. Filters cover source, target, route type, and diagnostics. The editor includes General, Route, Transform, Artifacts, and Output Contract sections. Multiple edges between the same endpoints remain valid when IDs or routes differ.

### Schemas

List schema name, kind, usage count, and validation state. Provide two synchronized modes:

- **Form** for common JSON Schema properties, required fields, enums, arrays, and object members.
- **JSON Schema** for unrestricted CodeMirror editing of the selected schema only.

Show **Used by** and **References** lists. Selecting a reference navigates directly to the corresponding stage, edge, or schema. Do not attempt to turn arbitrary recursive JSON Schema into a fully visual form builder in the first release.

### Groups

Edit name, leader, members, and group-specific metadata. Show missing leaders, duplicate membership, and disconnected members inline. Group changes update Visual swimlanes but do not alter stage execution semantics beyond the existing V3 contract.

### Layout

Edit direction and inspect layout coverage. Provide **Apply ELK layout**, **Reset layout**, and **Clear edge routing** actions. Node coordinates and bend points are normally manipulated in Visual, not through raw numeric fields.

## Visual Workspace

- Give the editor a real full-height container and a collapsible, resizable Inspector.
- Replace handwritten longest-path positioning with ELK Layered, top-to-bottom by default, orthogonal routing, cycle handling, port constraints, groups, self-loops, and multi-edges.
- Restore saved `ui.nodes` and `ui.edges` metadata. Missing positions receive a temporary layout that does not dirty the draft until applied or dragged.
- Add Fit, Center Root, Auto Layout, direction, MiniMap, interaction lock, and Inspector controls.
- Support stage and edge CRUD, multi-select, copy/paste, keyboard deletion, and selection synchronization with Definition.
- Persist node positions only on drag stop. Ignore stale asynchronous layout results and refit after measurement or container resize.

## Editor State and YAML Synchronization

- Keep `rawYamlBuffer` as the canonical unsaved source and derive the parsed V3 model, YAML `Document`, diagnostics, indexes, and graph model from it.
- Replace full stable serialization for structured edits with typed patch operations such as `updateStage`, `updateEdge`, `setSchema`, and `moveNode`. Resolve array positions by stable entity ID at patch time, then apply the change to the YAML AST.
- Parse Raw YAML changes after the existing debounce. A valid document refreshes Definition and Visual atomically. Invalid YAML remains editable and preserves the user's text, while structured and visual mutation controls become read-only until syntax errors are fixed.
- Keep one cross-view undo/redo history. Coalesce rapid text edits and field typing, but record stage, edge, schema, group, and layout operations as semantic history entries.
- Preserve comments and formatting where practical. Warn once before the first structured mutation that the touched YAML subtree may be normalized; never silently replace an invalid raw buffer with the last valid model.
- Save only after full syntax and V3 validation succeeds. `Ctrl/Cmd+S` and **Save Draft** use the same action.

## Implementation Phases

### Phase 1: Workspace Foundation

- Introduce `Definition | Visual | Raw YAML` tabs and the full-height editor shell.
- Add shared selection, diagnostics navigation, dirty state, Save Draft, undo/redo, and quick switcher.
- Add YAML `Document` parsing and typed patch infrastructure while preserving current API behavior.
- Implement Overview and read-only categorized lists before enabling mutations.

### Phase 2: Structured Definition Editing

- Add RJSF with Vulseek Shadcn templates and widgets.
- Implement Stage, Edge, Group, and Layout editors.
- Implement schema Form/JSON modes and cross-reference navigation.
- Add create, duplicate, and safe-delete flows with inline validation.

### Phase 3: Visual Editing

- Implement the existing React Flow + ELK visual editor plan on top of the shared patch model.
- Add complete stage/edge inspectors, group swimlanes, routed loops, saved layout, and keyboard interactions.
- Synchronize selection and navigation across Definition, Visual, diagnostics, and Raw YAML source ranges.

### Phase 4: Version and Polish

- Fix published-version selection and provide a read-only Published View with **Copy to Draft**.
- Add responsive drill-down behavior, accessibility, loading states, empty states, and unsaved-change protection.
- Measure large-document performance and add list virtualization only if necessary.

## Testing

- YAML synchronization tests cover comments, ordering, quoted and block scalars, anchors, invalid intermediate input, entity-ID lookup, subtree normalization, and undo/redo across all three views.
- Structured editor tests cover every V3 field, custom widgets, conditional fields, references, CRUD, duplicate IDs, safe deletion, and diagnostics focus.
- Layout tests cover linear flows, branches, joins, cycles, self-loops, multi-edges, disconnected stages, groups, partial UI metadata, and stale ELK results.
- Version tests cover Draft, published versions, switching, read-only protection, Copy to Draft, and explicit save semantics.
- Performance tests use the existing large generated pipelines plus a 100-stage/200-edge fixture. Initial parsing and layout should remain under one second on the dev host, and ordinary field edits should not re-render the full entity list or canvas.
- Use agent-browser on dev to verify Full Scan, Delta Scan, Research, ToB Goal, and a custom pipeline at desktop, laptop, and narrow viewport sizes. Check keyboard navigation, source synchronization, diagnostics, save/reload, console errors, and failed requests.
- Run `pnpm --filter vulseek test`, `pnpm --filter @vulseek/server typecheck`, `pnpm --filter vulseek typecheck`, and `git diff --check`.

## Assumptions

- V3 YAML remains the single portable and publishable pipeline representation; the UI does not split it into multiple persisted files.
- Structured editing covers the complete V3 contract, but arbitrary JSON Schema and free-form JSON retain focused code editors where a generated form would be misleading.
- UI metadata remains optional and has no runtime meaning.
- Implementation and browser verification operate only on dev. Release is not connected, modified, or restarted.
