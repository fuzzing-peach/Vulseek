type ResearchTrackInput = {
	track?: Record<string, unknown>;
};

export type ResolvedResearchTrackIdentity = {
	trackKey: string;
	trackId: string;
};

const TRACK_BOUND_STAGES = new Set([
	"vulnerability-discovery",
	"track-review",
	"finding-validation",
	"finding-review",
	"chain-synthesis",
	"chain-review",
	"exploit-validation",
	"exploit-review",
]);

export const enrichResearchTrackInput = async (input: {
	stageName: string;
	stageInput: unknown;
	resolveTrack: (
		trackKey: string,
		approachFamily?: string | null,
	) => Promise<ResolvedResearchTrackIdentity | null>;
}) => {
	if (
		!TRACK_BOUND_STAGES.has(input.stageName) ||
		!input.stageInput ||
		typeof input.stageInput !== "object" ||
		Array.isArray(input.stageInput)
	) {
		return input.stageInput;
	}

	const stageInput = input.stageInput as ResearchTrackInput;
	const track = stageInput.track;
	if (!track || typeof track.trackKey !== "string" || !track.trackKey) {
		return input.stageInput;
	}

	const identity = await input.resolveTrack(
		track.trackKey,
		typeof track.approachFamily === "string" ? track.approachFamily : null,
	);
	if (!identity) {
		throw new Error(
			`No canonical Registry trackId exists for assigned Track ${track.trackKey}`,
		);
	}
	if (
		track.trackKey === identity.trackKey &&
		track.trackId === identity.trackId
	) {
		return input.stageInput;
	}

	return {
		...stageInput,
		track: {
			...track,
			trackKey: identity.trackKey,
			trackId: identity.trackId,
		},
	};
};

export const assertResearchTrackIdentity = async (input: {
	stageName: string;
	stageInput: unknown;
	stageOutput: unknown;
	resolveTrack: (
		trackKey: string,
		approachFamily?: string | null,
	) => Promise<ResolvedResearchTrackIdentity | null>;
}) => {
	if (input.stageName !== "vulnerability-discovery") return;
	if (
		!input.stageInput ||
		typeof input.stageInput !== "object" ||
		Array.isArray(input.stageInput) ||
		!input.stageOutput ||
		typeof input.stageOutput !== "object" ||
		Array.isArray(input.stageOutput)
	) {
		return;
	}

	const track = (input.stageInput as ResearchTrackInput).track;
	const output = input.stageOutput as { trackId?: unknown };
	if (!track || typeof track.trackKey !== "string" || !track.trackKey) return;

	const identity = await input.resolveTrack(
		track.trackKey,
		typeof track.approachFamily === "string" ? track.approachFamily : null,
	);
	if (!identity) {
		throw new Error(
			`No canonical Registry trackId exists for assigned Track ${track.trackKey}`,
		);
	}
	if (output.trackId !== identity.trackId) {
		throw new Error(
			`Discovery output trackId must match the canonical Registry trackId for ${track.trackKey}`,
		);
	}
};
