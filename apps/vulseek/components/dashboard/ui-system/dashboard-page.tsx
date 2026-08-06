import { useRouter } from "next/router";
import * as React from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { parseTabParam, tabQueryParam } from "@/lib/ui-system/tab-query";
import { cn } from "@/lib/utils";

/**
 * DashboardPage — the single page shell for every dashboard surface.
 *
 * Structure:
 *   DashboardPage (sidebar frame + main surface)
 *     .Header  (icon, title, description, status, actions)
 *     .Tabs    (URL-backed, `?tab=<value>`)
 *     .Body    (content area; sections spaced, no nested heavy Cards)
 *
 * Only one primary surface per page; sections use separators or light
 * borders instead of nested cards.
 */

type DashboardPageProps = {
	children: React.ReactNode;
	className?: string;
	contentClassName?: string;
};

const DashboardPage = ({
	children,
	className,
	contentClassName,
}: DashboardPageProps) => (
	// Outer gray shell matches dokploy: ring border on the sidebar-tinted frame.
	<div
		className={cn(
			"h-full w-full rounded-xl bg-sidebar p-2.5 ring-1 ring-foreground/10",
			className,
		)}
	>
		<div
			className={cn(
				"flex h-full min-h-0 min-w-0 flex-col rounded-xl bg-background shadow-md",
				contentClassName,
			)}
		>
			{children}
		</div>
	</div>
);

type DashboardPageHeaderProps = {
	icon?: React.ReactNode;
	title: React.ReactNode;
	description?: React.ReactNode;
	status?: React.ReactNode;
	/** Primary action first; the rest render after it. */
	actions?: React.ReactNode;
	className?: string;
};

const DashboardPageHeader = ({
	icon,
	title,
	description,
	status,
	actions,
	className,
}: DashboardPageHeaderProps) => (
	// Fixed height locks the border-b so project list → env → profile pages
	// do not jump the divider. Title/description are single-line truncated.
	<header
		className={cn(
			"flex h-[5.75rem] shrink-0 items-center gap-4 border-b px-4 sm:px-6",
			className,
		)}
	>
		<div className="flex min-w-0 flex-1 items-center gap-3">
			{icon ? (
				<div className="flex size-10 shrink-0 items-center justify-center rounded-xl border bg-muted/40 text-muted-foreground [&>svg]:size-5">
					{icon}
				</div>
			) : null}
			<div className="flex min-w-0 flex-1 flex-col justify-center gap-1">
				{/*
				  Do not force [&_button]:size-7 here — env selector shows "/ name"
				  text and gets clipped/overlapped when forced to icon size.
				*/}
				<div className="flex h-7 min-w-0 items-center gap-2">
					{/* no truncate on h1 — complex titles (project + env selector) manage their own */}
					<h1 className="min-w-0 flex-1 text-xl font-semibold leading-7 tracking-tight">
						{title}
					</h1>
					{status}
				</div>
				{/* Always reserve description line so height never depends on copy */}
				<p
					className={cn(
						"h-5 truncate text-sm leading-5 text-muted-foreground",
						!description && "invisible",
					)}
				>
					{description || "\u00A0"}
				</p>
			</div>
		</div>
		{actions ? (
			<div className="flex max-h-10 shrink-0 flex-nowrap items-center gap-2 overflow-hidden">
				{actions}
			</div>
		) : null}
	</header>
);

export type DashboardPageTab = {
	value: string;
	label: React.ReactNode;
	icon?: React.ReactNode;
};

type DashboardPageTabsProps = {
	tabs: readonly DashboardPageTab[];
	fallback: string;
	/**
	 * Tab values the URL parser accepts but that are not rendered as
	 * triggers — keyboard-shortcut destinations (e.g. `g l` → logs,
	 * `g m` → monitoring) land in `?tab=` without a visible trigger.
	 */
	hiddenValues?: readonly string[];
	/** Query key; defaults to the unified `tab`. */
	queryKey?: string;
	className?: string;
	onTabChange?: (value: string) => void;
};

