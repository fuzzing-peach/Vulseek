"use client";

import { ScanStageSettingsPanel } from "@/components/dashboard/shared/scan-stage-settings-panel";
import { SecurityPolicyCard } from "@/components/dashboard/shared/security-policy-card";
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
		<div className="grid gap-4">
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
			<SecurityPolicyCard
				value={data?.securityPolicy}
				onSave={async (securityPolicy) => {
					await mutateAsync({
						composeId,
						securityPolicy,
					});
					await utils.compose.one.invalidate({ composeId });
				}}
			/>
		</div>
	);
};

export const ShowComposeAgentProfile = ShowAgentProfile;
