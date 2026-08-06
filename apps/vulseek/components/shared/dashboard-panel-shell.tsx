import type { ReactNode } from "react";
import { DashboardPage } from "@/components/dashboard/ui-system";

/**
 * Legacy page container, kept as a thin compatibility alias of the new
 * DashboardPage surface so pages can migrate one at a time. New pages use
 * `DashboardPage` from "@/components/dashboard/ui-system" directly.
 */
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
	<DashboardPage className={className} contentClassName={contentClassName}>
		{children}
	</DashboardPage>
);
