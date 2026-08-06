import type * as React from "react";
import { useEffect, useRef } from "react";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

/**
 * EntityDetailSheet — right-hand detail panel with fixed size tiers.
 *
 * Details are route-backed: the caller keeps the entity id in the URL
 * (`?detail=<id>` via lib/ui-system/detail-query), so the panel is
 * refreshable, shareable and closed by browser Back. List query parameters
 * stay untouched on the same URL.
 *
 * Sizes: compact 480px, default 640px, wide 800px; full-screen on mobile.
 */

export type EntityDetailSheetSize = "compact" | "default" | "wide";

const SIZE_CLASSES: Record<EntityDetailSheetSize, string> = {
	compact: "sm:max-w-[480px]",
	default: "sm:max-w-[640px]",
	wide: "sm:max-w-[800px]",
};

export type EntityDetailSheetProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: React.ReactNode;
	description?: React.ReactNode;
	children: React.ReactNode;
	footer?: React.ReactNode;
	size?: EntityDetailSheetSize;
	className?: string;
};

export const EntityDetailSheet = ({
	open,
	onOpenChange,
	title,
	description,
	children,
	footer,
	size = "default",
	className,
}: EntityDetailSheetProps) => {
	const contentRef = useRef<HTMLDivElement>(null);
	const restoreFocusRef = useRef<HTMLElement | null>(null);

	// Route-driven reopens (browser history, deep link) can leave focus
	// outside the panel: Radix moves focus when the content mounts, but the
	// browser may restore focus to the removed row/trigger in the same
	// commit, after Radix's default onOpenAutoFocus ran. Re-assert focus
	// inside the content after paint on every open, including reopens.
	// onOpenAutoFocus is prevented so this explicit focus is the single
	// source of truth (plan §7 focus guarantees).
	useEffect(() => {
		if (!open) return;
		restoreFocusRef.current =
			document.activeElement instanceof HTMLElement
				? document.activeElement
				: null;
		const frame = requestAnimationFrame(() => {
			contentRef.current?.focus();
		});
		return () => cancelAnimationFrame(frame);
	}, [open]);

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				ref={contentRef}
				onOpenAutoFocus={(event) => event.preventDefault()}
				onCloseAutoFocus={(event) => {
					// The sheet has no SheetTrigger (it is controlled), so
					// Radix's close default would skip focus restoration
					// entirely. Return focus to the element that had it when
					// the panel opened.
					event.preventDefault();
					restoreFocusRef.current?.focus();
				}}
				className={cn(
					"w-full overflow-y-auto p-0",
					SIZE_CLASSES[size],
					className,
				)}
			>
				<SheetHeader className="border-b px-5 pb-4 pt-5 text-left">
					<SheetTitle className="pr-8 text-lg">{title}</SheetTitle>
					{description && (
						<SheetDescription className="text-sm">
							{description}
						</SheetDescription>
					)}
				</SheetHeader>
				<div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-4">
					{children}
				</div>
				{footer && (
					<SheetFooter className="border-t px-5 py-3.5">{footer}</SheetFooter>
				)}
			</SheetContent>
		</Sheet>
	);
};
