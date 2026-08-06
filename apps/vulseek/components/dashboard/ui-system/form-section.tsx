import { CheckCircle2, Loader2, TriangleAlert } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * FormSection — a labeled group of form controls with a light border.
 * Long configuration pages split into sections with a sticky FormActions
 * bar; every section keeps one clear save scope.
 */

export type FormSectionProps = {
	title: React.ReactNode;
	description?: React.ReactNode;
	/** Optional action rendered on the right of the section header. */
	action?: React.ReactNode;
	children: React.ReactNode;
	className?: string;
};

export const FormSection = ({
	title,
	description,
	action,
	children,
	className,
}: FormSectionProps) => {
	const titleId = React.useId();
	return (
		<section
			aria-labelledby={titleId}
			className={cn("rounded-xl border bg-card", className)}
		>
			<div className="flex items-start justify-between gap-4 border-b px-4 py-3.5 sm:px-5">
				<div className="min-w-0">
					<h2 id={titleId} className="text-base font-semibold leading-6">
						{title}
					</h2>
					{description && (
						<p className="mt-0.5 text-sm text-muted-foreground">
							{description}
						</p>
					)}
				</div>
				{action && <div className="shrink-0">{action}</div>}
			</div>
			<div className="px-4 py-4 sm:px-5">{children}</div>
		</section>
	);
};

/**
 * Tracks the FormActions status for a react-hook-form powered section:
 * `dirty` while the form has edits, cleared back to `idle` after a reset,
 * with `saving`/`saved`/`error` driven by the caller around the mutation.
 */
export const useFormSaveStatus = (isDirty: boolean) => {
	const [status, setStatus] = React.useState<FormActionsStatus>("idle");

	React.useEffect(() => {
		setStatus((current) => {
			if (current === "saving") return current;
			if (isDirty) return "dirty";
			return current === "dirty" || current === "error" ? "idle" : current;
		});
	}, [isDirty]);

	return [status, setStatus] as const;
};

export type FormActionsStatus = "idle" | "dirty" | "saving" | "saved" | "error";

export type FormActionsProps = {
	status: FormActionsStatus;
	onSave: () => void;
	onReset?: () => void;
	/** Save button label; defaults to "Save". */
	saveLabel?: React.ReactNode;
	/** When true the save button is disabled. */
	disabled?: boolean;
	/** Optional extra actions rendered before the save button. */
	children?: React.ReactNode;
	className?: string;
};

const STATUS_TEXT: Record<FormActionsStatus, string | null> = {
	idle: null,
	dirty: "Unsaved changes",
	saving: "Saving…",
	saved: "Saved",
	error: "Could not save — check the fields above",
};

/** Sticky action bar with explicit dirty/saving/saved/error feedback. */
export const FormActions = ({
	status,
	onSave,
	onReset,
	saveLabel = "Save",
	disabled,
	children,
	className,
}: FormActionsProps) => {
	const statusText = STATUS_TEXT[status];
	return (
		<div
			className={cn(
				"sticky bottom-0 z-10 -mx-4 flex flex-col gap-2 border-t bg-background/95 px-4 py-3 backdrop-blur sm:-mx-5 sm:flex-row sm:items-center sm:justify-between sm:px-5",
				className,
			)}
		>
			<div
				className={cn(
					"flex min-h-5 items-center gap-1.5 text-xs",
					status === "error" && "text-destructive",
					status === "saved" && "text-emerald-600 dark:text-emerald-400",
					status === "dirty" && "text-amber-600 dark:text-amber-400",
					(status === "saving" || status === "idle") && "text-muted-foreground",
				)}
				aria-live="polite"
			>
				{status === "saving" && (
					<Loader2 aria-hidden className="size-3.5 animate-spin" />
				)}
				{status === "saved" && (
					<CheckCircle2 aria-hidden className="size-3.5" />
				)}
				{status === "error" && (
					<TriangleAlert aria-hidden className="size-3.5" />
				)}
				{statusText}
			</div>
			<div className="flex shrink-0 items-center gap-2">
				{children}
				{onReset && (
					<Button type="button" variant="outline" size="sm" onClick={onReset}>
						Reset
					</Button>
				)}
				<Button
					type="button"
					size="sm"
					onClick={onSave}
					disabled={disabled || status === "saving"}
					isLoading={status === "saving"}
				>
					{saveLabel}
				</Button>
			</div>
		</div>
	);
};
