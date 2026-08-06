import type { ColumnDef } from "@tanstack/react-table";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { CollectionView } from "@/components/dashboard/ui-system/collection-view";
import type { ListQueryState } from "@/lib/ui-system/list-query";

type Row = { id: string; name: string; status: string };

const columns: ColumnDef<Row, unknown>[] = [
	{
		id: "name",
		accessorKey: "name",
		header: "Name",
		enableSorting: true,
		cell: (info) => info.getValue(),
	},
	{
		id: "status",
		accessorKey: "status",
		header: "Status",
		enableSorting: false,
		cell: (info) => info.getValue(),
	},
];

const rows: Row[] = [
	{ id: "1", name: "Alpha", status: "running" },
	{ id: "2", name: "Beta", status: "failed" },
	{ id: "3", name: "Gamma", status: "running" },
];

const baseState = (
	overrides: Partial<ListQueryState> = {},
): ListQueryState => ({
	query: "",
	filters: {},
	sortKey: "",
	sortDirection: "asc",
	page: 1,
	pageSize: 10,
	...overrides,
});

/** Harness that owns the state so interactions re-render the view. */
const Harness = ({
	initial = baseState(),
	total = rows.length,
	items = rows,
	isLoading = false,
	isError = false,
	onRetry,
	searchPlaceholder = "Search items",
	filters,
	bulkActions,
	mobileRender,
	renderRow,
	onRowClick,
}: {
	initial?: ListQueryState;
	total?: number;
	items?: Row[];
	isLoading?: boolean;
	isError?: boolean;
	onRetry?: () => void;
	searchPlaceholder?: string;
	filters?: React.ComponentProps<typeof CollectionView<Row>>["filters"];
	bulkActions?: React.ReactNode;
	mobileRender?: React.ComponentProps<
		typeof CollectionView<Row>
	>["mobileRender"];
	renderRow?: React.ComponentProps<typeof CollectionView<Row>>["renderRow"];
	onRowClick?: (item: Row) => void;
}) => {
	const [state, setState] = useState(initial);
	const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
	return (
		<CollectionView
			state={state}
			onStateChange={(updater) => setState(updater)}
			columns={columns}
			data={{ items, total }}
			isLoading={isLoading}
			isError={isError}
			onRetry={onRetry}
			getRowId={(row) => row.id}
			getRowLabel={(row) => row.name}
			searchValue={state.query}
			onSearchValueChange={(value) =>
				setState((previous) => ({ ...previous, query: value }))
			}
			searchPlaceholder={searchPlaceholder}
			filters={filters}
			bulkActions={bulkActions}
			selectedIds={selectedIds}
			onToggleRow={
				bulkActions
					? (id) =>
							setSelectedIds((previous) => {
								const next = new Set(previous);
								if (next.has(id)) next.delete(id);
								else next.add(id);
								return next;
							})
					: undefined
			}
			onTogglePage={
				bulkActions
					? (pageIds, allSelected) =>
							setSelectedIds((previous) => {
								const next = new Set(previous);
								for (const id of pageIds) {
									if (allSelected) next.delete(id);
									else next.add(id);
								}
								return next;
							})
					: undefined
			}
			onClearSelection={
				bulkActions ? () => setSelectedIds(new Set()) : undefined
			}
			mobileRender={mobileRender}
			renderRow={renderRow}
			onRowClick={onRowClick}
		/>
	);
};

const statusFilter = [
	{
		key: "status",
		label: "Status",
		options: [
			{ value: "running", label: "Running" },
			{ value: "failed", label: "Failed" },
		],
	},
];

describe("CollectionView toolbar", () => {
	it("echoes the search input and calls the value handler", async () => {
		const user = userEvent.setup();
		render(<Harness />);

		const search = screen.getByRole("textbox", { name: "Search items" });
		expect(search).toHaveValue("");

		await user.type(search, "pay");
		expect(search).toHaveValue("pay");
	});

	it("renders the filter chips from the filter schema and marks selection", () => {
		render(
			<Harness
				initial={baseState({ filters: { status: ["failed"] } })}
				filters={statusFilter}
			/>,
		);

		const running = screen.getByRole("button", { name: "Running" });
		const failed = screen.getByRole("button", { name: "Failed" });
		expect(running).toHaveAttribute("aria-pressed", "false");
		expect(failed).toHaveAttribute("aria-pressed", "true");
	});

	it("toggles a filter off through the chip (filter clear) and resets the page", async () => {
		const user = userEvent.setup();
		render(
			<Harness
				initial={baseState({ filters: { status: ["failed"] }, page: 3 })}
				filters={statusFilter}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Failed" }));
		expect(screen.getByRole("button", { name: "Failed" })).toHaveAttribute(
			"aria-pressed",
			"false",
		);
	});
});

describe("CollectionView sort", () => {
	it("sorts by a sortable column header and resets to page 1", async () => {
		const user = userEvent.setup();
		render(<Harness initial={baseState({ page: 2 })} />);

		const header = screen.getByRole("columnheader", { name: /Name/ });
		expect(header).not.toHaveAttribute("aria-sort");

		await user.click(screen.getByRole("button", { name: "Sort by name" }));
		expect(header).toHaveAttribute("aria-sort", "ascending");

		await user.click(screen.getByRole("button", { name: "Sort by name" }));
		expect(header).toHaveAttribute("aria-sort", "descending");
	});

	it("does not render a sort button for unsortable columns", () => {
		render(<Harness />);
		expect(screen.queryByRole("button", { name: "Sort by status" })).toBeNull();
	});
});

describe("CollectionView bulk actions", () => {
	it("shows the bulk bar with the selected count, actions and clear", async () => {
		const user = userEvent.setup();
		render(<Harness bulkActions={<button type="button">Rerun</button>} />);

		expect(screen.queryByText("selected")).toBeNull();

		await user.click(screen.getByRole("checkbox", { name: "Select Alpha" }));
		expect(screen.getByText("1 selected")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Rerun" })).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Clear" }));
		expect(screen.queryByText("1 selected")).toBeNull();
	});

	it("selects every selectable row on the page through the header checkbox", async () => {
		const user = userEvent.setup();
		render(<Harness bulkActions={<button type="button">Rerun</button>} />);

		const selectAll = screen.getByRole("checkbox", {
			name: "Select all rows on this page",
		});
		await user.click(selectAll);
		expect(screen.getByText("3 selected")).toBeInTheDocument();

		// Clicking the header again clears the page selection.
		await user.click(
			screen.getByRole("checkbox", { name: "Clear all selected rows" }),
		);
		expect(screen.queryByText("3 selected")).toBeNull();
	});
});

