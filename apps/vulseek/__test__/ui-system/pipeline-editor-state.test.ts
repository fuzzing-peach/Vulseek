import { describe, expect, it } from "vitest";
import {
	canPublish,
	initialEditorState,
	isDirty,
	pipelineEditorReducer,
	validDocument,
} from "@/lib/pipeline-editor/pipeline-editor-state";

const VALID_YAML = `version: 3
name: test
supportedTargets:
  - project
root: start
limits:
  maxTasks: 100
  maxDurationSeconds: 3600
schemas: {}
stages:
  start:
    name: Start
    role: scan
    group: g
    mode: serial
    concurrency: 1
    runtime:
      prompt: Do the thing.
edges: []
groups: []
`;

describe("initialEditorState", () => {
	it("accepts a valid document", () => {
		const state = initialEditorState(VALID_YAML);
		expect(state.status.kind).toBe("valid");
		if (state.status.kind === "valid") {
			expect(state.status.stale).toBe(false);
		}
		expect(validDocument(state)?.root).toBe("start");
		expect(isDirty(state)).toBe(false);
	});

	it("treats unparseable YAML as invalid with diagnostics", () => {
		const state = initialEditorState("version: 3\nstages:\n  start:\n    name: [broken");
		expect(state.status.kind).toBe("invalid");
		expect(validDocument(state)).toBeNull();
		expect(canPublish(state)).toBe(false);
	});

	it("runs semantic validation from initial load (unused schemas visible)", () => {
		// A document with an unreferenced schema must surface the warning on
		// initial load — never hidden until the first canvas action.
		const yaml = `version: 3
name: test
supportedTargets:
  - project
root: start
limits:
  maxTasks: 100
  maxDurationSeconds: 3600
schemas:
  unused-schema:
    type: object
stages:
  start:
    name: Start
    role: scan
    group: g
    mode: serial
    concurrency: 1
    runtime:
      prompt: Do the thing.
edges: []
groups: []
`;
		const state = initialEditorState(yaml);
		expect(state.status.kind).toBe("valid");
		expect(
			state.diagnostics.some(
				(d) => d.severity === "warning" && d.code === "schema.unused",
			),
		).toBe(true);
	});

	it("keeps diagnostics stable across a no-op canvas action", () => {
		const yaml = `version: 3
name: test
supportedTargets:
  - project
root: start
limits:
  maxTasks: 100
  maxDurationSeconds: 3600
schemas:
  unused-schema:
    type: object
stages:
  start:
    name: Start
    role: scan
    group: g
    mode: serial
    concurrency: 1
    runtime:
      prompt: Do the thing.
edges: []
groups: []
`;
		let state = initialEditorState(yaml);
		const before = state.diagnostics.length;
		const document = validDocument(state)!;
		state = pipelineEditorReducer(state, {
			type: "canvasModified",
			document: { ...document, name: document.name },
		});
		expect(state.diagnostics.length).toBe(before);
	});
});

