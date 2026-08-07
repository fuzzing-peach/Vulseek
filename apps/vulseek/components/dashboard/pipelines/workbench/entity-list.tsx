import * as React from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Searchable, keyboard-navigable entity list (middle pane of the Definition
 * view). Arrow keys move focus, Enter selects, Esc clears the search. The
 * list is deliberately simple — no virtualization until measured rendering
 * degradation (plan: >200 visible entities).
 */

export type EntityListItem = {
	id: string;
	title: string;
	subtitle?: string;
	badge?: string;
	errorCount?: number;
	warningCount?: number;
};

export type EntityListProps = {
	items: EntityListItem[];
	selectedId: string | null;
	onSelect: (id: string) => void;
	placeholder?: string;
	emptyText: string;
	/** Compact mode hides subtitles/badges (used by the drill-down header). */
	compact?: boolean;
};

export const EntityList = ({
	items,
	selectedId,
	onSelect,
	placeholder = "Search…",
	emptyText,
	compact = false,
}: EntityListProps) => {
	const [filter, setFilter] = React.useState("");
	const [activeIndex, setActiveIndex] = React.useState(0);
	const listRef = React.useRef<HTMLUListElement>(null);

	const filtered = React.useMemo(() => {
		const needle = filter.trim().toLowerCase();
		if (!needle) return items;
		return items.filter(
			(item) =>
				item.title.toLowerCase().includes(needle) ||
				item.subtitle?.toLowerCase().includes(needle) ||
				item.id.toLowerCase().includes(needle),
		);
	}, [items, filter]);

	React.useEffect(() => {
		setActiveIndex((index) => Math.min(index, Math.max(0, filtered.length - 1)));
	}, [filtered.length]);

	const handleKeyDown = (event: React.KeyboardEvent) => {
		if (filtered.length === 0) return;
		if (event.key === "ArrowDown") {
			event.preventDefault();
			setActiveIndex((index) => (index + 1) % filtered.length);
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			setActiveIndex((index) => (index - 1 + filtered.length) % filtered.length);
		} else if (event.key === "Enter") {
			event.preventDefault();
			const item = filtered[activeIndex];
			if (item) onSelect(item.id);
		} else if (event.key === "Escape") {
			setFilter("");
		}
	};

	React.useEffect(() => {
		const active = listRef.current?.querySelector<HTMLElement>("[data-active='true']");
		active?.scrollIntoView({ block: "nearest" });
	}, [activeIndex]);

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="shrink-0 border-b p-2">
				<div className="relative">
					<Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
					<input
						value={filter}
						onChange={(event) => setFilter(event.target.value)}
						onKeyDown={handleKeyDown}
						placeholder={placeholder}
						aria-label={placeholder}
						className="h-8 w-full rounded-md border bg-background pl-7 pr-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
					/>
				</div>
			</div>
			<ul
				ref={listRef}
				className="min-h-0 flex-1 overflow-y-auto"
				role="listbox"
				aria-label="Entities"
			>
				{filtered.length === 0 ? (
					<li className="px-3 py-6 text-center text-xs text-muted-foreground">
						{emptyText}
					</li>
				) : (
					filtered.map((item, index) => {
						const active = index === activeIndex;
						const selected = item.id === selectedId;
						return (
							<li key={item.id} role="option" aria-selected={selected}>
								<button
									type="button"
									data-active={active}
									onClick={() => onSelect(item.id)}
									onFocus={() => setActiveIndex(index)}
									className={cn(
										"flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors",
										selected
											? "bg-primary/10 text-foreground"
											: "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
										active && !selected && "bg-muted/40",
									)}
								>
									<span className="min-w-0 flex-1">
										<span className="block truncate font-medium text-foreground">
											{item.title}
										</span>
										{!compact && item.subtitle ? (
											<span className="block truncate text-muted-foreground">
												{item.subtitle}
											</span>
										) : null}
									</span>
									{item.badge ? (
										<span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px]">
											{item.badge}
										</span>
									) : null}
									{item.errorCount ? (
										<span className="shrink-0 rounded-full bg-red-500/15 px-1.5 py-0.5 text-[10px] text-red-600">
											{item.errorCount}
										</span>
									) : null}
									{item.warningCount && !item.errorCount ? (
										<span className="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600">
											{item.warningCount}
										</span>
									) : null}
								</button>
							</li>
						);
					})
				)}
			</ul>
		</div>
	);
};
