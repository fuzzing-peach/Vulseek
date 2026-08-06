import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CreateDatasetDialog } from "@/components/dashboard/datasets/create-dataset-dialog";

const mocks = vi.hoisted(() => ({
	push: vi.fn(),
	mutateAsync: vi.fn(),
	toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("next/router", () => ({
	useRouter: () => ({
		push: mocks.push,
		query: {},
		pathname: "/dashboard/datasets",
		replace: vi.fn(),
	}),
}));

vi.mock("@/utils/api", () => ({
	api: {
		dataset: {
			create: {
				useMutation: () => ({
					mutateAsync: mocks.mutateAsync,
					isLoading: false,
				}),
			},
		},
	},
}));

vi.mock("sonner", () => ({ toast: mocks.toast }));

beforeEach(() => {
	mocks.push.mockReset();
	mocks.mutateAsync.mockReset();
	mocks.toast.success.mockReset();
	mocks.toast.error.mockReset();
});

const openDialog = async (user: ReturnType<typeof userEvent.setup>) => {
	render(<CreateDatasetDialog />);
	await user.click(screen.getByRole("button", { name: "Create Dataset" }));
	return screen.getByRole("dialog");
};

describe("CreateDatasetDialog", () => {
	it("opens a modal dialog with a Cancel + Create footer", async () => {
		const user = userEvent.setup();
		const dialog = await openDialog(user);

		expect(
			within(dialog).getByRole("heading", { name: "Create Dataset" }),
		).toBeInTheDocument();
		expect(
			within(dialog).getByRole("button", { name: "Cancel" }),
		).toBeInTheDocument();
		expect(
			within(dialog).getByRole("button", { name: "Create Dataset" }),
		).toBeInTheDocument();
	});

	it("moves focus into the dialog and restores it on close", async () => {
		const user = userEvent.setup();
		render(<CreateDatasetDialog />);
		const trigger = screen.getByRole("button", { name: "Create Dataset" });
		await user.click(trigger);
		const dialog = screen.getByRole("dialog");

		// Radix focus trap: focus lands inside the dialog content.
		expect(dialog.contains(document.activeElement)).toBe(true);

		await user.keyboard("{Escape}");
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(document.activeElement).toBe(trigger);
	});

	it("closes through the Cancel button without submitting", async () => {
		const user = userEvent.setup();
		const dialog = await openDialog(user);

		await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(mocks.mutateAsync).not.toHaveBeenCalled();
	});

	it("submits the form, navigates to the dataset and reports success", async () => {
		const user = userEvent.setup();
		mocks.mutateAsync.mockResolvedValue({ datasetId: "ds-1" });
		const dialog = await openDialog(user);

		await user.type(within(dialog).getByLabelText("Name"), "CyberGym subset");
		await user.click(
			within(dialog).getByRole("button", { name: "Create Dataset" }),
		);

		await waitFor(() =>
			expect(mocks.mutateAsync).toHaveBeenCalledWith({
				name: "CyberGym subset",
				description: "",
			}),
		);
		await waitFor(() => expect(mocks.toast.success).toHaveBeenCalled());
		expect(mocks.push).toHaveBeenCalledWith("/dashboard/datasets/ds-1");
	});

	it("reports a failure toast and keeps the dialog open", async () => {
		const user = userEvent.setup();
		mocks.mutateAsync.mockRejectedValue(new Error("boom"));
		const dialog = await openDialog(user);

		await user.type(within(dialog).getByLabelText("Name"), "Broken");
		await user.click(
			within(dialog).getByRole("button", { name: "Create Dataset" }),
		);

		await waitFor(() => expect(mocks.toast.error).toHaveBeenCalled());
		expect(screen.getByRole("dialog")).toBeInTheDocument();
	});
});
