/**
 * EntityStatus — single source of truth for status semantics across the UI.
 *
 * Domain components pass a raw status value; this module maps it to one of
 * six semantic kinds. Pages must never choose color classes themselves.
 *
 * Kinds:
 * - neutral: no progress signal, terminal without result
 * - info:    preparing / starting, waiting for something to begin
 * - active:  currently executing — the only kind allowed to animate (pulse/spinner)
 * - success: finished with a positive outcome
 * - warning: paused or needing attention
 * - danger:  failed or invalidated
 *
 * Status text is rendered in sentence case by consumers; do not rely on CSS
 * `capitalize` to fix database values.
 */

export type EntityStatusKind =
	| "neutral"
	| "info"
	| "active"
	| "success"
	| "warning"
	| "danger";

export const ENTITY_STATUS_KINDS: readonly EntityStatusKind[] = [
	"neutral",
	"info",
	"active",
	"success",
	"warning",
	"danger",
] as const;

/**
 * Exhaustive known values per kind. `entityStatusKind` falls back to
 * "neutral" for values not listed here — extend this map when new statuses
 * appear, never add a color class in a page.
 */
export const ENTITY_STATUS_VALUES: Record<EntityStatusKind, readonly string[]> =
	{
		neutral: [
			"pending",
			"queued",
			"idle",
			"canceled",
			"exited",
			"candidate",
			"exhausted",
			"unknown",
			"pruned",
		],
		info: ["preparing", "launching", "starting", "discovered", "validated"],
		active: ["running", "dispatching", "finalizing", "active", "checking-out"],
		success: [
			"ready",
			"completed",
			"finished",
			"accepted",
			"confirmed",
			"finding-found",
			"success",
		],
		warning: [
			"paused",
			"partially_finished",
			"needs-more-evidence",
			"blocked",
			"revise-chain",
			"primitive-gap",
			"runtime-retry",
			"chain-revision",
		],
		danger: ["failed", "error", "invalidated", "false-positive"],
	};

const STATUS_LOOKUP = new Map<string, EntityStatusKind>();
for (const [kind, values] of Object.entries(ENTITY_STATUS_VALUES)) {
	for (const value of values) {
		STATUS_LOOKUP.set(value, kind as EntityStatusKind);
	}
}

/** Map a raw status value (case-insensitive) to its semantic kind. */
export function entityStatusKind(
	value: string | null | undefined,
): EntityStatusKind {
	if (!value) return "neutral";
	return STATUS_LOOKUP.get(value.toLowerCase()) ?? "neutral";
}

/** True for kinds that are allowed to show running-state animation. */
export function isAnimatedKind(kind: EntityStatusKind): boolean {
	return kind === "active";
}

/** True when the value maps to a running/executing state. */
export function isAnimatedStatus(value: string | null | undefined): boolean {
	return isAnimatedKind(entityStatusKind(value));
}

/** Human label for a kind, used in filter options and tooltips. */
export const ENTITY_STATUS_KIND_LABELS: Record<EntityStatusKind, string> = {
	neutral: "Idle",
	info: "Preparing",
	active: "Running",
	success: "Ready",
	warning: "Paused",
	danger: "Failed",
};
