import Link from "next/link";
import type { ReactNode } from "react";
import {
	Card,
	CardAction,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

export type ResourceCardProps = {
	title: ReactNode;
	description?: ReactNode;
	href?: string;
	icon?: ReactNode;
	metadata?: ReactNode;
	footer?: ReactNode;
	actions?: ReactNode;
	className?: string;
};

const ResourceCard = ({
	title,
	description,
	href,
	icon,
	metadata,
	footer,
	actions,
	className,
}: ResourceCardProps) => {
	return (
		<Card
			className={cn(
				// Fixed height so project / dataset / profile cards stay aligned.
				// h-32 + tighter p-5 ≈ title + 1-line desc + single-line footer.
				"group relative flex h-32 min-w-0 flex-col bg-transparent transition-colors hover:bg-border",
				className,
			)}
		>
			{href ? (
				<Link
					href={href}
					aria-label={typeof title === "string" ? title : undefined}
					className="absolute inset-0 z-10 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
				/>
			) : null}
			{/* Override CardHeader p-6 → p-5 for a denser list-card rhythm */}
			<CardHeader className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-1 p-5 pb-0">
				{/* z-20: paint above absolute href overlay */}
				<div className="relative z-20 min-w-0 space-y-1">
					<CardTitle className="block min-w-0 text-base font-medium leading-6">
						<span className="flex min-w-0 items-center gap-2">
							{icon ? (
								<span className="inline-flex size-5 shrink-0 items-center justify-center text-muted-foreground [&>svg]:size-4">
									{icon}
								</span>
							) : null}
							<span className="min-w-0 flex-1 truncate leading-6">
								{title}
							</span>
						</span>
					</CardTitle>
					{/* Always reserve one description line so cards without copy match height */}
					<CardDescription
						className={cn(
							"line-clamp-1 h-5 text-sm font-medium leading-5",
							!description && "invisible",
						)}
					>
						{description || "\u00A0"}
					</CardDescription>
					{/* Compact inline meta (status tags) — avoid a second CardContent block */}
					{metadata ? (
						<div className="flex min-w-0 flex-wrap items-center gap-1.5 [&>*]:max-w-full">
							{metadata}
						</div>
					) : null}
				</div>
				{actions ? (
					<CardAction className="relative z-20 self-start">{actions}</CardAction>
				) : null}
			</CardHeader>
			{footer ? (
				// Single-line footer; fixed h-5 keeps badge / checkbox / text aligned.
				<CardFooter className="mt-auto gap-3 px-5 pb-5 pt-3">
					<div className="flex h-5 w-full min-w-0 items-center">{footer}</div>
				</CardFooter>
			) : null}
		</Card>
	);
};

export { ResourceCard };
