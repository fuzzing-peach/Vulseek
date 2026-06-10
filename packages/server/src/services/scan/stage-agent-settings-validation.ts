import { TRPCError } from "@trpc/server";
import { getAgentProfileById } from "../ai";

type ScanStageSettingsLike = Record<
	string,
	{
		agentProfileId?: string | null;
	}
>;

export type ScanStageAgentSettingsTarget = {
	scanStageSettings?: ScanStageSettingsLike | null;
};

const STAGE_LABELS = {
	"repository-scan": "Scan Repository",
	"module-scan": "Scan Module",
	"function-scan": "Scan Function",
	analyze: "Analyze",
	"build-fuzzer": "Build Fuzzer",
	"run-fuzzer": "Run Fuzzer",
} as const;

const FORK_STAGE_EDGES = [
	["repository-scan", "module-scan"],
	["module-scan", "function-scan"],
	["function-scan", "analyze"],
	["analyze", "build-fuzzer"],
	["build-fuzzer", "run-fuzzer"],
] as const;

const formatProvider = (provider: string | undefined) => {
	if (provider === "claude_code") {
		return "Claude Code";
	}
	if (provider === "codex") {
		return "Codex";
	}
	return provider || "Unknown";
};

const resolveStageAgentProfileId = (
	target: ScanStageAgentSettingsTarget,
	stageName: keyof typeof STAGE_LABELS,
) => target.scanStageSettings?.[stageName]?.agentProfileId || null;

export const validateForkStageAgentProviderCompatibility = async (
	target: ScanStageAgentSettingsTarget,
) => {
	const providersByProfileId = new Map<string, string>();
	const resolveProvider = async (agentProfileId: string | null) => {
		if (!agentProfileId) {
			return null;
		}
		const cached = providersByProfileId.get(agentProfileId);
		if (cached) {
			return cached;
		}
		const profile = await getAgentProfileById(agentProfileId);
		providersByProfileId.set(agentProfileId, profile.provider);
		return profile.provider;
	};

	for (const [parentStageName, childStageName] of FORK_STAGE_EDGES) {
		const parentProfileId = resolveStageAgentProfileId(target, parentStageName);
		const childProfileId = resolveStageAgentProfileId(target, childStageName);
		const parentProvider = await resolveProvider(parentProfileId);
		const childProvider = await resolveProvider(childProfileId);

		if (!parentProvider && !childProvider) {
			continue;
		}
		if (!parentProvider || !childProvider) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: `${STAGE_LABELS[parentStageName]} forks ${STAGE_LABELS[childStageName]}, so both stages must use configured agent profiles of the same type.`,
			});
		}
		if (parentProvider !== childProvider) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: `${STAGE_LABELS[parentStageName]} forks ${STAGE_LABELS[childStageName]}, so both stages must use the same agent type. Current types: ${STAGE_LABELS[parentStageName]} uses ${formatProvider(parentProvider)}, ${STAGE_LABELS[childStageName]} uses ${formatProvider(childProvider)}.`,
			});
		}
	}
};
