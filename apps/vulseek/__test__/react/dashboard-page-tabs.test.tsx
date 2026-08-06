import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardPageTabs } from "@/components/dashboard/ui-system/dashboard-page";

const mocks = vi.hoisted(() => {
	const replace = vi.fn();
	const router: { query: Record<string, unknown>; replace: typeof replace } = {
		query: {},
		replace,
	};
	return { router, replace };
});

vi.mock("next/router", () => ({
	useRouter: () => mocks.router,
}));

const TABS = [
	{ value: "general", label: "General" },
	{ value: "logs", label: "Logs" },
	{ value: "backups", label: "Backups" },
];

const HIDDEN = ["monitoring"];

const renderTabs = () =>
	render(
		<DashboardPageTabs tabs={TABS} hiddenValues={HIDDEN} fallback="general" />,
	);

beforeEach(() => {
	mocks.router.query = {};
	mocks.replace.mockReset();
});

describe("DashboardPageTabs with hiddenValues", () => {
	it("renders only the visible triggers, not the hidden values", () => {
		renderTabs();
		expect(screen.getByRole("tab", { name: "General" })).toBeInTheDocument();
		expect(screen.getByRole("tab", { name: "Logs" })).toBeInTheDocument();
		expect(screen.queryByRole("tab", { name: "Monitoring" })).toBeNull();
	});

	it("accepts a hidden value in the URL without falling back (keyboard-nav destination)", () => {
		mocks.router.query = { tab: "monitoring" };
		renderTabs();
		// No visible trigger is active — the parser kept the hidden value
		// instead of normalizing back to the fallback.
		expect(
			screen.getByRole("tab", { name: "General" }),
		).not.toHaveAttribute("data-state", "active");
		expect(mocks.replace).not.toHaveBeenCalled();
	});

	it("falls back to the default for unknown values", () => {
		mocks.router.query = { tab: "bogus" };
		renderTabs();
		expect(
			screen.getByRole("tab", { name: "General" }),
		).toHaveAttribute("data-state", "active");
	});

	it("rewrites the tab query key on click and drops it for the fallback", async () => {
		const user = userEvent.setup();
		mocks.router.query = { tab: "logs", page: "2" };
		renderTabs();

		await user.click(screen.getByRole("tab", { name: "Backups" }));
		expect(mocks.replace).toHaveBeenCalledWith(
			{ query: { tab: "backups", page: "2" } },
			undefined,
			{ shallow: true },
		);

		mocks.replace.mockReset();
		await user.click(screen.getByRole("tab", { name: "General" }));
		expect(mocks.replace).toHaveBeenCalledWith(
			{ query: { page: "2" } },
			undefined,
			{ shallow: true },
		);
	});
});
