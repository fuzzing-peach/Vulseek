import { describe, expect, it } from "vitest";
import {
	detailQueryParam,
	parseDetailId,
	withoutDetailParam,
} from "@/lib/ui-system/detail-query";

describe("parseDetailId", () => {
	it("parses a single detail id", () => {
		expect(parseDetailId({ detail: ["cand-1"] })).toBe("cand-1");
	});

	it("returns null when missing, empty or multi-valued", () => {
		expect(parseDetailId({})).toBeNull();
		expect(parseDetailId({ detail: [""] })).toBeNull();
		expect(parseDetailId({ detail: ["a", "b"] })).toBe("a");
	});

	it("supports a custom key", () => {
		expect(parseDetailId({ job: ["j1"] }, "job")).toBe("j1");
	});
});

describe("detailQueryParam", () => {
	it("serializes the id into the detail key", () => {
		expect(detailQueryParam("cand-1")).toEqual({ detail: "cand-1" });
		expect(detailQueryParam("j1", "job")).toEqual({ job: "j1" });
	});
});

describe("withoutDetailParam", () => {
	it("keeps list params while dropping the detail key", () => {
		const next = withoutDetailParam({
			tab: ["tracks"],
			tracksPage: ["3"],
			detail: ["cand-1"],
		});
		expect(next).toEqual({ tab: "tracks", tracksPage: "3" });
	});

	it("returns an empty object for an empty query", () => {
		expect(withoutDetailParam({})).toEqual({});
	});
});
