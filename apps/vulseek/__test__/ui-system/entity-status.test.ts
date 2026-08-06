import { describe, expect, it } from "vitest";
import {
	ENTITY_STATUS_KIND_LABELS,
	ENTITY_STATUS_KINDS,
	ENTITY_STATUS_VALUES,
	entityStatusKind,
	isAnimatedKind,
	isAnimatedStatus,
} from "@/lib/ui-system/entity-status";

describe("entityStatusKind", () => {
	it("maps every known value to its documented kind", () => {
		const expectations: Record<string, string> = {
			// neutral
			pending: "neutral",
			queued: "neutral",
			idle: "neutral",
			canceled: "neutral",
			exited: "neutral",
			candidate: "neutral",
			exhausted: "neutral",
			unknown: "neutral",
			pruned: "neutral",
			// info
			preparing: "info",
			launching: "info",
			starting: "info",
			discovered: "info",
			validated: "info",
			// active
			running: "active",
			dispatching: "active",
			finalizing: "active",
			active: "active",
			"checking-out": "active",
			// success
			ready: "success",
			completed: "success",
			finished: "success",
			accepted: "success",
			confirmed: "success",
			"finding-found": "success",
			success: "success",
			// warning
			paused: "warning",
			partially_finished: "warning",
			"needs-more-evidence": "warning",
			blocked: "warning",
			"revise-chain": "warning",
			"primitive-gap": "warning",
			"runtime-retry": "warning",
			"chain-revision": "warning",
			// danger
			failed: "danger",
			error: "danger",
			invalidated: "danger",
			"false-positive": "danger",
		};
		for (const [value, kind] of Object.entries(expectations)) {
			expect(entityStatusKind(value), `value "${value}"`).toBe(kind);
		}
	});

	it("is case-insensitive and trims nothing (raw values pass through)", () => {
		expect(entityStatusKind("RUNNING")).toBe("active");
		expect(entityStatusKind("Running")).toBe("active");
		expect(entityStatusKind("Ready")).toBe("success");
	});

	it("falls back to neutral for unknown, null and empty values", () => {
		expect(entityStatusKind("totally-new-status")).toBe("neutral");
		expect(entityStatusKind(undefined)).toBe("neutral");
		expect(entityStatusKind(null)).toBe("neutral");
		expect(entityStatusKind("")).toBe("neutral");
	});

	it("covers every value listed in ENTITY_STATUS_VALUES exhaustively", () => {
		for (const kind of ENTITY_STATUS_KINDS) {
			for (const value of ENTITY_STATUS_VALUES[kind]) {
				expect(entityStatusKind(value)).toBe(kind);
			}
		}
		// every kind has at least one value and a label
		for (const kind of ENTITY_STATUS_KINDS) {
			expect(ENTITY_STATUS_VALUES[kind].length).toBeGreaterThan(0);
			expect(typeof ENTITY_STATUS_KIND_LABELS[kind]).toBe("string");
		}
	});

	it("only animates the active kind", () => {
		expect(isAnimatedKind("active")).toBe(true);
		for (const kind of ENTITY_STATUS_KINDS) {
			if (kind === "active") continue;
			expect(isAnimatedKind(kind)).toBe(false);
		}
		expect(isAnimatedStatus("running")).toBe(true);
		expect(isAnimatedStatus("paused")).toBe(false);
		expect(isAnimatedStatus("completed")).toBe(false);
	});
});

describe("status vocabulary coverage", () => {
	it("maps every status used across scan, dataset and evaluation domains to a semantic kind", () => {
		// pending/queued/canceled/exited/idle are intentionally neutral per the
		// design table, so only the informative states are asserted here.
		const knownScanStatuses = [
			"running",
			"completed",
			"failed",
			"paused",
			"starting",
			"launching",
			"preparing",
			"dispatching",
			"finalizing",
			"error",
			"finished",
			"partially_finished",
		];
		for (const status of knownScanStatuses) {
			expect(entityStatusKind(status), `scan status "${status}"`).not.toBe(
				"neutral",
			);
		}
	});
});
