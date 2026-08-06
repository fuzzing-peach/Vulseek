import { Slot } from "@radix-ui/react-slot";
import * as React from "react";
import { cn } from "@/lib/utils";

/** Full-width vertical list matching Dokploy's compact bordered rows. */
const RowList = React.forwardRef<
	HTMLDivElement,
	React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
	<div
		ref={ref}
		className={cn("flex min-w-0 flex-col gap-4", className)}
		{...props}
	/>
));
RowList.displayName = "RowList";

export interface RowListItemProps extends React.HTMLAttributes<HTMLDivElement> {
	asChild?: boolean;
}

/**
 * One responsive list row. `asChild` lets a Link or label remain the semantic
 * root while receiving the shared row treatment.
 */
const RowListItem = React.forwardRef<HTMLDivElement, RowListItemProps>(
	({ asChild = false, className, ...props }, ref) => {
		const Comp = asChild ? Slot : "div";

		return (
			<Comp
				ref={ref}
				className={cn(
					// Align with dokploy project cards: transparent rest, border-tint on hover
					"flex min-w-0 w-full flex-col gap-4 rounded-xl bg-transparent p-4 ring-1 ring-foreground/10 transition-colors hover:bg-border sm:flex-row sm:items-center sm:justify-between",
					className,
				)}
				{...props}
			/>
		);
	},
);
RowListItem.displayName = "RowListItem";

export { RowList, RowListItem };
