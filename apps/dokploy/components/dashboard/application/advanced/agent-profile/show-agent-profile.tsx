"use client";

import { ScanStageSettingsPanel } from "@/components/dashboard/shared/scan-stage-settings-panel";
import { api } from "@/utils/api";

interface Props {
	applicationId: string;
}

export const ShowAgentProfile = ({ applicationId }: Props) => {
	const { data } = api.application.one.useQuery(
		{ applicationId },
		{ enabled: !!applicationId },
	);
	const { data: agentProfiles } = api.ai.getAgentProfiles.useQuery();
	const utils = api.useUtils();
	const { mutateAsync } = api.application.update.useMutation();

	return (
		<ScanStageSettingsPanel
			target={data}
			agentProfiles={agentProfiles}
			onSave={async (payload) => {
				await mutateAsync({
					applicationId,
					...payload,
				});
				await utils.application.one.invalidate({ applicationId });
			}}
		/>
	);
};
