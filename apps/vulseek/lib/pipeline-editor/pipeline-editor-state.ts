import {
	parsePipelineDocumentV3,
	serializePipelineDocumentV3,
	validatePipelineDocumentV3,
	type PipelineDiagnostic,
	type PipelineDocumentV3,
} from "@vulseek/server/services/scan/pipeline/document-v3";

/**
 * Editor state machine (Phase 5).
 *
 * `rawYamlBuffer` is the single source of truth for saving and dirty state —
 * the canvas never writes back into it. `lastValidDocument` is the most
 * recent parseable document; the canvas renders it and turns stale when the
 * buffer no longer parses. `dirty` compares the buffer against the saved
 * draft / version YAML.
 *
 * The reducer is pure and framework-agnostic so it can be unit-tested
 * without React; the page wires it through useReducer.
 */

export type PipelineEditorStatus =
	| { kind: "empty" } // no valid document yet, canvas shows an empty state
	| { kind: "valid"; document: PipelineDocumentV3; stale: boolean }
	| { kind: "invalid"; diagnostics: PipelineDiagnostic[] };

export const EDITOR_HISTORY_LIMIT = 50;

export type PipelineEditorState = {
	rawYamlBuffer: string;
	/** YAML persisted on the server (draft or version), for dirty comparison. */
	savedYaml: string;
	status: PipelineEditorStatus;
	diagnostics: PipelineDiagnostic[];
	draftRevision: number;
	selectedEntity: { type: "stage" | "edge" | "schema" | "group"; id: string } | null;
	/** True once the user edits on the canvas — from then on we serialize
	 *  stably and no longer promise comment/whitespace preservation. */
	canvasTouched: boolean;
	/** Undo/redo buffer snapshots (raw YAML). `historyIndex` points at the
	 *  current buffer; undo moves back, redo moves forward. */
	history: string[];
	historyIndex: number;
};

export type PipelineEditorAction =
	| { type: "setBuffer"; yaml: string }
	| { type: "setSavedYaml"; yaml: string; draftRevision: number }
	| { type: "select"; entity: PipelineEditorState["selectedEntity"] }
	| { type: "canvasModified"; document: PipelineDocumentV3 }
	| { type: "reset"; yaml: string; draftRevision: number }
	| { type: "undo" }
	| { type: "redo" };

export const initialEditorState = (yaml: string, draftRevision = 0): PipelineEditorState => {
	const { document, diagnostics } = parsePipelineDocumentV3(yaml);
	return {
		rawYamlBuffer: yaml,
		savedYaml: yaml,
		status: document
			? { kind: "valid", document, stale: false }
			: diagnostics.some((d) => d.severity === "error")
				? { kind: "invalid", diagnostics }
				: { kind: "empty" },
		diagnostics,
		draftRevision,
		selectedEntity: null,
		canvasTouched: false,
		history: [yaml],
		historyIndex: 0,
	};
};

/** Push a buffer snapshot onto the undo history (dedupe consecutive same). */
const pushHistory = (
	state: PipelineEditorState,
	yaml: string,
): Pick<PipelineEditorState, "history" | "historyIndex"> => {
	if (state.history[state.historyIndex] === yaml) {
		return { history: state.history, historyIndex: state.historyIndex };
	}
	// Drop any redo tail, then append.
	const trimmed = state.history.slice(0, state.historyIndex + 1);
	const next = [...trimmed, yaml].slice(-EDITOR_HISTORY_LIMIT);
	return { history: next, historyIndex: next.length - 1 };
};

const analyze = (
	yaml: string,
): Pick<PipelineEditorState, "status" | "diagnostics"> => {
	const { document, diagnostics } = parsePipelineDocumentV3(yaml);
	if (!document) {
		return {
			status:
				diagnostics.length > 0
					? { kind: "invalid", diagnostics }
					: { kind: "empty" },
			diagnostics,
		};
	}
	const semantic = validatePipelineDocumentV3(document);
	return {
		status: { kind: "valid", document, stale: false },
		diagnostics: [...diagnostics, ...semantic],
	};
};

export const pipelineEditorReducer = (
	state: PipelineEditorState,
	action: PipelineEditorAction,
): PipelineEditorState => {
	switch (action.type) {
		case "setBuffer": {
			const analyzed = analyze(action.yaml);
			return {
				...state,
				rawYamlBuffer: action.yaml,
				...pushHistory(state, action.yaml),
				...analyzed,
				// A document that no longer parses marks the canvas stale; the
				// canvas keeps rendering the last valid document until the
				// buffer parses again.
				status:
					analyzed.status.kind === "valid"
						? { kind: "valid", document: analyzed.status.document, stale: false }
						: state.status.kind === "valid"
							? { kind: "valid", document: state.status.document, stale: true }
							: analyzed.status,
			};
		}
		case "setSavedYaml":
			return {
				...state,
				savedYaml: action.yaml,
				draftRevision: action.draftRevision,
			};
		case "select":
			return { ...state, selectedEntity: action.entity };
		case "canvasModified": {
			// First canvas edit switches to stable serialization: the buffer
			// becomes the serialized document, so YAML and canvas can never
			// diverge again.
			const serialized = serializePipelineDocumentV3(action.document);
			const analyzed = analyze(serialized);
			return {
				...state,
				rawYamlBuffer: serialized,
				...pushHistory(state, serialized),
				canvasTouched: true,
				...analyzed,
				status: { kind: "valid", document: action.document, stale: false },
			};
		}
		case "reset": {
			const fresh = initialEditorState(action.yaml, action.draftRevision);
			return { ...fresh, canvasTouched: false };
		}
		case "undo": {
			if (state.historyIndex <= 0) return state;
			const index = state.historyIndex - 1;
			const yaml = state.history[index] ?? state.rawYamlBuffer;
			const analyzed = analyze(yaml);
			return {
				...state,
				rawYamlBuffer: yaml,
				historyIndex: index,
				...analyzed,
				status:
					analyzed.status.kind === "valid"
						? { kind: "valid", document: analyzed.status.document, stale: false }
						: state.status.kind === "valid"
							? { kind: "valid", document: state.status.document, stale: true }
							: analyzed.status,
			};
		}
		case "redo": {
			if (state.historyIndex >= state.history.length - 1) return state;
			const index = state.historyIndex + 1;
			const yaml = state.history[index] ?? state.rawYamlBuffer;
			const analyzed = analyze(yaml);
			return {
				...state,
				rawYamlBuffer: yaml,
				historyIndex: index,
				...analyzed,
				status:
					analyzed.status.kind === "valid"
						? { kind: "valid", document: analyzed.status.document, stale: false }
						: state.status.kind === "valid"
							? { kind: "valid", document: state.status.document, stale: true }
							: analyzed.status,
			};
		}
	}
};

export const isDirty = (state: PipelineEditorState): boolean =>
	state.rawYamlBuffer !== state.savedYaml;

export const canPublish = (state: PipelineEditorState): boolean =>
	state.status.kind === "valid" &&
	!state.status.stale &&
	!state.diagnostics.some((d) => d.severity === "error");

export const blockingDiagnostics = (state: PipelineEditorState): PipelineDiagnostic[] =>
	state.diagnostics.filter((d) => d.severity === "error");

export const warningDiagnostics = (state: PipelineEditorState): PipelineDiagnostic[] =>
	state.diagnostics.filter((d) => d.severity === "warning");

export const validDocument = (state: PipelineEditorState): PipelineDocumentV3 | null =>
	state.status.kind === "valid" ? state.status.document : null;