describe("pipelineEditorReducer", () => {
	it("marks the canvas stale when the buffer no longer parses", () => {
		let state = initialEditorState(VALID_YAML);
		state = pipelineEditorReducer(state, {
			type: "setBuffer",
			yaml: "version: 3\nstages: {broken",
		});
		expect(state.status.kind).toBe("valid");
		if (state.status.kind === "valid") {
			expect(state.status.stale).toBe(true);
		}
		// the last valid document stays available for the canvas
		expect(validDocument(state)?.root).toBe("start");
		expect(canPublish(state)).toBe(false);
	});

	it("recovers when the buffer parses again", () => {
		let state = initialEditorState(VALID_YAML);
		state = pipelineEditorReducer(state, { type: "setBuffer", yaml: "broken" });
		if (state.status.kind === "valid") {
			expect(state.status.stale).toBe(true);
		}
		state = pipelineEditorReducer(state, { type: "setBuffer", yaml: VALID_YAML });
		expect(state.status.kind === "valid" && state.status.stale).toBe(false);
		expect(canPublish(state)).toBe(true);
	});

	it("re-serializes the buffer on the first canvas edit (stable serialization)", () => {
		let state = initialEditorState(VALID_YAML);
		const document = validDocument(state)!;
		state = pipelineEditorReducer(state, {
			type: "canvasModified",
			document: {
				...document,
				stages: {
					...document.stages,
					start: {
						...document.stages.start!,
						name: "Renamed",
					},
				},
			},
		});
		expect(state.canvasTouched).toBe(true);
		expect(state.rawYamlBuffer).toContain("Renamed");
		// the serialized buffer parses back to the same document
		const reparsed = validDocument(state);
		expect(reparsed?.stages.start?.name).toBe("Renamed");
		expect(isDirty(state)).toBe(true);
	});

	it("undoes and redoes buffer edits", () => {
		let state = initialEditorState(VALID_YAML);
		state = pipelineEditorReducer(state, {
			type: "setBuffer",
			yaml: `${VALID_YAML.trim()}\n# first edit\n`,
		});
		state = pipelineEditorReducer(state, {
			type: "setBuffer",
			yaml: `${VALID_YAML.trim()}\n# second edit\n`,
		});
		expect(state.rawYamlBuffer).toContain("# second edit");

		state = pipelineEditorReducer(state, { type: "undo" });
		expect(state.rawYamlBuffer).toContain("# first edit");
		expect(state.rawYamlBuffer).not.toContain("# second edit");

		state = pipelineEditorReducer(state, { type: "redo" });
		expect(state.rawYamlBuffer).toContain("# second edit");

		// Undo at the beginning is a no-op.
		state = pipelineEditorReducer(state, { type: "undo" });
		state = pipelineEditorReducer(state, { type: "undo" });
		state = pipelineEditorReducer(state, { type: "undo" });
		expect(state.rawYamlBuffer).toContain("version: 3");
		state = pipelineEditorReducer(state, { type: "redo" });
		state = pipelineEditorReducer(state, { type: "redo" });
		state = pipelineEditorReducer(state, { type: "redo" });
		expect(state.rawYamlBuffer).toContain("# second edit");
	});

	it("tracks dirty state against the saved YAML", () => {
		let state = initialEditorState(VALID_YAML);
		state = pipelineEditorReducer(state, {
			type: "setBuffer",
			yaml: `${VALID_YAML.trim()}\n# comment\n`,
		});
		expect(isDirty(state)).toBe(true);
		state = pipelineEditorReducer(state, {
			type: "setSavedYaml",
			yaml: state.rawYamlBuffer,
			draftRevision: 1,
		});
		expect(isDirty(state)).toBe(false);
	});

	it("ignores an identical canvas change (no history, no dirty)", () => {
		let state = initialEditorState(VALID_YAML);
		const document = validDocument(state)!;
		const before = state.history.length;
		// Serializing the *same* document must not dirty the draft or grow
		// history — this is what an identical Apply Layout dispatches.
		state = pipelineEditorReducer(state, {
			type: "canvasModified",
			document: { ...document, name: document.name },
		});
		expect(state.rawYamlBuffer).toBe(VALID_YAML);
		expect(state.history.length).toBe(before);
		expect(isDirty(state)).toBe(false);
		expect(state.canvasTouched).toBe(false);
	});

	it("records history once for a changed canvas edit", () => {
		let state = initialEditorState(VALID_YAML);
		const document = validDocument(state)!;
		const before = state.history.length;
		state = pipelineEditorReducer(state, {
			type: "canvasModified",
			document: {
				...document,
				stages: {
					...document.stages,
					start: { ...document.stages.start!, name: "Renamed" },
				},
			},
		});
		expect(state.history.length).toBe(before + 1);
		expect(isDirty(state)).toBe(true);
	});
});
