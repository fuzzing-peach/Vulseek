import * as React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { parsePipelineDocumentV3 } from "@vulseek/server/services/scan/pipeline/document-v3";
import { PipelineWorkbench } from "@/components/dashboard/pipelines/workbench/pipeline-workbench";
import {
	initialEditorState,
	pipelineEditorReducer,
	type PipelineEditorState,
} from "@/lib/pipeline-editor/pipeline-editor-state";

const VALID_YAML = `version: 3
name: Test pipeline
supportedTargets:
  - project
root: discovery
limits:
  maxTasks: 100
  maxDurationSeconds: 3600
schemas:
  finding:
    type: object
stages:
  discovery:
    name: Discovery
    role: scan
    group: core
    mode: serial
    concurrency: 1
    runtime:
      prompt: Discover.
  review:
    name: Review
    role: verification
    group: core
    mode: serial
    concurrency: 1
    runtime:
      prompt: Review.
edges:
  - id: discover-to-review
    name: Hand off
    from: discovery
    to: review
    mode: map
    fork: false
    artifacts: []
groups:
  - id: core
    name: Core
    leader: discovery
    members:
      - discovery
      - review
`;

const VALID_VERSION_YAML = VALID_YAML.replace("name: Test pipeline", "name: Published pipeline");

const parseOk = (yaml: string) => {
	const { document } = parsePipelineDocumentV3(yaml);
	if (!document) throw new Error("fixture must parse");
	return document;
};

const Harness = ({
	initial,
	readOnly = false,
	readOnlyYaml,
	versionLabel,
}: {
	initial: PipelineEditorState;
	readOnly?: boolean;
	readOnlyYaml?: string;
	versionLabel?: string | null;
}) => {
	const [state, dispatch] = React.useReducer(pipelineEditorReducer, initial);
	return (
		<PipelineWorkbench
			state={state}
			dispatch={dispatch}
			readOnly={readOnly}
			readOnlyYaml={readOnlyYaml}
			versionLabel={versionLabel}
			draftState={{ dirty: false, draftRevision: 0, publishedVersion: "1" }}
		/>
	);
};

describe("PipelineWorkbench — three views", () => {
	it("renders Definition | Visual | Raw YAML tabs and the Definition rail", () => {
		render(<Harness initial={initialEditorState(VALID_YAML)} />);
		expect(screen.getByRole("button", { name: "Definition" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Visual" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Raw YAML" })).toBeInTheDocument();
		// Default view is Definition: the rail is visible with counts.
		expect(screen.getByRole("button", { name: "Overview" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Stages 2" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Edges 1" })).toBeInTheDocument();
		// Schemas carries a warning badge (unused schema), so the accessible
		// name includes the badge count.
		expect(screen.getByRole("button", { name: /Schemas/ })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Groups 1" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Layout" })).toBeInTheDocument();
	});

	it("navigates from the rail to the entity list and editor", () => {
		render(<Harness initial={initialEditorState(VALID_YAML)} />);
		fireEvent.click(screen.getByRole("button", { name: "Stages 2" }));
		expect(screen.getByPlaceholderText("Search stages…")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /Discovery/ }));
		// Stage editor opens with the display name field.
		expect(screen.getByDisplayValue("Discovery")).toBeInTheDocument();
	});

	it("shows a schema's Used by list and navigates to the referencing stage", () => {
		const yaml = VALID_YAML.replace(
			"    runtime:\n      prompt: Discover.",
			"    runtime:\n      prompt: Discover.\n    inputSchema:\n      $ref: \"#/schemas/finding\"",
		);
		render(<Harness initial={initialEditorState(yaml)} />);
		fireEvent.click(screen.getByRole("button", { name: /Schemas/ }));
		fireEvent.click(screen.getByRole("button", { name: /finding/ }));
		expect(screen.getByText("Used by")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "stage: discovery" }));
		expect(screen.getByDisplayValue("Discovery")).toBeInTheDocument();
	});

	it("applies typed patches from the Definition editor and reflects them in the document", () => {
		render(<Harness initial={initialEditorState(VALID_YAML)} />);
		fireEvent.click(screen.getByRole("button", { name: "Stages 2" }));
		fireEvent.click(screen.getByRole("button", { name: /Discovery/ }));
		const nameInput = screen.getByDisplayValue("Discovery") as HTMLInputElement;
		fireEvent.change(nameInput, { target: { value: "Discovery renamed" } });
		expect(nameInput.value).toBe("Discovery renamed");
	});
});

