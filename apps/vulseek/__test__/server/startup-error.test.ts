import { afterEach, describe, expect, it, vi } from "vitest";
import { exitOnStartupError } from "@/server/startup-error";

describe("exitOnStartupError", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("logs the startup error and exits with status 1", () => {
		const error = new Error("startup failed");
		const exitError = new Error("process exited");
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		const processExit = vi.spyOn(process, "exit").mockImplementation(() => {
			throw exitError;
		});

		expect(() => exitOnStartupError(error)).toThrow(exitError);
		expect(consoleError).toHaveBeenCalledWith("Main Server Error", error);
		expect(processExit).toHaveBeenCalledWith(1);
	});
});
