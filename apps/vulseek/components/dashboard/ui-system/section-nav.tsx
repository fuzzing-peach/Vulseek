import * as React from "react";
import { cn } from "@/lib/utils";

export type SectionNavItem = {
	/** DOM id of the section this entry scrolls to. */
	id: string;
	label: string;
	/** Renders the entry with destructive emphasis (e.g. danger zone). */
	danger?: boolean;
};

/**
 * SectionNav — sticky in-page navigation for long configuration pages.
 * Each entry anchors to the section with the matching id; the section
 * currently in view is highlighted via IntersectionObserver.
 */
export const SectionNav = ({ items }: { items: SectionNavItem[] }) => {
	const [activeId, setActiveId] = React.useState(items[0]?.id ?? "");
	const itemIds = items.map((item) => item.id).join(",");

	React.useEffect(() => {
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) setActiveId(entry.target.id);
				}
			},
			{ rootMargin: "-10% 0px -75% 0px" },
		);
		for (const id of itemIds.split(",")) {
			const element = document.getElementById(id);
			if (element) observer.observe(element);
		}
		return () => observer.disconnect();
	}, [itemIds]);

	return (
		<nav aria-label="Sections" className="flex flex-col gap-1">
			{items.map((item) => (
				<a
					key={item.id}
					href={`#${item.id}`}
					className={cn(
						"rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
						activeId === item.id && "bg-muted font-medium text-foreground",
						item.danger &&
							(activeId === item.id
								? "text-destructive"
								: "hover:text-destructive"),
					)}
				>
					{item.label}
				</a>
			))}
		</nav>
	);
};
