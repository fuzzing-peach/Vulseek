import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
	join(process.cwd(), "server/monitoring/scan-monitoring-hub.ts"),
	"utf8",
);

describe("scan monitoring hub cadence", () => {
	it("does not publish immediately when child samplers update", () => {
		const callbacks = [
			...source.matchAll(
				/const subscription = sampler\.subscribe\(\(snapshot\) => \{([\s\S]*?)\n\s*\}\);/g,
			),
		];

		expect(callbacks).toHaveLength(2);
		for (const callback of callbacks) {
			expect(callback[1]).not.toContain("this.publish()");
		}
	});

	it("publishes job and organization snapshots on one fixed timer each", () => {
		expect(source.match(/private publishTimer\?: NodeJS\.Timeout;/g)).toHaveLength(
			2,
		);
		expect(
			source.match(
				/this\.publishTimer = setInterval\(\(\) => this\.publish\(\), SAMPLE_INTERVAL_MS\);/g,
			),
		).toHaveLength(2);
		expect(
			source.match(/if \(this\.publishTimer\) clearInterval\(this\.publishTimer\);/g),
		).toHaveLength(2);
	});
});
