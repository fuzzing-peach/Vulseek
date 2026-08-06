import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
	FormActions,
	FormSection,
} from "@/components/dashboard/ui-system/form-section";

describe("FormSection", () => {
	it("renders title, description and the header action slot", () => {
		render(
			<FormSection
				title="Cluster Settings"
				description="Modify swarm settings."
				action={<button type="button">Manage swarm</button>}
			>
				<input aria-label="replicas" />
			</FormSection>,
		);
		expect(
			screen.getByRole("heading", { name: "Cluster Settings" }),
		).toBeInTheDocument();
		expect(screen.getByText("Modify swarm settings.")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Manage swarm" }),
		).toBeInTheDocument();
	});
});

describe("FormActions", () => {
	it("shows the status text for dirty/saving/saved/error", () => {
		const { rerender } = render(
			<FormActions status="dirty" onSave={() => {}} />,
		);
		expect(screen.getByText("Unsaved changes")).toBeInTheDocument();

		rerender(<FormActions status="saving" onSave={() => {}} />);
		expect(screen.getByText("Saving…")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

		rerender(<FormActions status="saved" onSave={() => {}} />);
		expect(screen.getByText("Saved")).toBeInTheDocument();

		rerender(<FormActions status="error" onSave={() => {}} />);
		expect(
			screen.getByText("Could not save — check the fields above"),
		).toBeInTheDocument();
	});

	it("calls onSave and onReset from the sticky bar", async () => {
		const user = userEvent.setup();
		const onSave = vi.fn();
		const onReset = vi.fn();
		render(<FormActions status="dirty" onSave={onSave} onReset={onReset} />);

		await user.click(screen.getByRole("button", { name: "Save" }));
		expect(onSave).toHaveBeenCalledTimes(1);

		await user.click(screen.getByRole("button", { name: "Reset" }));
		expect(onReset).toHaveBeenCalledTimes(1);
	});
});
