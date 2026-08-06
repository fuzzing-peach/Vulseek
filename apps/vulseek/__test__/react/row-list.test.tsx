import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
	RowList,
	RowListItem,
} from "@/components/dashboard/ui-system/row-list";

describe("RowList", () => {
	it("renders a vertical list of full-width bordered rows", () => {
		render(
			<RowList data-testid="row-list">
				<RowListItem data-testid="row">Sample</RowListItem>
			</RowList>,
		);

		expect(screen.getByTestId("row-list")).toHaveClass(
			"flex",
			"flex-col",
			"gap-4",
		);
		expect(screen.getByTestId("row")).toHaveClass(
			"w-full",
			"rounded-xl",
			"bg-transparent",
			"ring-1",
			"p-4",
		);
	});

	it("passes the row treatment to an asChild navigation link", () => {
		render(
			<RowListItem asChild>
				<a href="/evaluations/example">Example evaluation</a>
			</RowListItem>,
		);

		const link = screen.getByRole("link", { name: "Example evaluation" });
		expect(link).toHaveAttribute("href", "/evaluations/example");
		expect(link).toHaveClass("w-full", "rounded-xl", "bg-transparent", "p-4");
	});
});
