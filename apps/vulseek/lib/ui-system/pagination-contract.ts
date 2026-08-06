/**
 * Pagination contract shared by every growing collection.
 *
 * Server endpoints return `PaginatedResult<T>`; the UI renders it through a
 * single set of pagination components so x-y-of-total, page sizes, prev/next
 * and numbered pages behave identically everywhere.
 */

export type PaginatedResult<T> = {
	items: T[];
	total: number;
	page: number;
	pageSize: number;
};

export const DEFAULT_PAGE_SIZES = [10, 20, 50, 100] as const;

export type PageSize = (typeof DEFAULT_PAGE_SIZES)[number];

export const isPageSize = (value: number): value is PageSize =>
	DEFAULT_PAGE_SIZES.includes(value as PageSize);

/** Total number of pages; 0 when there are no items. */
export const totalPages = (total: number, pageSize: number): number => {
	if (total <= 0 || pageSize <= 0) return 0;
	return Math.ceil(total / pageSize);
};

/** Clamp an absolute page number into the valid range. */
export const clampPage = (
	page: number,
	total: number,
	pageSize: number,
): number => {
	const max = totalPages(total, pageSize);
	if (max === 0) return 1;
	return Math.min(Math.max(1, page), max);
};

/**
 * Page numbers to render, with -1 marking an ellipsis gap,
 * e.g. page 5 of 20 -> [1, -1, 4, 5, 6, -1, 20].
 */
export const paginationRange = (page: number, pageCount: number): number[] => {
	if (pageCount <= 7) {
		return Array.from({ length: pageCount }, (_, index) => index + 1);
	}
	const result: number[] = [1];
	let start = Math.max(2, page - 1);
	let end = Math.min(pageCount - 1, page + 1);
	// At the edges, extend the window so three numbers are always visible.
	if (start === 2) end = Math.max(end, 3);
	if (end === pageCount - 1) start = Math.min(start, pageCount - 2);
	if (start > 2) result.push(-1);
	for (let value = start; value <= end; value += 1) result.push(value);
	if (end < pageCount - 1) result.push(-1);
	result.push(pageCount);
	return result;
};

/**
 * "x–y of total" range label for the current page.
 * Empty collections render "0 of 0".
 */
export const rangeLabel = (
	page: number,
	pageSize: number,
	total: number,
): string => {
	if (total <= 0) return "0 of 0";
	const first = (page - 1) * pageSize + 1;
	const last = Math.min(page * pageSize, total);
	return `${first}–${last} of ${total}`;
};

/** Round up to a multiple of pageSize — used to size skeleton rows. */
export const skeletonRowCount = (pageSize: number): number => pageSize;
