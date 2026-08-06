import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PruneProfileDialog } from "@/components/dashboard/datasets/prune-profile-dialog";

const openDialog = async (
	user: ReturnType<typeof userEvent.setup>,
	onConfirm = vi.fn(),
) => {
	render(<PruneProfileDialog profileKey="default" onConfirm={onConfirm} />);
	const trigger = screen.getByRole("button", { name: "Prune profile default" });
	await user.click(trigger);
	return { dialog: screen.getByRole("alertdialog"), trigger, onConfirm };
};

describe("PruneProfileDialog", () => {
	it("opens a destructive confirm dialog on trigger click", async () => {
		const user = userEvent.setup();
		const { dialog, onConfirm } = await openDialog(user);

		expect(
			within(dialog).getByRole("heading", { name: "Prune Profile" }),
		).toBeInTheDocument();
		expect(within(dialog).getByText(/default/)).toBeInTheDocument();
		expect(
			within(dialog).getByText("This action cannot be undone."),
		).toBeInTheDocument();
		expect(
			within(dialog).getByRole("button", { name: "Cancel" }),
		).toBeInTheDocument();
		expect(
			within(dialog).getByRole("button", { name: "Confirm" }),
		).toBeInTheDocument();
		expect(onConfirm).not.toHaveBeenCalled();
	});

	it("keeps the description legal phrasing content (no DOM nesting warnings)", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const user = userEvent.setup();
			const { dialog } = await openDialog(user);

			// The Radix description renders a <p>; it must not contain block
			// elements (React logs a validateDOMNesting warning otherwise).
			const paragraph = within(dialog).getByText(/default/).closest("p");
			expect(paragraph).not.toBeNull();
			expect(paragraph?.querySelector("div, p")).toBeNull();
			expect(
				errorSpy.mock.calls.filter((call) =>
					String(call[0]).includes("validateDOMNesting"),
				),
			).toEqual([]);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("moves focus into the dialog and restores it on close", async () => {
		const user = userEvent.setup();
		const { dialog, trigger } = await openDialog(user);

		// Radix focus trap: focus lands inside the dialog content.
		expect(dialog.contains(document.activeElement)).toBe(true);

		await user.keyboard("{Escape}");
		expect(screen.queryByRole("alertdialog")).toBeNull();
		expect(document.activeElement).toBe(trigger);
	});

	it("closes through Cancel without pruning", async () => {
		const user = userEvent.setup();
		const { dialog, onConfirm } = await openDialog(user);

		await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
		expect(screen.queryByRole("alertdialog")).toBeNull();
		expect(onConfirm).not.toHaveBeenCalled();
	});

	it("closes through Escape without pruning", async () => {
		const user = userEvent.setup();
		const { dialog, onConfirm } = await openDialog(user);

		await user.keyboard("{Escape}");
		expect(screen.queryByRole("alertdialog")).toBeNull();
		expect(onConfirm).not.toHaveBeenCalled();
	});

	it("prunes only after Confirm and closes the dialog", async () => {
		const user = userEvent.setup();
		const { dialog, onConfirm } = await openDialog(user);

		await user.click(within(dialog).getByRole("button", { name: "Confirm" }));

		expect(onConfirm).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole("alertdialog")).toBeNull();
	});
});
