import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";

describe("Dialog layout", () => {
	it("keeps 24px content padding and 8px footer spacing", () => {
		render(
			<Dialog open>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Details</DialogTitle>
					</DialogHeader>
					<div>Body</div>
					<DialogFooter>
						<button type="button">Cancel</button>
						<button type="button">Save</button>
					</DialogFooter>
				</DialogContent>
			</Dialog>,
		);

		const dialog = screen.getByRole("dialog");
		const content = dialog.querySelector('[class*="overscroll-contain"]');
		expect(content).toHaveClass("p-6", "gap-4");
		const footer = screen.getByRole("button", { name: "Save" }).parentElement;
		expect(footer).toHaveClass("mt-4", "gap-2");
	});
});
