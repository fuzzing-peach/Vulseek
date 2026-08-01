import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const readComponent = () =>
	readFileSync(
		join(process.cwd(), "components/dashboard/scanning/show-scan-job-detail.tsx"),
		"utf8",
	);

describe("job tab routing", () => {
	it("writes the selected tab to the shallow URL query", () => {
		const source = readComponent();
		const tabsValue = source.indexOf("value={activeTab}");
		const tabsStart = source.lastIndexOf("<Tabs", tabsValue);
		const tabsSource = source.slice(tabsStart, source.indexOf("</Tabs>", tabsStart));

		expect(tabsSource).toContain("const nextTab = value as ScanJobTab;");
		expect(tabsSource).toContain("setActiveTab(nextTab);");
		expect(tabsSource).toContain("router.replace(");
		expect(tabsSource).toContain("applyCandidateListQueryState(");
		expect(tabsSource).toContain("nextTab,");
		expect(tabsSource).toContain("shallow: true");
	});
});
