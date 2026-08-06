import { describe, expect, it } from "vitest";
import {
	getResearchRegistryTabs,
	isResearchRegistryTab,
} from "../../components/dashboard/scanning/research-registry-tabs";

describe("research registry job tabs", () => {
	it("shows three registry tabs for research jobs", () => {
		expect(getResearchRegistryTabs("research").map((tab) => tab.value)).toEqual(
			["findings", "tracks", "primitives", "chains"],
		);
	});

	it("does not show registry tabs for full or delta jobs", () => {
		expect(getResearchRegistryTabs("full")).toEqual([]);
		expect(getResearchRegistryTabs("delta")).toEqual([]);
	});

	it("recognizes only supported registry route segments", () => {
		expect(isResearchRegistryTab("tracks")).toBe(true);
		expect(isResearchRegistryTab("findings")).toBe(true);
		expect(isResearchRegistryTab("primitives")).toBe(true);
		expect(isResearchRegistryTab("chains")).toBe(true);
		expect(isResearchRegistryTab("registry")).toBe(false);
	});
});
