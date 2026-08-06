import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const readPanel = () =>
	readFileSync(
		join(
			process.cwd(),
			"components/dashboard/scanning/research-registry-panels.tsx",
		),
		"utf8",
	);

const readCollectionView = () =>
	readFileSync(
		join(process.cwd(), "components/dashboard/ui-system/collection-view.tsx"),
		"utf8",
	);

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

	it("renders through the shared CollectionView contract with URL-backed state", () => {
		const source = readPanel();
		expect(source).toContain("CollectionView");
		expect(source).toContain("useCollectionQuery");
		expect(source).toContain("emptyTitle");
		expect(source).toContain("isRefreshing");
		expect(source).toContain("searchPlaceholder");
	});

	it("provides a columns-derived mobile card fallback for every registry list", () => {
		const source = readPanel();
		const collectionView = readCollectionView();
		expect(source).toContain("registryMobileCard");
		// The card must be wired into the shared CollectionView…
		expect(source).toContain(
			"mobileRender={registryMobileCard(columns, openDetail)}",
		);
		// …and the CollectionView shows the card fallback only below the
		// desktop table (md and up keeps the table).
		expect(collectionView).toContain('"hidden md:block"');
		expect(collectionView).toContain(
			'className="flex flex-col gap-4 md:hidden"',
		);
		// Card title opens the route-backed detail.
		expect(source).toContain("onClick={() => onOpen(item)}");
		expect(source).toContain('className="rounded-lg border bg-card p-3"');
	});

	it("keeps details route-backed via the shared detail query helpers", () => {
		const source = readPanel();
		expect(source).toContain("parseDetailId");
		expect(source).toContain("detailQueryParam");
		expect(source).toContain("withoutDetailParam");
		expect(source).toContain("EntityDetailSheet");
		expect(source).toContain("detailRenderer");
	});

	it("uses shared enum filters and status mapping instead of local classes", () => {
		const source = readPanel();
		expect(source).toContain("RESEARCH_REGISTRY_FILTER_OPTIONS");
		expect(source).toContain("RESEARCH_REGISTRY_SORT_OPTIONS");
		expect(source).toContain("StatusBadge");
		expect(source).not.toContain("RegistryFilterPopover");
		expect(source).not.toContain("state.setStatuses");
		expect(source).not.toContain('variant="red"');
		expect(source).not.toContain("statusClassName");
	});

	it("wraps long registry values inside their table cells", () => {
		const source = readPanel();
		expect(source).toContain("[overflow-wrap:anywhere]");
		expect(source).toContain("whitespace-normal break-words");
	});

	it("renders findings without assuming location is present", () => {
		const source = readPanel();
		expect(source).toContain("location?.filePath");
		expect(source).toContain("Unknown location");
	});

	it("keeps all four tabs mounted under the registry panel", () => {
		const source = readPanel();
		expect(source).toContain('<TabsContent value="findings" className="pt-2">');
		expect(source).toContain('<TabsContent value="tracks" className="pt-2">');
		expect(source).toContain(
			'<TabsContent value="primitives" className="pt-2">',
		);
		expect(source).toContain('<TabsContent value="chains" className="pt-2">');
	});
});
