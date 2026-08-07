# PPL Visual Canvas Remediation

## Summary

Rebuild the PPL Visual canvas around a display graph that is separate from the persisted V3 execution graph. Preserve every original stage and edge for runtime compilation, editing, YAML serialization, and publishing, while deriving a readable graph for React Flow:

- root-first, top-to-bottom layout by default;
- forward edges define the main progression;
- feedback edges use dedicated side lanes to form visible local loops;
- edges with the same source and target render as one path with combined route labels;
- every directed path has an arrow and remains keyboard-selectable;
- Inspector, Minimap, diagnostics, and viewport changes cannot obscure the graph.

This plan addresses the browser findings from Full Scan and Research PPL. It is the Visual implementation track of `pipeline-definition-workbench.md`; it does not introduce the structured Definition editor or RJSF yet.

## Observed Problems

- At `780x437`, the open Inspector leaves a `46x207` canvas and creates page-level horizontal scrolling.
- At `1440x900`, Full Scan Fit View scales nodes to about `70x19`, making labels unreadable.
- Research Minimap covers `vulnerability-discovery` in the initial fitted viewport.
- Research has 23 persisted edges, but only three display arrowheads and none display route labels.
- The three `track-review -> track-plan` edges have identical SVG paths and cannot be individually reached by pointer or keyboard.
- Feedback edges influence ELK ranking, placing root and Review stages on the same top layer instead of showing local review loops.
- Inspector open/close changes the canvas width without a container resize refit.
- Apply Layout can appear to do nothing, reveal 45 previously hidden warnings, and leave the Save button showing `Saved`.
- Stage cards use `rounded-xl`, which makes compact workflow nodes look overly soft and reduces the distinction between the node body and pill-shaped route labels.
- All four React Flow handles are permanently visible as white hollow circles. They interrupt the stage border, resemble punched holes, and compete with the stage title and role.
- The transient preview currently keeps computed node positions but can discard computed edge bend points. Feedback edges then fall back to center-line elbows and cross intermediate stage rectangles.
- Feedback bend points include source/target-side coordinates while `buildEdgePath()` also adds the actual React Flow endpoints. Combined with top/bottom handles being used for side-routed feedback edges, this can create extra segments through the source or target card.
- dev HMR history contains React Flow provider and initialization failures. Current source already wraps `CanvasEditorInner` in `ReactFlowProvider`, so a clean restart must distinguish stale HMR failures from reproducible source failures.

## Display Graph Model

Add `pipeline-display-graph.ts` under `apps/vulseek/lib/pipeline-editor/`.

### Display Nodes

Keep one display node per V3 stage. Derive a deterministic stage rank from:

1. the configured root;
2. stage declaration order in the YAML document;
3. forward reachability from the root;
4. stable stage ID as the final tie-breaker.

Do not hardcode Full Scan or Research stage names.

### Forward and Feedback Edges

Classify an edge as forward when its target rank is greater than its source rank. An edge to the same or an earlier rank is a feedback edge. Reciprocal and short-cycle edges therefore become explicit loop returns without allowing them to reorder the main progression.

Use forward edges as ELK ranking constraints. Route feedback edges after node placement through deterministic side lanes:

- `DOWN`: source/target side ports and vertical lanes outside the affected node span;
- `RIGHT`: source/target top or bottom ports and horizontal lanes;
- overlapping feedback spans receive separate lane offsets;
- lane selection minimizes intersections with node rectangles and existing labels.

Long feedback routes remain visible but do not force unrelated stages into the same layer.

### Parallel Edge Groups

Group persisted edges by `(from, to)` for display only:

```ts
type PipelineDisplayEdge = {
	id: string;
	from: string;
	to: string;
	memberEdgeIds: string[];
	labels: Array<{
		edgeId: string;
		label: string;
		isDefault: boolean;
	}>;
	kind: "forward" | "feedback";
	bendPoints: Array<{ x: number; y: number }>;
};
```

- Prefer `edge.route.key`, then the edge name, then `default` as the visible label.
- Render one path and one label cluster such as `continue / exhausted / blocked`.
- Clicking the path selects the primary/default member. Clicking an individual label selects that original edge in the Inspector.
- Keyboard focus and Enter/Space must provide the same behavior.
- The Inspector shows all sibling routes for the selected source/target and lets the user switch between them.
- Creating, deleting, or editing still operates on original V3 edges. Runtime compilation never sees display groups.

