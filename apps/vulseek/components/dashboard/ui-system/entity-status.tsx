import { cva, type VariantProps } from "class-variance-authority";
import { Check, X } from "lucide-react";
import type * as React from "react";
import {
	type EntityStatusKind,
	entityStatusKind,
	isAnimatedKind,
} from "@/lib/ui-system/entity-status";
import { cn } from "@/lib/utils";

/**
 * Status rendering layer — domain components pass a raw status value (or an
 * explicit kind) and never assemble color classes in pages.
 *
 * Semantics:
 * - neutral: gray      (pending, queued, idle, canceled, exited, ...)
 * - info:    blue      (preparing, launching, starting, ...)
 * - active:  green + pulse (running, dispatching, finalizing, ...)
 * - success: green     (ready, completed, finished, accepted, confirmed, ...)
 * - warning: amber     (paused, partially_finished, needs-more-evidence, ...)
 * - danger:  red       (failed, error, invalidated, false-positive, ...)
 */

const statusBadgeVariants = cva(
	// w-fit + shrink-0: never stretch full-width inside flex column parents
	"inline-flex h-5 w-fit max-w-full shrink-0 items-center gap-1 rounded-md border border-transparent px-1.5 text-[11px] font-medium whitespace-nowrap",
	{
		variants: {
			kind: {
				neutral: "bg-muted text-muted-foreground",
				info: "bg-blue-600/10 text-blue-700 dark:bg-blue-500/15 dark:text-blue-400",
				active:
					"bg-emerald-600/10 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400",
				success:
					"bg-emerald-600/10 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400",
				warning:
					"bg-amber-600/10 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400",
				danger:
					"bg-red-600/10 text-red-700 dark:bg-red-500/15 dark:text-red-400",
			},
		},
		defaultVariants: {
			kind: "neutral",
		},
	},
);

export type StatusBadgeProps = VariantProps<typeof statusBadgeVariants> & {
	/** Raw status value; auto-mapped to a kind when `kind` is not given. */
	value?: string | null;
	/** Display text; defaults to the raw value in sentence case. */
	label?: string;
	/** Force animation on/off; defaults to animating only the active kind. */
	pulse?: boolean;
	className?: string;
};

export const StatusBadge = ({
	value,
	kind,
	label,
	pulse,
	className,
}: StatusBadgeProps) => {
	const resolvedKind: EntityStatusKind = kind ?? entityStatusKind(value);
	const shouldAnimate = pulse ?? isAnimatedKind(resolvedKind);
	const display = label ?? value ?? "";
	return (
		<output
			className={cn(statusBadgeVariants({ kind: resolvedKind }), className)}
		>
			{shouldAnimate && (
				<span
					aria-hidden
					className="size-1.5 animate-pulse rounded-full bg-current"
				/>
			)}
			<span className="truncate">{display}</span>
		</output>
	);
};

/** Auto-mapping alias — pass a raw value, get the semantic badge. */
export const EntityStatus = ({
	value,
	...props
}: Omit<StatusBadgeProps, "value"> & { value: string | null | undefined }) => (
	<StatusBadge value={value ?? undefined} {...props} />
);

/** Neutral monospace badge for IDs, paths and other metadata. */
export const MetadataBadge = ({
	className,
	children,
	...props
}: React.HTMLAttributes<HTMLSpanElement>) => (
	<span
		className={cn(
			"inline-flex h-5 shrink-0 items-center rounded-md bg-muted px-1.5 font-mono text-xs text-muted-foreground whitespace-nowrap",
			className,
		)}
		{...props}
	>
		{children}
	</span>
);

export type FilterChipProps = {
	label: string;
	selected: boolean;
	count?: number;
	onToggle: () => void;
	className?: string;
};

/** Toggleable filter chip used in CollectionView filter rows. */
export const FilterChip = ({
	label,
	selected,
	count,
	onToggle,
	className,
}: FilterChipProps) => (
	<button
		type="button"
		aria-pressed={selected}
		onClick={onToggle}
		className={cn(
			"inline-flex h-8 items-center gap-1 rounded-lg border px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
			selected
				? "border-primary/40 bg-primary/10 text-foreground"
				: "border-border bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground",
			className,
		)}
	>
		{selected ? (
			<Check aria-hidden className="size-3.5 text-primary" />
		) : (
			<span aria-hidden className="size-3.5 opacity-0" />
		)}
		{label}
		{typeof count === "number" && (
			<span className="font-mono text-[11px] opacity-70">{count}</span>
		)}
	</button>
);

/** Toggleable clear/false chip used in boolean filters. */
export const ClearFilterChip = ({
	label,
	onClear,
	className,
}: Omit<FilterChipProps, "selected" | "count" | "onToggle"> & {
	onClear: () => void;
}) => (
	<button
		type="button"
		onClick={onClear}
		className={cn(
			"inline-flex h-8 items-center gap-1 rounded-lg border border-border bg-background px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
			className,
		)}
	>
		{label}
		<X aria-hidden className="size-3.5" />
	</button>
);