/**
 * URL-backed page tabs — the only tab state lives in `?tab=<value>`.
 * Switching tabs drops unrelated list params? No: it keeps the query and
 * only rewrites the tab key, so list state survives browser history.
 */
const DashboardPageTabs = ({
	tabs,
	fallback,
	hiddenValues,
	queryKey = "tab",
	className,
	onTabChange,
}: DashboardPageTabsProps) => {
	const router = useRouter();
	const values = [...tabs.map((tab) => tab.value), ...(hiddenValues ?? [])];
	const active = parseTabParam(router.query, values, fallback, queryKey);

	const handleValueChange = (value: string) => {
		if (value === active) return;
		if (onTabChange) {
			onTabChange(value);
			return;
		}
		const { [queryKey]: _removed, ...rest } = router.query;
		void router.replace(
			{ query: { ...rest, ...tabQueryParam(value, fallback, queryKey) } },
			undefined,
			{ shallow: true },
		);
	};

	return (
		// pt-8: space under header divider (dokploy ~32px). No extra bottom pad —
		// TabContent / Body owns the gap to the first content block.
		<div className={cn("min-w-0 px-4 pt-8 sm:px-6", className)}>
			<Tabs value={active} onValueChange={handleValueChange}>
				<div className="relative w-full overflow-hidden">
					<div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-4 bg-gradient-to-r from-muted to-transparent sm:hidden" />
					<div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-4 bg-gradient-to-l from-muted to-transparent sm:hidden" />
					<TabsList className="h-10 w-full justify-start gap-4 overflow-x-auto md:gap-8 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
						{tabs.map((tab) => (
							<TabsTrigger
								key={tab.value}
								value={tab.value}
								className="min-w-max flex-none px-3 py-1.5"
							>
								{tab.icon && (
									<span className="mr-1.5 inline-flex [&>svg]:size-4">
										{tab.icon}
									</span>
								)}
								{tab.label}
							</TabsTrigger>
						))}
					</TabsList>
				</div>
			</Tabs>
		</div>
	);
};

const DashboardPageTabContent = ({
	children,
	className,
}: DashboardPageTabContentProps) => (
	// No extra top margin — DashboardPageBody already provides pt after tabs.
	<div className={cn(className)}>{children}</div>
);

type DashboardPageBodyProps = {
	children: React.ReactNode;
	className?: string;
};

type DashboardPageTabContentProps = {
	children: React.ReactNode;
	className?: string;
};

const DashboardPageBody = ({ children, className }: DashboardPageBodyProps) => (
	<main
		className={cn(
			// Modest top pad after header or tabs (avoid py-8 stacking with tabs pt-8)
			"min-h-0 min-w-0 flex-1 px-4 pb-6 pt-5 sm:px-6",
			className,
		)}
	>
		{children}
	</main>
);

/**
 * Icon-only header action with mandatory tooltip + aria-label.
 * `children` must be a single element (usually a `Button`); it is used as
 * the tooltip trigger and gets the aria-label applied to it.
 */
const DashboardPageAction = ({
	label,
	children,
	className,
}: DashboardPageActionProps) => (
	<Tooltip>
		<TooltipTrigger asChild>
			{React.isValidElement(children)
				? React.cloneElement(
						children as React.ReactElement<{
							"aria-label"?: string;
							className?: string;
						}>,
						{
							"aria-label": label,
							className: cn(children.props.className, className),
						},
					)
				: children}
		</TooltipTrigger>
		<TooltipContent>{label}</TooltipContent>
	</Tooltip>
);

type DashboardPageActionProps = {
	label: string;
	children: React.ReactNode;
	className?: string;
};

export {
	DashboardPage,
	DashboardPageAction,
	DashboardPageBody,
	DashboardPageHeader,
	DashboardPageTabs,
	DashboardPageTabContent,
};
