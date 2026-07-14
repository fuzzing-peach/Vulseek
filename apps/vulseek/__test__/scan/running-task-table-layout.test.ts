import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const readComponent = (name: string) =>
	readFileSync(
		join(process.cwd(), "components/dashboard/scanning", name),
		"utf8",
	);

const readServerSource = (relativePath: string) =>
	readFileSync(join(process.cwd(), "../../packages/server/src", relativePath), "utf8");

describe("running task table layout", () => {
	it("reserves fixed space for stage, runtime, and actions", () => {
		const source = readComponent("show-scan-job-detail.tsx");
		const tableStart = source.indexOf(
			'<table className="w-full min-w-[900px] table-fixed text-sm">',
		);
		const runningTable = source.slice(
			tableStart,
			source.indexOf("</table>", tableStart),
		);

		expect(runningTable.match(/w-\[190px\]/g)).toHaveLength(2);
		expect(runningTable.match(/w-\[110px\]/g)).toHaveLength(2);
		expect(runningTable.match(/w-\[120px\]/g)).toHaveLength(2);
		expect(runningTable).not.toContain("w-[96px]");
		expect(runningTable.match(/w-\[38%\]/g)).toHaveLength(2);
		expect(runningTable).not.toContain("w-[25%]");
	});

	it("balances task queue columns", () => {
		const source = readComponent("show-scan-job-detail.tsx");
		const queueStart = source.indexOf('"scan.tasks.queuesDescription"');
		const queueTable = source.slice(
			queueStart,
			source.indexOf('"scan.tasks.runningDescription"', queueStart),
		);

		expect(queueTable).toContain(
			'<table className="w-full min-w-[720px] table-fixed text-sm">',
		);
		expect(queueTable.match(/w-\[30%\]/g)).toHaveLength(4);
		expect(queueTable.match(/w-\[20%\]/g)).toHaveLength(4);
	});

	it("shows stage first and the raw task name without a subtitle", () => {
		const source = readComponent("show-scan-job-detail.tsx");
		const runningTable = source.slice(
			source.indexOf("!hasJobRuntime"),
			source.indexOf("finishedTaskPagination.items.map"),
		);
		const taskCellStart = runningTable.indexOf(
			'<td className="w-[38%] min-w-0 whitespace-normal px-4 py-3 align-top">',
		);
		const runningTaskCell = runningTable.slice(
			taskCellStart,
			runningTable.indexOf("</td>", taskCellStart),
		);
		const repositorySource = readServerSource(
			"services/scan/persistence/task.repo.ts",
		);

		expect(runningTable.indexOf('scan.field.stage')).toBeLessThan(
			runningTable.indexOf('scan.monitoring.task'),
		);
		expect(runningTable).not.toContain("taskNameSeparator");
		expect(runningTable).not.toContain("taskName.slice(");
		expect(runningTaskCell).toContain("{runningTaskTitle}");
		expect(runningTaskCell).not.toContain("{runningTaskSubtitle}");
		expect(runningTable).toContain(
			'const taskName = String(task.taskName || "").trim();',
		);
		expect(runningTable).toContain("noWrap");
		expect(readComponent("live-task-activity.tsx")).toContain(
			'"flex min-w-0 flex-nowrap items-center gap-2 overflow-hidden"',
		);
		expect(repositorySource).toContain(
			'taskName: String(value.name || ""),',
		);
		expect(readServerSource("services/scan.ts")).toContain(
			"title: task.name || baseTask.title,",
		);
	});

	it("does not repeat the stage name in the finished task column", () => {
		const source = readComponent("show-scan-job-detail.tsx");
		const finishedCheckboxMarker = source.indexOf(
			'"Select rerunnable tasks on this page"',
		);
		const finishedTableStart = source.lastIndexOf(
			"<table",
			finishedCheckboxMarker,
		);
		const finishedTable = source.slice(
			finishedTableStart,
			source.indexOf("</table>", finishedTableStart),
		);
		const finishedTasks = source.slice(
			source.indexOf("finishedTaskPagination.items.map"),
		);

		expect(finishedTable.indexOf('"scan.field.stage"')).toBeLessThan(
			finishedTable.indexOf('"scan.monitoring.task"'),
		);
		expect(finishedTasks.indexOf("getTaskStageLabel(t, task.stage)")).toBeLessThan(
			finishedTasks.indexOf("{finishedTaskTitle}"),
		);
		expect(finishedTasks).toMatch(
			/const finishedTaskTitle\s*=\s*localizeTaskListText\(t, task\.title\) \|\| "-";/,
		);
		expect(finishedTasks).toContain("{finishedTaskTitle}");
		expect(finishedTasks).not.toContain("finishedTaskSubtitle");
		expect(finishedTasks).not.toContain("getTaskListDisplay(t, task)");
		expect(finishedTable).not.toContain('"scan.task.tabs.details"');
		expect(finishedTable).not.toContain("task.errorMessage");
		expect(finishedTable).toContain(
			'<table className="w-full min-w-[1000px] table-fixed text-sm">',
		);
		for (const width of ["52px", "170px", "120px", "160px", "88px"]) {
			expect(finishedTable).toContain(`w-[${width}]`);
		}
	});

	it("uses the dashboard ping effect for connected activity", () => {
		const source = readComponent("live-task-activity.tsx");

		expect(source).toContain(
			'absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75',
		);
		expect(source).toContain(
			'relative inline-flex h-2 w-2 rounded-full bg-emerald-500',
		);
	});
});
