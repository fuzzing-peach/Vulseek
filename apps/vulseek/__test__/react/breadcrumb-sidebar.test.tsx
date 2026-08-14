import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BreadcrumbSidebar } from "@/components/shared/breadcrumb-sidebar";

describe("BreadcrumbSidebar", () => {
	it("renders the final entry as the current page even when it has an href", () => {
		render(
			<BreadcrumbSidebar
				list={[{ name: "Projects", href: "/dashboard/projects" }]}
			/>,
		);

		const current = screen.getByText("Projects");
		expect(current).toHaveAttribute("aria-current", "page");
		expect(screen.queryByRole("link", { name: "Projects" })).toBeNull();
	});

	it("keeps the trail above overlapping page surfaces so ancestor links stay clickable", () => {
		const { container } = render(
			<BreadcrumbSidebar
				list={[
					{ name: "Pipelines", href: "/dashboard/pipelines" },
					{ name: "research" },
				]}
			/>,
		);

		expect(container.querySelector("header")).toHaveClass("relative", "z-20");
		expect(screen.getByRole("link", { name: "Pipelines" })).toHaveAttribute(
			"href",
			"/dashboard/pipelines",
		);
	});

	it("keeps ancestors navigable and gives long labels a full-text title", () => {
		render(
			<BreadcrumbSidebar
				list={[
					{ name: "Datasets", href: "/dashboard/datasets" },
					{ name: "Cyber Gym", href: "/dashboard/datasets/ds-1" },
					{ name: "A very long evaluation name" },
				]}
			/>,
		);

		expect(screen.getByRole("link", { name: "Datasets" })).toHaveAttribute(
			"href",
			"/dashboard/datasets",
		);
		expect(screen.getByRole("link", { name: "Cyber Gym" })).toHaveAttribute(
			"href",
			"/dashboard/datasets/ds-1",
		);
		expect(screen.getByText("A very long evaluation name")).toHaveAttribute(
			"title",
			"A very long evaluation name",
		);
	});
});
