import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type CollectionSectionProps = {
	title: ReactNode;
	description?: ReactNode;
	actions?: ReactNode;
	children: ReactNode;
	className?: string;
	contentClassName?: string;
};

const CollectionSection = ({
	title,
	description,
	actions,
	children,
	className,
	contentClassName,
}: CollectionSectionProps) => (
	// Large rounded panel under tab rails (Jobs / Evaluations / Trials / etc.),
	// matching General-tab Cards: rounded-xl + ring surface.
	<section
		className={cn(
			"flex min-w-0 flex-col rounded-xl bg-background p-6 ring-1 ring-foreground/10",
			className,
		)}
	>
		<header className="flex flex-wrap items-start justify-between gap-4">
			<div className="min-w-0">
				<h2 className="text-base font-medium leading-snug sm:text-xl">
					{title}
				</h2>
				{description ? (
					<p className="mt-1 text-sm text-muted-foreground">{description}</p>
				) : null}
			</div>
			{actions ? (
				<div className="flex shrink-0 flex-wrap items-center gap-2">
					{actions}
				</div>
			) : null}
		</header>
		<div className={cn("mt-4", contentClassName)}>{children}</div>
	</section>
);

export { CollectionSection };
