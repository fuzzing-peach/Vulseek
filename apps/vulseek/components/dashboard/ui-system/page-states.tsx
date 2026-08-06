import type { LucideIcon } from "lucide-react";
import type * as React from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Shared page-level states. Loading uses skeletons of the final row shape,
 * empty and error states render inside the same surface with the same
 * layout, so pages never hand-roll these.
 */

export type LoadingStateProps = {
	/** Number of skeleton rows to show. */
	rows?: number;
	className?: string;
};

export const LoadingState = ({ rows = 5, className }: LoadingStateProps) => (
	<div
		className={cn("flex flex-col gap-4", className)}
		aria-busy="true"
		aria-live="polite"
	>
		{Array.from({ length: rows }, (_, index) => `skeleton-row-${index}`).map(
			(skeletonKey) => (
				<div key={skeletonKey} className="flex items-center gap-3">
					<Skeleton className="h-9 flex-1" />
					<Skeleton className="h-9 w-24" />
					<Skeleton className="hidden h-9 w-16 sm:block" />
				</div>
			),
		)}
	</div>
);

export type EmptyStateProps = {
	icon?: LucideIcon;
	title: string;
	description?: React.ReactNode;
	/** Optional single action (usually a primary button). */
	action?: React.ReactNode;
	className?: string;
};

export const EmptyState = ({
	icon: Icon,
	title,
	description,
	action,
	className,
}: EmptyStateProps) => (
	<div
		className={cn(
			"flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-6 py-14 text-center",
			className,
		)}
	>
		{Icon && (
			<div className="mb-1 flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground [&>svg]:size-5">
				<Icon aria-hidden />
			</div>
		)}
		<h3 className="text-sm font-semibold">{title}</h3>
		{description && (
			<p className="max-w-sm text-sm text-muted-foreground">{description}</p>
		)}
		{action && <div className="mt-2">{action}</div>}
	</div>
);

export type ErrorStateProps = {
	title?: string;
	description?: React.ReactNode;
	onRetry?: () => void;
	className?: string;
};

export const ErrorState = ({
	title = "Something went wrong",
	description = "The data could not be loaded. Try again in a moment.",
	onRetry,
	className,
}: ErrorStateProps) => (
	<div
		className={cn(
			"flex flex-col items-center justify-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-6 py-14 text-center",
			className,
		)}
		role="alert"
	>
		<h3 className="text-sm font-semibold text-destructive">{title}</h3>
		{description && (
			<p className="max-w-sm text-sm text-muted-foreground">{description}</p>
		)}
		{onRetry && (
			<div className="mt-2">
				<Button variant="outline" size="sm" onClick={onRetry}>
					Retry
				</Button>
			</div>
		)}
	</div>
);