When ELK produces one grouped path, replicate its bend points into each member's existing `ui.edges[edgeId]` entry when layout is explicitly applied. No database migration is needed.

## Layout and Routing

Refactor `pipeline-layout.ts` into explicit stages:

1. `buildPipelineDisplayGraph(document)` creates ranks and grouped edges.
2. `computeForwardLayout(displayGraph, direction)` runs ELK Layered on forward edges only.
3. `routeForwardEdges(...)` consumes ELK sections.
4. `routeFeedbackEdges(...)` allocates side lanes around node bounds.
5. `expandPersistedEdgeLayout(...)` maps display bend points back to original edge IDs.

Use ELK node and layer spacing that keeps labels readable at normal laptop sizes. Preserve deterministic output for identical input. Root must occupy the first layer; unreachable components appear after the reachable graph in stable order.

Add optional `ui.layoutVersion` to the V3 UI schema and set `CURRENT_PIPELINE_LAYOUT_VERSION = 2`:

- layouts without this version are treated as legacy;
- legacy or incomplete saved positions are ignored for the initial transient preview;
- previewed ELK positions do not dirty the draft;
- Apply Layout or node drag persists `layoutVersion`, direction, node positions, and edge bend points;
- node drag preserves unaffected `ui.edges` entries and recomputes only routes affected by the moved node;
- runtime compilation continues to ignore all `ui` fields.

This prevents stale horizontal positions from overriding the new top-to-bottom layout.

The transient preview must retain both parts of the layout result:

```ts
type TransientPipelineLayout = {
	nodes: Record<string, { x: number; y: number }>;
	edges: Record<string, { bendPoints: Array<{ x: number; y: number }> }>;
};
```

Render transient edge bend points immediately on first open. Applying or previewing ELK must not be required before feedback routes avoid node interiors. Bend points contain intermediate orthogonal points only; source and target endpoints are added exactly once by the edge renderer.

## Stage Node and Handle Styling

Make stage nodes feel like compact engineering objects rather than rounded cards:

- change the stage body from `rounded-xl` to `rounded-lg` (target computed radius: `8px`);
- keep the background opaque and the node above edge layers, but do not use node fill as a substitute for correct edge routing;
- retain pill geometry only for route labels and small status badges;
- reduce the node shadow one level so the border, role color, and graph structure carry the hierarchy.

Keep four directional handles for authoring, but make them contextual:

- default: visually hidden, with edges appearing to terminate directly at the node border;
- node hover or selection: reveal a `6px` solid handle using the stage role color, without a white center;
- active connection: enlarge to `8px` with a restrained focus ring;
- valid target: use a solid success color; invalid target: use a low-contrast neutral state;
- preserve an approximately `18px` transparent hit target so visual reduction does not make connections difficult to drag;
- read-only and published views do not render handles.

Assign handles by route geometry instead of exposing four interchangeable anchors:

- forward edge: bottom source to top target in `DOWN`, right source to left target in `RIGHT`;
- left feedback lane: left source to left target;
- right feedback lane: right source to right target;
- self-loop: a dedicated side pair selected deterministically.

Handle centers must sit exactly on the stage border. The renderer must not leave a white gap between an edge and the card.

## Edge Rendering and Selection

Update `canvas-editor.tsx`:

- Assign `MarkerType.ArrowClosed` to every directed display edge, not only `fanOut` edges.
- Render labels with `EdgeLabelRenderer`; place the label on the longest safe orthogonal segment and keep it above edge hit areas.
- Give selected and hovered edges distinct strokes while retaining role-neutral colors.
- Set source and target handles according to forward/feedback routing.
- Feed transient and persisted bend points through the same display-edge path so first-open routing matches saved routing.
- Keep edges below nodes and route labels above edge hit areas; hiding an intersection behind an opaque card does not count as avoiding it.
- Pass the current editor selection into `CanvasEditor` so external label selection and Inspector selection remain synchronized.
- Use semantic buttons for grouped route labels with visible focus rings and pointer-safe `nodrag nopan` classes.
- Keep `nodeTypes` and `edgeTypes` at module scope and keep all `useReactFlow()` calls below `ReactFlowProvider`.

Add an error boundary around the canvas body. It should show a concise reload action and preserve Raw YAML access rather than taking down the complete Pipeline page.

