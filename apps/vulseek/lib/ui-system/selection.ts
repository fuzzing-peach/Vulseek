/**
 * Cross-page row selection for collections.
 *
 * Selection is stored as a flat set of row ids that survives pagination,
 * search and filter changes. Toggling a whole page only touches the ids
 * visible on it, so selections made on other pages stay intact.
 */

export type CollectionSelection = {
	selected: ReadonlySet<string>;
	toggle: (id: string) => CollectionSelection;
	togglePage: (
		pageIds: readonly string[],
		allPageIdsSelected: boolean,
	) => CollectionSelection;
	clear: () => CollectionSelection;
};

export const createSelection = (
	selected: ReadonlySet<string> = new Set(),
): CollectionSelection => ({
	selected,
	toggle: (id) => {
		const next = new Set(selected);
		if (next.has(id)) {
			next.delete(id);
		} else {
			next.add(id);
		}
		return createSelection(next);
	},
	togglePage: (pageIds, allPageIdsSelected) => {
		const next = new Set(selected);
		for (const id of pageIds) {
			if (allPageIdsSelected) {
				next.delete(id);
			} else {
				next.add(id);
			}
		}
		return createSelection(next);
	},
	clear: () => createSelection(new Set()),
});

/** True when every id in the page is currently selected. */
export const isPageSelected = (
	selection: ReadonlySet<string>,
	pageIds: readonly string[],
): boolean => pageIds.length > 0 && pageIds.every((id) => selection.has(id));
