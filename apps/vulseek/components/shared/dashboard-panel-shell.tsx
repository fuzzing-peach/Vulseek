import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type DashboardPanelShellProps = {
	children: ReactNode;
	className?: string;
	contentClassName?: string;
};

export const DashboardPanelShell = ({
	children,
	className,
	contentClassName,
}: DashboardPanelShellProps) => (
	<Card
		className={cn(
			"h-full w-full rounded-xl bg-sidebar p-2.5",
			className,
		)}
	>
		<div
			className={cn(
				"rounded-xl bg-background shadow-md",
				contentClassName,
			)}
		>
			{children}
		</div>
	</Card>
);
