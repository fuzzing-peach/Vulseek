import { describe, expect, it } from "vitest";
import { buildTaskAgentStreamUrl } from "../components/dashboard/scanning/task-session-stream";

describe("buildTaskAgentStreamUrl", () => {
	it("encodes the task id for the task agent stream endpoint", () => {
		expect(buildTaskAgentStreamUrl("task/with spaces")).toBe(
			"/api/scan/tasks/task%2Fwith%20spaces/agent-stream",
		);
	});
});
