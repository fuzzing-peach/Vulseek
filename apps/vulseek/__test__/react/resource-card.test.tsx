import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  CollectionSection,
  DashboardPage,
  DashboardPageBody,
  DashboardPageHeader,
  DashboardPageTabContent,
  ResourceCard,
} from "@/components/dashboard/ui-system";
import { Card } from "@/components/ui/card";

describe("ResourceCard", () => {
  it("keeps the primary link separate from the actions slot", () => {
    render(
      <ResourceCard
        href="/dashboard/projects/project-1"
        title="Project One"
        description="A project"
        actions={<button type="button">Actions</button>}
        metadata={<span>3 profiles</span>}
        footer={<span>Created today</span>}
      />,
    );

    const link = screen.getByRole("link", { name: "Project One" });
    const action = screen.getByRole("button", { name: "Actions" });

    expect(link).toHaveAttribute("href", "/dashboard/projects/project-1");
    expect(action.closest("a")).toBeNull();
    expect(screen.getByText("3 profiles")).toBeInTheDocument();
    expect(screen.getByText("Created today")).toBeInTheDocument();
    expect(link.closest("[data-size]")).toHaveAttribute("data-size", "default");
    expect(link.closest("[data-size]")).toHaveClass("rounded-xl", "ring-1");
    const title = screen.getByRole("heading", { name: "Project One" });
    expect(title.parentElement?.parentElement).toHaveClass(
      "grid",
      "gap-1",
      "p-5",
    );
    expect(title.parentElement).toHaveClass("pointer-events-none");
    expect(screen.getByText("Created today").parentElement).toHaveClass(
      "h-5",
      "w-full",
      "min-w-0",
      "items-center",
    );
  });

  it("supports the compact card size through the shared Card primitive", () => {
    render(<Card size="sm">Compact</Card>);
    expect(screen.getByText("Compact").closest("[data-size]")).toHaveAttribute(
      "data-size",
      "sm",
    );
  });
});

describe("DashboardPage spacing", () => {
  it("uses dynamic headers, bordered body spacing and tab content rhythm", () => {
    render(
      <DashboardPage>
        <DashboardPageHeader title="Projects" description="Manage projects" />
        <DashboardPageBody>
          <DashboardPageTabContent>Rows</DashboardPageTabContent>
        </DashboardPageBody>
      </DashboardPage>,
    );

    const header = screen
      .getByRole("heading", { name: "Projects" })
      .closest("header");
    expect(header).toHaveClass("flex", "h-[5.75rem]", "border-b", "px-4");
    expect(header).not.toHaveClass("flex-wrap");
    expect(screen.getByRole("main")).toHaveClass(
      "flex-1",
      "px-4",
      "pt-5",
      "pb-6",
      "sm:px-6",
    );
    expect(screen.getByText("Rows")).toBeInTheDocument();
  });
});

describe("CollectionSection", () => {
  it("renders a heading, description, actions and collection content", () => {
    render(
      <CollectionSection
        title="Evaluations"
        description="Recent runs"
        actions={<button type="button">Create</button>}
      >
        <div>Evaluation rows</div>
      </CollectionSection>,
    );

    expect(
      screen.getByRole("heading", { name: "Evaluations" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Recent runs")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create" })).toBeInTheDocument();
    expect(screen.getByText("Evaluation rows")).toBeInTheDocument();
  });
});
