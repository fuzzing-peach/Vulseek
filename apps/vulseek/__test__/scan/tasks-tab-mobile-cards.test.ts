import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const readComponent = () =>
	readFileSync(
		join(process.cwd(), "components/dashboard/scanning/scan-job-tasks-tab.tsx"),
		"utf8",
	);

describe("tasks tab row layout", () => {
	it("passes a full-width renderRow to the running-tasks CollectionView", () => {
		const source = readComponent();
		const runningStart = source.indexOf("state={runningState}");
		const runningBlock = source.slice(
			runningStart,
			source.indexOf("state={finishedState}"),
		);

		expect(runningBlock).toContain("renderRow=");
		// The card keeps the primary task-detail anchor…
		expect(runningBlock).toContain("href={taskHref(task.taskId)}");
		// …the stage/runtime context…
		expect(runningBlock).toContain("getTaskStageLabel(t, task.stage)");
		expect(runningBlock).toContain(
			"formatTaskRuntime(task.startedAt, runtimeNowMs)",
		);
		// …and the live activity + cancel actions, shared with the table.
		expect(runningBlock).toContain("LiveTaskActivityBadge");
		expect(runningBlock).toContain("renderRunningTaskActions(task)");
	});

	it("passes a full-width renderRow to the finished-tasks CollectionView", () => {
		const source = readComponent();
		const finishedStart = source.indexOf("state={finishedState}");
		const finishedBlock = source.slice(finishedStart);

		expect(finishedBlock).toContain("renderRow=");
		expect(finishedBlock).toContain("href={taskHref(task.taskId)}");
		expect(finishedBlock).toContain("getTaskStageLabel(t, task.stage)");
		expect(finishedBlock).toContain("getTaskStatusLabel(t, task.status)");
		// Per-row rerun stays reachable in the row, shared with the table.
		expect(finishedBlock).toContain("renderFinishedTaskActions(task)");
	});

	it("shares the row actions between the table contract and rendered rows", () => {
		const source = readComponent();
		// Each actions cell delegates to the shared renderer instead of
		// duplicating the buttons.
		expect(source).toContain("renderRunningTaskActions(row.original)");
		expect(source).toContain("renderFinishedTaskActions(row.original)");
		expect(source).toContain("const renderRunningTaskActions");
		expect(source).toContain("const renderFinishedTaskActions");
	});
});
