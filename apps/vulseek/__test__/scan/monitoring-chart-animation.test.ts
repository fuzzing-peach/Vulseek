import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const readComponent = (relativePath: string) =>
	readFileSync(join(process.cwd(), "components/dashboard", relativePath), "utf8");

describe("scan monitoring charts", () => {
	it.each([
		"scanning/scan-monitoring.tsx",
		"monitoring/scan/global-scan-monitoring.tsx",
	])("finishes linear area interpolation before the next live sample in %s", (path) => {
		const source = readComponent(path);
		const area = source.match(/<Area\s[\s\S]*?\/>/)?.[0];

		expect(area).toContain("isAnimationActive={true}");
		expect(area).toContain("animationDuration={1000}");
		expect(area).toContain('animationEasing="linear"');
	});

	it.each([
		"scanning/scan-monitoring.tsx",
		"monitoring/scan/global-scan-monitoring.tsx",
	])("keeps the live chart grid stationary in %s", (path) => {
		const source = readComponent(path);
		const grid = source.match(/<CartesianGrid\s[\s\S]*?\/>/)?.[0];

		expect(grid).toContain("vertical={false}");
	});
});
