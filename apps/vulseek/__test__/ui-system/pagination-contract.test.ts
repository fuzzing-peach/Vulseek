import { describe, expect, it } from "vitest";
import {
	clampPage,
	isPageSize,
	type PaginatedResult,
	paginationRange,
	rangeLabel,
	totalPages,
} from "@/lib/ui-system/pagination-contract";

describe("totalPages", () => {
	it("computes ceil division", () => {
		expect(totalPages(0, 20)).toBe(0);
		expect(totalPages(1, 20)).toBe(1);
		expect(totalPages(20, 20)).toBe(1);
		expect(totalPages(21, 20)).toBe(2);
		expect(totalPages(100, 20)).toBe(5);
	});

	it("guards against invalid page sizes", () => {
		expect(totalPages(10, 0)).toBe(0);
		expect(totalPages(10, -5)).toBe(0);
	});
});

describe("clampPage", () => {
	it("clamps above and below the valid range", () => {
		expect(clampPage(1, 50, 20)).toBe(1);
		expect(clampPage(3, 50, 20)).toBe(3);
		expect(clampPage(99, 50, 20)).toBe(3);
		expect(clampPage(0, 50, 20)).toBe(1);
	});

	it("returns 1 for empty collections", () => {
		expect(clampPage(5, 0, 20)).toBe(1);
	});
});

describe("rangeLabel", () => {
	it("renders x–y of total for the current page", () => {
		expect(rangeLabel(1, 20, 45)).toBe("1–20 of 45");
		expect(rangeLabel(2, 20, 45)).toBe("21–40 of 45");
		expect(rangeLabel(3, 20, 45)).toBe("41–45 of 45");
	});

	it("renders 0 of 0 for empty collections", () => {
		expect(rangeLabel(1, 20, 0)).toBe("0 of 0");
	});
});

describe("paginationRange", () => {
	it("lists all pages when there are few", () => {
		expect(paginationRange(1, 5)).toEqual([1, 2, 3, 4, 5]);
	});

	it("inserts ellipsis markers (-1) on both sides", () => {
		expect(paginationRange(5, 20)).toEqual([1, -1, 4, 5, 6, -1, 20]);
	});

	it("keeps the first and last page visible at the edges", () => {
		expect(paginationRange(1, 20)).toEqual([1, 2, 3, -1, 20]);
		expect(paginationRange(20, 20)).toEqual([1, -1, 18, 19, 20]);
	});

	it("returns an empty range for zero pages", () => {
		expect(paginationRange(1, 0)).toEqual([]);
	});
});

describe("PaginatedResult contract", () => {
	it("holds items, total, page and pageSize", () => {
		const result: PaginatedResult<{ id: string }> = {
			items: [{ id: "a" }],
			total: 1,
			page: 1,
			pageSize: 20,
		};
		expect(result.items).toHaveLength(1);
		expect(result.total).toBe(1);
		expect(result.page).toBe(1);
		expect(result.pageSize).toBe(20);
	});

	it("validates page sizes against the shared list", () => {
		expect(isPageSize(10)).toBe(true);
		expect(isPageSize(20)).toBe(true);
		expect(isPageSize(100)).toBe(true);
		expect(isPageSize(15)).toBe(false);
	});
});
