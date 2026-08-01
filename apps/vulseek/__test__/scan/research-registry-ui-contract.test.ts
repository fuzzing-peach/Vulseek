import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const readPanel = () =>
	readFileSync(join(process.cwd(), "components/dashboard/scanning/research-registry-panels.tsx"), "utf8");

describe("research registry UI contract", () => {
	it("has independent live queries for tracks, primitives, and chains", () => {
		const source = readPanel();
		expect(source).toContain("api.scan.researchFindings.useQuery");
		expect(source).toContain("api.scan.researchTracks.useQuery");
		expect(source).toContain("api.scan.exploitPrimitives.useQuery");
		expect(source).toContain("api.scan.exploitChains.useQuery");
		expect(source).toContain("keepPreviousData: true");
		expect(source).toContain("refetchInterval: active && live ? 4000 : false");
		expect(source).not.toContain("researchFindingEvents");
		expect(source).not.toContain("Event history");
	});

	it("supports empty, loading, search, pagination, and detail states", () => {
		const source = readPanel();
		expect(source).toContain("No matching {title.toLowerCase()}.");
		expect(source).toContain("Loading {title.toLowerCase()}...");
		expect(source).toContain("Search ${title.toLowerCase()}");
		expect(source).toContain("Page {page} / {totalPages}");
		expect(source).toContain("<RegistryDetails");
	});

	it("uses shared enum filters and sortable registry columns", () => {
		const source = readPanel();
		expect(source).toContain("RegistryFilterPopover");
		expect(source).toContain("RESEARCH_REGISTRY_FILTER_OPTIONS");
		expect(source).toContain("state.setStatuses");
		expect(source).toContain("state.setTrustLevels");
		expect(source).toContain("state.setSort");
		expect(source).toContain("sortKey: \"confidence\"");
		expect(source).toContain("sortKey: \"trustLevel\"");
	});

	it("wraps long registry values inside their table cells", () => {
		const source = readPanel();
		expect(source).toContain("align-top [overflow-wrap:anywhere]");
		expect(source).toContain(
			"block max-w-full whitespace-normal break-words [overflow-wrap:anywhere]",
		);
	});

	it("renders findings without assuming location is present", () => {
		const source = readPanel();
		expect(source).toContain("location?.filePath");
		expect(source).toContain("Unknown location");
	});

	it("keeps registry headers compact across all four tabs", () => {
		const source = readPanel();
		expect(source).toContain("rounded-lg border bg-card p-3");
		expect(source).toContain('<div className="space-y-3">');
		expect(source).toContain('className="mt-1 text-sm text-muted-foreground"');
		expect(source).toContain('<TabsContent value="findings" className="pt-2">');
	});
});