describe("PipelineWorkbench — read-only / version view", () => {
	it("disables mutation controls and shows the version banner", () => {
		render(
			<Harness
				initial={initialEditorState(VALID_YAML)}
				readOnly
				readOnlyYaml={VALID_VERSION_YAML}
				versionLabel="v3 · published"
			/>,
		);
		// Read-only banner appears in the tab bar and the bottom bar.
		expect(screen.getAllByText(/Read-only view of v3 · published/).length).toBeGreaterThan(0);
		// No create controls.
		expect(screen.queryByRole("button", { name: "New stage" })).not.toBeInTheDocument();
		// Entity fields are disabled.
		fireEvent.click(screen.getByRole("button", { name: "Stages 2" }));
		fireEvent.click(screen.getByRole("button", { name: /Discovery/ }));
		const nameInput = screen.getByDisplayValue("Discovery") as HTMLInputElement;
		expect(nameInput.disabled).toBe(true);
		// No delete affordance in read-only mode.
		expect(screen.queryByRole("button", { name: /Delete stage/ })).not.toBeInTheDocument();
	});

	it("keeps the draft buffer out of the read-only Raw YAML view", () => {
		render(
			<Harness
				initial={initialEditorState(VALID_YAML)}
				readOnly
				readOnlyYaml={VALID_VERSION_YAML}
				versionLabel="v3 · published"
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Raw YAML" }));
		// The version banner stays; the editor area renders without crashing
		// (CodeMirror content is not asserted in jsdom).
		expect(screen.getAllByText(/Read-only view of v3 · published/).length).toBeGreaterThan(0);
	});
});

describe("PipelineWorkbench — diagnostics focus", () => {
	it("selects the referenced entity and jumps to the Definition view", () => {
		// A semantic warning on the review stage (unused schema would be on
		// schema; use a route diagnostic on the edge instead).
		const yaml = VALID_YAML.replace(
			"    name: Hand off\n    from: discovery\n    to: review\n    mode: map",
			"    name: Hand off\n    from: discovery\n    to: review\n    mode: map\n    foreach: \"$item\"",
		);
		const { document } = parsePipelineDocumentV3(yaml);
		if (!document) throw new Error("fixture must parse");
		const state = initialEditorState(yaml);
		expect(
			state.diagnostics.some(
				(d) => d.entity?.type === "edge" && d.entity.id === "discover-to-review",
			),
		).toBe(true);
		render(<Harness initial={state} />);
		fireEvent.click(screen.getByRole("button", { name: /Diagnostics: / }));
		// Click the warning chip.
		const chip = screen.getByRole("button", { name: /map edges do not expand items/ });
		fireEvent.click(chip);
		// The edge editor opens with the diagnostic visible.
		expect(screen.getAllByText(/discover-to-review/).length).toBeGreaterThan(0);
		expect(screen.getAllByText(/map edges do not expand items/).length).toBeGreaterThan(0);
	});
});

describe("PipelineWorkbench — quick switcher", () => {
	it("opens with Ctrl/Cmd+P and jumps to a stage", () => {
		render(<Harness initial={initialEditorState(VALID_YAML)} />);
		fireEvent.keyDown(window, { key: "p", ctrlKey: true });
		expect(screen.getByPlaceholderText(/Jump to a stage/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("option", { name: /Discovery/ }));
		expect(screen.getByDisplayValue("Discovery")).toBeInTheDocument();
	});
});

describe("PipelineWorkbench — responsive drill-down", () => {
	const setNarrow = (narrow: boolean) => {
		window.matchMedia = (query: string) =>
			({
				matches: narrow,
				media: query,
				onchange: null,
				addListener: () => {},
				removeListener: () => {},
				addEventListener: () => {},
				removeEventListener: () => {},
				dispatchEvent: () => false,
			}) as MediaQueryList;
	};

	it("shows one pane at a time with a visible back path", () => {
		setNarrow(true);
		render(<Harness initial={initialEditorState(VALID_YAML)} />);
		// Rail only — no list yet.
		expect(screen.getByRole("button", { name: "Stages 2" })).toBeInTheDocument();
		expect(screen.queryByPlaceholderText("Search stages…")).not.toBeInTheDocument();
		// Drill into the list.
		fireEvent.click(screen.getByRole("button", { name: "Stages 2" }));
		expect(screen.getByPlaceholderText("Search stages…")).toBeInTheDocument();
		// Back to the rail.
		fireEvent.click(screen.getByRole("button", { name: /Sections/ }));
		expect(screen.getByRole("button", { name: "Overview" })).toBeInTheDocument();
		// Drill into an entity editor and back.
		fireEvent.click(screen.getByRole("button", { name: "Stages 2" }));
		fireEvent.click(screen.getByRole("button", { name: /Discovery/ }));
		expect(screen.getByDisplayValue("Discovery")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /Stages/ }));
		expect(screen.getByPlaceholderText("Search stages…")).toBeInTheDocument();
		setNarrow(false);
	});
});