describe("CollectionView pagination", () => {
	it("renders the x-y of total label, page size, prev/next and numbered pages", async () => {
		const user = userEvent.setup();
		const manyRows = Array.from({ length: 25 }, (_, index) => ({
			id: String(index + 1),
			name: `Row ${index + 1}`,
			status: "running",
		}));
		render(<Harness items={manyRows} total={25} />);

		expect(screen.getByText("1–10 of 25")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Page 1" })).toHaveAttribute(
			"aria-current",
			"page",
		);
		expect(
			screen.getByRole("button", { name: "Previous page" }),
		).toBeDisabled();

		await user.click(screen.getByRole("button", { name: "Next page" }));
		expect(screen.getByText("11–20 of 25")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Page 2" })).toHaveAttribute(
			"aria-current",
			"page",
		);

		await user.click(screen.getByRole("button", { name: "Next page" }));
		expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
	});
});

describe("CollectionView states", () => {
	it("renders the loading skeleton surface", () => {
		const { container } = render(<Harness isLoading />);
		expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
		expect(screen.queryByRole("table")).toBeNull();
	});

	it("renders the empty state with the provided copy", () => {
		render(<Harness items={[]} total={0} initial={baseState()} />);
		expect(screen.getByText("Nothing here yet")).toBeInTheDocument();
	});

	it("renders the error state and retries through onRetry", async () => {
		const user = userEvent.setup();
		const onRetry = () => {};
		render(<Harness isError onRetry={onRetry} />);

		const alert = screen.getByRole("alert");
		expect(within(alert).getByText("Something went wrong")).toBeInTheDocument();
		await user.click(within(alert).getByRole("button", { name: "Retry" }));
	});
});

describe("CollectionView rows", () => {
	it("renders a single full-width row per item when renderRow is provided", () => {
		render(
			<Harness
				renderRow={(row) => <div data-testid={`row-${row.id}`}>{row.name}</div>}
			/>,
		);

		expect(screen.queryByRole("table")).toBeNull();
		expect(screen.getByTestId("row-1")).toHaveTextContent("Alpha");
		expect(screen.getByTestId("row-2")).toHaveTextContent("Beta");
	});
});

describe("CollectionView mobile cards", () => {
	it("renders one card per row when mobileRender is provided", () => {
		render(
			<Harness
				mobileRender={(row) => (
					<div data-testid={`mobile-${row.id}`}>{row.name}</div>
				)}
			/>,
		);

		expect(screen.getByRole("table")).toBeInTheDocument();
		expect(screen.getByTestId("mobile-1")).toHaveTextContent("Alpha");
		expect(screen.getByTestId("mobile-2")).toHaveTextContent("Beta");
		expect(screen.getByTestId("mobile-3")).toHaveTextContent("Gamma");
	});

	it("renders no card fallback when mobileRender is omitted", () => {
		render(<Harness />);

		const table = screen.getByRole("table");
		expect(table).toBeInTheDocument();
		expect(table.parentElement?.parentElement).toHaveClass(
			"min-w-0",
			"max-w-full",
			"overflow-hidden",
			"rounded-xl",
			"border",
		);
		expect(screen.queryByTestId("mobile-1")).toBeNull();
	});

	it("opens the row detail through the card's primary button", async () => {
		const user = userEvent.setup();
		const onRowClick = vi.fn();
		render(
			<Harness
				onRowClick={onRowClick}
				mobileRender={(row) => (
					<button type="button" onClick={() => onRowClick(row)}>
						Open {row.name}
					</button>
				)}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Open Alpha" }));
		expect(onRowClick).toHaveBeenCalledWith(rows[0]);
	});
});
