import { describe, expect, it } from "vitest";
import {
	initialEditorState,
	isDirty,
	pipelineEditorReducer,
	validDocument,
} from "@/lib/pipeline-editor/pipeline-editor-state";

// Commented V3 fixture so tests can assert that typed patches preserve
// untouched text through the reducer.
const VALID_YAML = `version: 3
name: test # pipeline comment
supportedTargets:
  - project
root: start
limits:
  maxTasks: 100
  maxDurationSeconds: 3600
schemas:
  finding:
    type: object
stages:
  start:
    name: Start # stage comment
    role: scan
    group: g
    mode: serial
    concurrency: 1
    runtime:
      prompt: Do the thing.
  review:
    name: Review
    role: verification
    group: g
    mode: serial
    concurrency: 1
    runtime:
      prompt: Review it.
edges:
  - id: start-to-review
    name: Hand off
    from: start
    to: review
    mode: map
groups: []
`;

describe("pipelineEditorReducer — typed patch", () => {
	it("applies a typed patch and preserves untouched comments", () => {
		let state = initialEditorState(VALID_YAML);
		state = pipelineEditorReducer(state, {
			type: "patch",
			ops: [
				{
					op: "updateStage",
					stageId: "review",
					stage: {
						name: "Review v2",
						role: "verification",
						group: "g",
						mode: "serial",
						concurrency: 2,
						runtime: { kind: "agent", prompt: "Review it harder.", prepareRepository: "none", includePolicy: false, plugins: [] }, disableable: true, inputArtifacts: [], outputArtifacts: [], effects: [], containerNameParts: [], allowAgentExit: false, promptValues: {},
					},
				},
			],
			key: "stage:review:general",
		});
		expect(state.status.kind).toBe("valid");
		expect(validDocument(state)?.stages.review?.concurrency).toBe(2);
		expect(state.rawYamlBuffer).toContain("# pipeline comment");
		expect(state.rawYamlBuffer).toContain("# stage comment");
		expect(state.rawYamlBuffer).toContain("name: Start # stage comment");
		expect(state.patchError).toBeNull();
	});

	it("fails cleanly when the buffer is invalid intermediate input", () => {
		let state = initialEditorState(VALID_YAML);
		state = pipelineEditorReducer(state, {
			type: "setBuffer",
			yaml: "version: 3\nstages:\n  start:\n    name: [broken",
		});
		expect(state.status.kind).toBe("valid");
		if (state.status.kind === "valid") {
			// A previously valid buffer that stops parsing stays renderable
			// but stale: the canvas keeps the last valid document read-only.
			expect(state.status.stale).toBe(true);
		}
		const brokenBuffer = state.rawYamlBuffer;
		state = pipelineEditorReducer(state, {
			type: "patch",
			ops: [{ op: "updateOverview", overview: { name: "x" } }],
		});
		// Buffer untouched, error surfaced, no history entry.
		expect(state.rawYamlBuffer).toBe(brokenBuffer);
		expect(state.patchError).not.toBeNull();
		expect(state.historyIndex).toBe(1);
	});

	it("clears patchError on the next successful patch", () => {
		let state = initialEditorState("not: [valid");
		state = pipelineEditorReducer(state, {
			type: "patch",
			ops: [{ op: "resetLayout" }],
		});
		expect(state.patchError).not.toBeNull();
		state = pipelineEditorReducer(state, { type: "reset", yaml: VALID_YAML, draftRevision: 0 });
		state = pipelineEditorReducer(state, {
			type: "patch",
			ops: [{ op: "updateOverview", overview: { name: "renamed" } }],
		});
		expect(state.patchError).toBeNull();
	});

	it("does not dirty or create history for an identical patch", () => {
		let state = initialEditorState(VALID_YAML);
		state = pipelineEditorReducer(state, {
			type: "patch",
			ops: [{ op: "updateOverview", overview: { name: "test" } }],
		});
		expect(state.rawYamlBuffer).toBe(VALID_YAML);
		expect(isDirty(state)).toBe(false);
		expect(state.history).toEqual([VALID_YAML]);
	});

	it("does not dirty or create history for an identical layout patch", () => {
		const withLayout = `${VALID_YAML}ui:
  layoutVersion: 3
  nodes:
    start: { x: 1, y: 2 }
`;
		let state = initialEditorState(withLayout);
		state = pipelineEditorReducer(state, {
			type: "patch",
			ops: [
				{
					op: "updateLayout",
					layout: { nodes: { start: { x: 1, y: 2 } } },
				},
			],
		});
		expect(state.rawYamlBuffer).toBe(withLayout);
		expect(isDirty(state)).toBe(false);
	});
});

