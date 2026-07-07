import { addVulseekNetworkToService } from "@vulseek/server";
import { describe, expect, it } from "vitest";

describe("addVulseekNetworkToService", () => {
	it("should add network to an empty array", () => {
		const result = addVulseekNetworkToService([]);
		expect(result).toEqual(["vulseek-network"]);
	});

	it("should not add duplicate network to an array", () => {
		const result = addVulseekNetworkToService(["vulseek-network"]);
		expect(result).toEqual(["vulseek-network"]);
	});

	it("should add network to an existing array with other networks", () => {
		const result = addVulseekNetworkToService(["other-network"]);
		expect(result).toEqual(["other-network", "vulseek-network"]);
	});

	it("should add network to an object if networks is an object", () => {
		const result = addVulseekNetworkToService({ "other-network": {} });
		expect(result).toEqual({ "other-network": {}, "vulseek-network": {} });
	});
});
