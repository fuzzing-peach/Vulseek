import { addVulseekNetworkToRoot } from "@vulseek/server";
import { describe, expect, it } from "vitest";

describe("addVulseekNetworkToRoot", () => {
	it("should create network object if networks is undefined", () => {
		const result = addVulseekNetworkToRoot(undefined);
		expect(result).toEqual({ "vulseek-network": { external: true } });
	});

	it("should add network to an empty object", () => {
		const result = addVulseekNetworkToRoot({});
		expect(result).toEqual({ "vulseek-network": { external: true } });
	});

	it("should not modify existing network configuration", () => {
		const existing = { "vulseek-network": { external: false } };
		const result = addVulseekNetworkToRoot(existing);
		expect(result).toEqual({ "vulseek-network": { external: true } });
	});

	it("should add network alongside existing networks", () => {
		const existing = { "other-network": { external: true } };
		const result = addVulseekNetworkToRoot(existing);
		expect(result).toEqual({
			"other-network": { external: true },
			"vulseek-network": { external: true },
		});
	});
});
