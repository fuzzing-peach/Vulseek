import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EntityDetailSheet } from "@/components/dashboard/ui-system/entity-detail-sheet";

describe("EntityDetailSheet", () => {
	const renderSheet = (
		props: Partial<React.ComponentProps<typeof EntityDetailSheet>> = {},
	) => {
		const onOpenChange = vi.fn();
		render(
			<EntityDetailSheet
				open
				onOpenChange={onOpenChange}
				title="Finding detail"
				description="Analysis for CVE-2026-0001"
				footer={<button type="button">Verify</button>}
				children={<div>Body content</div>}
				{...props}
			/>,
		);
		return { onOpenChange };
	};

	it("renders title, description and footer inside the sheet", () => {
		renderSheet();
		const sheet = screen.getByRole("dialog");
		expect(within(sheet).getByText("Finding detail")).toBeInTheDocument();
		expect(
			within(sheet).getByText("Analysis for CVE-2026-0001"),
		).toBeInTheDocument();
		expect(
			within(sheet).getByRole("button", { name: "Verify" }),
		).toBeInTheDocument();
	});

	it("closes via Escape (browser Back path for route-backed details)", async () => {
		const user = userEvent.setup();
		const { onOpenChange } = renderSheet();
		await user.keyboard("{Escape}");
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("maps each size tier to the matching max-width", () => {
		renderSheet({ size: "compact" });
		expect(screen.getByRole("dialog")).toHaveClass("sm:max-w-[480px]");
	});

	it("moves focus into the panel on a route-driven reopen", async () => {
		// The caller stays mounted; a URL change (deep link, browser history)
		// flips the open prop back to true. Focus must land inside the panel.
		const onOpenChange = vi.fn();
		const { rerender } = render(
			<EntityDetailSheet
				open={false}
				onOpenChange={onOpenChange}
				title="Finding detail"
				description="Analysis for CVE-2026-0001"
				children={<div>Body content</div>}
			/>,
		);
		rerender(
			<EntityDetailSheet
				open
				onOpenChange={onOpenChange}
				title="Finding detail"
				description="Analysis for CVE-2026-0001"
				children={<div>Body content</div>}
			/>,
		);
		await waitFor(() => {
			expect(
				screen.getByRole("dialog").contains(document.activeElement),
			).toBe(true);
		});
	});

	it("restores focus to the previously focused element after close", async () => {
		const user = userEvent.setup();
		const onOpenChange = vi.fn();
		const renderSheet = (open: boolean) => (
			<>
				<button type="button">Row trigger</button>
				<EntityDetailSheet
					open={open}
					onOpenChange={onOpenChange}
					title="Finding detail"
					description="Analysis for CVE-2026-0001"
					children={<div>Body content</div>}
				/>
			</>
		);
		const { rerender } = render(renderSheet(false));
		const trigger = screen.getByRole("button", { name: "Row trigger" });
		trigger.focus();

		rerender(renderSheet(true));
		await waitFor(() => {
			expect(
				screen.getByRole("dialog").contains(document.activeElement),
			).toBe(true);
		});

		await user.keyboard("{Escape}");
		expect(onOpenChange).toHaveBeenCalledWith(false);
		rerender(renderSheet(false));
		// Radix restores focus in a deferred unmount handler (setTimeout),
		// so the trigger regains focus a tick after the panel unmounts.
		await waitFor(() => {
			expect(document.activeElement).toBe(trigger);
		});
	});
});
