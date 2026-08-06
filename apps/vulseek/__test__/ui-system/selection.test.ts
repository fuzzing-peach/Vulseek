import { describe, expect, it } from "vitest";
import {
	type CollectionSelection,
	createSelection,
	isPageSelected,
} from "@/lib/ui-system/selection";

describe("createSelection", () => {
	it("toggles individual ids on and off", () => {
		let selection: CollectionSelection = createSelection();
		selection = selection.toggle("a");
		selection = selection.toggle("b");
		expect([...selection.selected]).toEqual(["a", "b"]);
		selection = selection.toggle("a");
		expect([...selection.selected]).toEqual(["b"]);
	});

	it("toggles a whole page without touching other pages", () => {
		let selection: CollectionSelection = createSelection(new Set(["x"]));
		selection = selection.togglePage(["a", "b"], false);
		expect([...selection.selected].sort()).toEqual(["a", "b", "x"]);
		// select-all page again clears only that page
		selection = selection.togglePage(["a", "b"], true);
		expect([...selection.selected]).toEqual(["x"]);
	});

	it("clears the full selection", () => {
		const selection = createSelection(new Set(["a", "b"])).clear();
		expect(selection.selected.size).toBe(0);
	});

	it("is immutable — each step returns a new set", () => {
		const initial = createSelection();
		const next = initial.toggle("a");
		expect(initial.selected.size).toBe(0);
		expect(next.selected.size).toBe(1);
	});
});

describe("isPageSelected", () => {
	it("is true only when every page id is selected", () => {
		const selection = new Set(["a", "b"]);
		expect(isPageSelected(selection, ["a", "b"])).toBe(true);
		expect(isPageSelected(selection, ["a"])).toBe(true);
		expect(isPageSelected(selection, ["a", "b", "c"])).toBe(false);
		expect(isPageSelected(selection, [])).toBe(false);
		expect(isPageSelected(new Set(), ["a"])).toBe(false);
	});
});