## Responsive Workspace and Viewport

Update `[pipelineId].tsx` and `canvas-editor.tsx`:

- Desktop Inspector width defaults to `360px`, can be resized within `300-480px`, and is stored locally per user. Implement the drag handle locally; do not add another layout dependency.
- Below `1100px`, Inspector becomes an overlay sheet and defaults closed. It must not reduce the canvas below `480px`.
- Compact header actions into an overflow menu when width is constrained; keep Save/Publish state visible.
- Observe the actual canvas element with `ResizeObserver`, not only `window.resize`.
- After Inspector resize/toggle, diagnostics expansion, sidebar toggle, node measurement, or layout completion, wait for two animation frames and then recompute the viewport.
- Do not automatically Fit All below readable scale. Initial view fits the root and primary forward path with a target minimum zoom of `0.55`; explicit **Fit all** may zoom farther out.
- Keep **Center root** as a separate action and rename ambiguous controls with tooltips and accessible labels.

Make the Minimap collapsible:

- hide it by default below `1000px` canvas width;
- reserve its `216x166` safe area in initial and Fit All calculations when visible;
- never allow an initially fitted node or route label under the Minimap;
- preserve pan/zoom behavior when expanded.

## Editor State and Diagnostics

Update `pipeline-editor-state.ts` so every entry path uses the same analysis function:

- initial load, Raw YAML edits, undo/redo, canvas edits, reset, and version changes all run parse plus semantic validation;
- diagnostics for unchanged YAML cannot jump after the first canvas action;
- invalid or stale YAML keeps Raw YAML editable but makes Visual mutation controls read-only with a visible stale-document banner;
- Apply Layout dispatches only when its serialized document differs from the current buffer;
- an identical layout does not create history or dirty the draft;
- transient layout and viewport changes never enter history.

Fix save synchronization in `[pipelineId].tsx`: when CodeMirror is flushed immediately before save, use `yamlToSave` for both the request and the saved baseline instead of the pre-flush reducer buffer.

Diagnostics selection must:

- open the relevant Inspector when necessary;
- select and center the referenced stage or edge;
- switch to Raw YAML and reveal the source location when no visual entity exists.

The 45 unused-schema warnings are a real semantic result in the current generated document and must either be visible from initial load or removed by a separate schema-pruning change. This canvas work must not hide them conditionally.

## Concrete File Changes

- `apps/vulseek/lib/pipeline-editor/pipeline-display-graph.ts`: ranks, forward/feedback classification, parallel grouping, label derivation, and selection mapping.
- `apps/vulseek/lib/pipeline-editor/pipeline-layout.ts`: forward-only ELK placement, feedback lane routing, safe bounds, deterministic expansion to persisted edge UI.
- `apps/vulseek/components/dashboard/pipelines/canvas-editor.tsx`: grouped edge rendering, arrows, labels, selection, compact `8px` stage corners, contextual solid handles, route-specific handle IDs, preservation of unaffected edge UI during node drag, ResizeObserver, readable viewport policy, Minimap behavior, and canvas error boundary.
- `apps/vulseek/components/dashboard/pipelines/pipeline-inspector.tsx`: sibling route switcher and compact edge-group context.
- `apps/vulseek/pages/dashboard/pipelines/[pipelineId].tsx`: responsive/resizeable Inspector, header overflow, selection plumbing, stale mode, and save baseline fix.
- `apps/vulseek/lib/pipeline-editor/pipeline-editor-state.ts`: unified diagnostics and no-op layout/history handling.
- `packages/server/src/services/scan/pipeline/document-v3/pipeline-document-v3.ts`: optional `ui.layoutVersion` validation.
- Existing UI and contract tests, plus focused display-graph and canvas interaction tests.

## Implementation Order

1. Add display-graph derivation and pure unit tests.
2. Refactor ELK input and feedback routing; update layout contract tests.
3. Render grouped edges, arrows, labels, and keyboard selection.
4. Add `layoutVersion` and legacy-layout transient migration behavior.
5. Implement ResizeObserver, readable initial viewport, Minimap safe area, and responsive Inspector.
6. Unify diagnostics and dirty/history semantics.
7. Add error boundary and run a clean dev restart to separate stale HMR errors from current failures.
8. Perform agent-browser regression testing and adjust spacing from screenshots.

## Test Plan

### Pure Graph and Layout Tests

