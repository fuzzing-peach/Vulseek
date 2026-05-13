import type { AgentProfileLike } from "./types";

export const buildTaskAgentProfileSnapshot = (
	agentProfile: AgentProfileLike | null,
) => ({
	agentProfile:
		agentProfile == null
			? null
			: {
					agentProfileId: agentProfile.agentProfileId,
					name: agentProfile.name,
					provider: agentProfile.provider,
					baseUrl: agentProfile.baseUrl,
					model: agentProfile.model,
					thinkingLevel: agentProfile.thinkingLevel,
				},
});