describe("pipelineEditorReducer — coalescing and history", () => {
	it("coalesces consecutive same-key field patches into one history entry", () => {
		let state = initialEditorState(VALID_YAML);
		const patchName = (name: string) =>
			pipelineEditorReducer(state, {
				type: "patch",
				ops: [
					{
						op: "updateStage",
						stageId: "start",
						stage: {
							name,
							role: "scan",
							group: "g",
							mode: "serial",
							concurrency: 1,
							runtime: { kind: "agent", prompt: "Do the thing.", prepareRepository: "none", includePolicy: false, plugins: [] }, disableable: true, inputArtifacts: [], outputArtifacts: [], effects: [], containerNameParts: [], allowAgentExit: false, promptValues: {},
						},
					},
				],
				key: "stage:start:name",
			});
		state = patchName("A");
		state = patchName("AB");
		state = patchName("ABC");
		expect(state.historyIndex).toBe(1);
		expect(state.history).toHaveLength(2);
		// One undo restores the original.
		state = pipelineEditorReducer(state, { type: "undo" });
		expect(validDocument(state)?.stages.start?.name).toBe("Start");
		// Redo restores the coalesced result.
		state = pipelineEditorReducer(state, { type: "redo" });
		expect(validDocument(state)?.stages.start?.name).toBe("ABC");
	});

	it("records semantic add/delete ops as separate history entries", () => {
		let state = initialEditorState(VALID_YAML);
		state = pipelineEditorReducer(state, {
			type: "patch",
			ops: [
				{
					op: "addStage",
					stageId: "triage",
					stage: {
						name: "Triage",
						role: "analysis",
						group: "g",
						mode: "serial",
						concurrency: 1,
						runtime: { kind: "agent", prompt: "Triage.", prepareRepository: "none", includePolicy: false, plugins: [] }, disableable: true, inputArtifacts: [], outputArtifacts: [], effects: [], containerNameParts: [], allowAgentExit: false, promptValues: {},
					},
				},
			],
		});
		state = pipelineEditorReducer(state, {
			type: "patch",
			ops: [
				{
					op: "addEdge",
					edge: { id: "review-to-triage", name: "Next", from: "review", to: "triage", mode: "map", fork: false, artifacts: [] },
				},
			],
		});
		expect(state.history).toHaveLength(3);
		state = pipelineEditorReducer(state, { type: "undo" });
		expect(validDocument(state)?.edges).toHaveLength(1);
		state = pipelineEditorReducer(state, { type: "undo" });
		expect(validDocument(state)?.stages.triage).toBeUndefined();
	});

	it("shares one history across Definition patches and Raw YAML edits", () => {
		let state = initialEditorState(VALID_YAML);
		// Raw YAML text edit.
		state = pipelineEditorReducer(state, {
			type: "setBuffer",
			yaml: VALID_YAML.replace("name: test # pipeline comment", "name: text-edit"),
		});
		// Definition patch.
		state = pipelineEditorReducer(state, {
			type: "patch",
			ops: [{ op: "updateOverview", overview: { name: "patched" } }],
		});
		// Undo across views: back to the text edit, then back to the original.
		state = pipelineEditorReducer(state, { type: "undo" });
		expect(validDocument(state)?.name).toBe("text-edit");
		state = pipelineEditorReducer(state, { type: "undo" });
		expect(validDocument(state)?.name).toBe("test");
	});

	it("stops coalescing after a canvas edit", () => {
		let state = initialEditorState(VALID_YAML);
		state = pipelineEditorReducer(state, {
			type: "patch",
			ops: [{ op: "updateOverview", overview: { name: "canvas-1" } }],
			key: "overview:name",
		});
		const document = validDocument(state)!;
		state = pipelineEditorReducer(state, {
			type: "canvasModified",
			document: { ...document, description: "touched on canvas" },
		});
		state = pipelineEditorReducer(state, {
			type: "patch",
			ops: [{ op: "updateOverview", overview: { name: "canvas-2" } }],
			key: "overview:name",
		});
		expect(state.history).toHaveLength(4);
		expect(state.canvasTouched).toBe(true);
	});
});

describe("Definition / Visual synchronization", () => {
	it("patch (Definition) and canvasModified (Visual) converge on the same document", () => {
		let state = initialEditorState(VALID_YAML);
		state = pipelineEditorReducer(state, {
			type: "patch",
			ops: [
				{
					op: "updateStage",
					stageId: "review",
					stage: {
						name: "Renamed",
						role: "verification",
						group: "g",
						mode: "serial",
						concurrency: 1,
						runtime: { kind: "agent", prompt: "Review it.", prepareRepository: "none", includePolicy: false, plugins: [] }, disableable: true, inputArtifacts: [], outputArtifacts: [], effects: [], containerNameParts: [], allowAgentExit: false, promptValues: {},
					},
				},
			],
		});
		const afterPatch = validDocument(state)!;

		// A canvas edit of the same document is a semantic no-op: the buffer
		// (and its comments) survive.
		let visualState = initialEditorState(VALID_YAML);
		visualState = pipelineEditorReducer(visualState, {
			type: "canvasModified",
			document: afterPatch,
		});
		const afterVisual = validDocument(visualState)!;
		expect(afterPatch).toEqual(afterVisual);
		// The patch path preserved the comment; the canvas path rewrote it
		// (stable serialization) — both describe the same pipeline.
		expect(state.rawYamlBuffer).toContain("# pipeline comment");
		expect(validDocument(state)?.stages.review?.name).toBe("Renamed");
		expect(visualState.rawYamlBuffer).toContain("name: Renamed");
	});

	it("canvas edits refresh the Definition view atomically", () => {
		let state = initialEditorState(VALID_YAML);
		const document = validDocument(state)!;
		state = pipelineEditorReducer(state, {
			type: "canvasModified",
			document: {
				...document,
				stages: {
					...document.stages,
					review: { ...document.stages.review!, concurrency: 7 },
				},
			},
		});
		expect(validDocument(state)?.stages.review?.concurrency).toBe(7);
		expect(isDirty(state)).toBe(true);
	});

	it("undo/redo keep Definition, Visual, and Raw YAML on the same buffer", () => {
		let state = initialEditorState(VALID_YAML);
		state = pipelineEditorReducer(state, {
			type: "patch",
			ops: [{ op: "updateOverview", overview: { description: "sync test" } }],
		});
		const patched = state.rawYamlBuffer;
		state = pipelineEditorReducer(state, { type: "undo" });
		expect(state.rawYamlBuffer).toBe(VALID_YAML);
		expect(validDocument(state)?.description).toBeUndefined();
		state = pipelineEditorReducer(state, { type: "redo" });
		expect(state.rawYamlBuffer).toBe(patched);
		expect(validDocument(state)?.description).toBe("sync test");
	});
});