- Linear, branch, join, disconnected, self-loop, reciprocal pair, three-stage cycle, and long feedback route.
- Research-shaped fixture without hardcoded stage IDs: root remains first, validation/review pairs form local loops, and report remains terminal.
- Three same-endpoint routes produce one display edge and three member labels.
- Every original edge maps to exactly one display group and recovers persisted bend points.
- Node rectangles and route-label bounds do not intersect routed edge interiors outside their endpoints.
- Transient first-open layout and persisted Apply Layout produce equivalent edge geometry.
- Feedback bend points exclude source and target endpoints and use the handle pair selected for that route.
- Moving one node preserves unrelated persisted edge bend points and reroutes affected edges only.
- Repeated layout of the same document is byte-for-byte deterministic.
- Legacy, partial, and current-version UI metadata resolve correctly.

### Editor State and Component Tests

- Initial and post-edit diagnostics are identical for unchanged YAML.
- Preview layout is clean; changed Apply Layout is dirty; identical Apply Layout is a no-op.
- Invalid Raw YAML cannot be overwritten through Visual.
- Every display edge has an arrow.
- Stage nodes use an `8px` computed border radius; route badges remain pills.
- Handles are hidden by default, become solid role-colored points on hover/selection, retain a large hit target, and are absent in read-only mode.
- Grouped path click, route-label click, Tab, Enter, and Space select the expected original edge.
- Inspector sibling route switching does not edit the wrong route.
- Inspector toggle and resize trigger one settled refit rather than overlapping fits.
- Minimap visibility and safe-area behavior follow canvas width.
- Canvas errors fall back without hiding Raw YAML.

### Browser Acceptance

Use agent-browser against dev after a clean restart. Test Full Scan, Research, ToB Goal, Delta Scan, and a custom pipeline at:

- `1440x900` with Inspector open and closed;
- `1366x768` with Inspector open;
- `780x437` with overlay Inspector;
- a wide desktop viewport.

Verify:

- canvas width never collapses and the page has no horizontal scrollbar;
- initial visible node size is at least approximately `132x52`;
- root and primary progression are readable on first open;
- Research loops are local and arrows make direction unambiguous;
- sample every rendered SVG path with `getPointAtLength()` and verify that no interior point intersects a non-endpoint stage bounding rectangle;
- verify first-open feedback paths already use side lanes before Apply Layout is clicked;
- verify stage `border-radius` computes to `8px` and no white hollow handles are visible at rest;
- hover, select, and start a connection from each side of a stage; verify the solid handle state and practical hit area;
- verify published/read-only Visual renders no connection handles;
- `continue / exhausted / blocked` share one path but remain individually selectable;
- no initially fitted node or label is under the Minimap or Inspector;
- Apply Layout updates the draft exactly once and survives save/reload;
- dragging a stage and saving does not remove bend points for unrelated edges;
- diagnostics do not change merely because Visual was opened;
- no React Flow provider, initialization, hydration, console, or failed-request errors occur.

Capture before/after screenshots and record interactive evidence for Inspector resize, grouped-edge selection, direction switching, Apply Layout, undo, and reload.

Run:

```bash
pnpm --filter vulseek test
pnpm --filter @vulseek/server typecheck
pnpm --filter vulseek typecheck
git diff --check
```

## Acceptance Criteria

- Full Scan and Research are readable without an immediate manual zoom or Inspector close.
- All persisted edges remain represented; every visual path has direction and meaningful labels.
- Same-endpoint conditions are visually merged without losing individual editing or accessibility.
- Feedback routes communicate local loops and do not reorder the main pipeline progression.
- No edge crosses a non-endpoint stage rectangle, including on first open before any layout action.
- Stage nodes use compact `8px` corners; connection handles are unobtrusive at rest, solid during interaction, and absent in read-only mode.
- Responsive layouts cannot collapse, cover, or horizontally overflow the canvas.
- Layout, dirty state, history, diagnostics, save, and reload remain consistent.
- Runtime compilation and Scan Job execution are unchanged.

## Assumptions

- V3 YAML remains the canonical pipeline representation.
- Parallel-edge merging is presentation-only; original edge IDs and route semantics remain unchanged.
- Stage declaration order is intentional authoring order and is a valid stable hint for forward progression.
- UI metadata remains optional and ignored by runtime compilation.
- Work and runtime validation are dev-only; release is not connected, modified, or restarted.
