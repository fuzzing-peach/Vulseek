"use client";

import { ScanStageSettingsPanel } from "@/components/dashboard/shared/scan-stage-settings-panel";
import { api } from "@/utils/api";

interface Props {
	composeId: string;
}

export const ShowAgentProfile = ({ composeId }: Props) => {
	const { data } = api.compose.one.useQuery(
		{ composeId },
		{ enabled: !!composeId },
	);
	const { data: agentProfiles } = api.ai.getAgentProfiles.useQuery();
	const utils = api.useUtils();
	const { mutateAsync } = api.compose.update.useMutation();

	return (
		<ScanStageSettingsPanel
			target={data}
			agentProfiles={agentProfiles}
			onSave={async (payload) => {
				await mutateAsync({
					composeId,
					...payload,
				});
				await utils.compose.one.invalidate({ composeId });
			}}
		/>
	);
};

export const ShowComposeAgentProfile = ShowAgentProfile;
