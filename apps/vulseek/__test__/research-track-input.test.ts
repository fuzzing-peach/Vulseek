import { describe, expect, it } from "vitest";
import {
	assertResearchTrackIdentity,
	enrichResearchTrackInput,
} from "@vulseek/server/services/scan/stages/research-track-input";

describe("enrichResearchTrackInput", () => {
	it("injects the canonical trackId for discovery tasks", async () => {
		const input = {
			track: {
				trackKey: "network-site-isolation",
				status: "queued",
			},
		};

		const enriched = await enrichResearchTrackInput({
			stageName: "vulnerability-discovery",
			stageInput: input,
			resolveTrack: async (trackKey) =>
				trackKey === "network-site-isolation"
					? {
							trackKey: "network-site-isolation",
							trackId: "track-network-site-isolation",
						}
					: null,
		});

		expect(enriched).toEqual({
			track: {
				trackKey: "network-site-isolation",
				trackId: "track-network-site-isolation",
				status: "queued",
			},
		});
		expect(input.track).not.toHaveProperty("trackId");
	});

	it("rebinds a stale track key only when the resolver returns a canonical identity", async () => {
		const enriched = await enrichResearchTrackInput({
			stageName: "vulnerability-discovery",
			stageInput: {
				track: {
					trackKey: "account-lifecycle-and-token-boundaries",
					approachFamily: "account-lifecycle-and-token-boundaries",
				},
			},
			resolveTrack: async () => ({
				trackKey: "account-lifecycle-and-token-recovery",
				trackId: "track-account-lifecycle-tokens",
			}),
		});

		expect(enriched).toEqual({
			track: {
				trackKey: "account-lifecycle-and-token-recovery",
				trackId: "track-account-lifecycle-tokens",
				approachFamily: "account-lifecycle-and-token-boundaries",
			},
		});
	});

	it("rejects a stale key when no unique canonical identity exists", async () => {
		await expect(
			enrichResearchTrackInput({
				stageName: "vulnerability-discovery",
				stageInput: {
					track: {
						trackKey: "stale-track",
						approachFamily: "ambiguous-family",
					},
				},
				resolveTrack: async () => null,
			}),
		).rejects.toThrow("No canonical Registry trackId");
	});

	it("leaves non-track research inputs unchanged", async () => {
		const input = { scopePath: "/task/scope.json" };
		await expect(
			enrichResearchTrackInput({
				stageName: "surface-map",
				stageInput: input,
				resolveTrack: async () => null,
			}),
		).resolves.toBe(input);
	});

	it("rejects a discovery output whose trackId is not the Registry id", async () => {
		await expect(
			assertResearchTrackIdentity({
				stageName: "vulnerability-discovery",
				stageInput: { track: { trackKey: "network-site-isolation" } },
				stageOutput: { trackId: "network-site-isolation" },
				resolveTrack: async () => ({
					trackKey: "network-site-isolation",
					trackId: "track-network-site-isolation",
				}),
			}),
		).rejects.toThrow("canonical Registry trackId");
	});

	it("rejects a discovery output when the assigned Track is missing", async () => {
		await expect(
			assertResearchTrackIdentity({
				stageName: "vulnerability-discovery",
				stageInput: { track: { trackKey: "missing-track" } },
				stageOutput: { trackId: "track-missing-track" },
				resolveTrack: async () => null,
			}),
		).rejects.toThrow("No canonical Registry trackId");
	});
});
