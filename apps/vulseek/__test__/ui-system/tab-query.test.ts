import { describe, expect, it } from "vitest";
import { parseTabParam, tabQueryParam } from "@/lib/ui-system/tab-query";

const TABS = ["overview", "jobs", "settings"] as const;

describe("parseTabParam", () => {
	it("returns the default when the param is missing", () => {
		expect(parseTabParam({}, TABS, "overview")).toBe("overview");
	});

	it("accepts a known value", () => {
		expect(parseTabParam({ tab: ["jobs"] }, TABS, "overview")).toBe("jobs");
	});

	it("falls back for unknown values and multi-value params", () => {
		expect(parseTabParam({ tab: ["bogus"] }, TABS, "overview")).toBe(
			"overview",
		);
		expect(parseTabParam({ tab: ["a", "b"] }, TABS, "overview")).toBe(
			"overview",
		);
	});

	it("supports a custom query key", () => {
		expect(
			parseTabParam({ panel: ["settings"] }, TABS, "overview", "panel"),
		).toBe("settings");
	});
});

describe("tabQueryParam", () => {
	it("omits the fallback tab so the URL stays minimal", () => {
		expect(tabQueryParam("overview", "overview")).toEqual({});
	});

	it("serializes a non-default tab", () => {
		expect(tabQueryParam("jobs", "overview")).toEqual({ tab: "jobs" });
	});
});
