"use client";

import { ScanStageSettingsPanel } from "@/components/dashboard/shared/scan-stage-settings-panel";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/utils/api";
import { ClipboardCheck, TerminalSquare } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

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
	const [postCheckoutScript, setPostCheckoutScript] = useState("");
	const [evaluateAgentProfileId, setEvaluateAgentProfileId] = useState("");
	const [evaluateGroundTruthPath, setEvaluateGroundTruthPath] = useState("");
	const [isSavingPostCheckoutScript, setIsSavingPostCheckoutScript] =
		useState(false);
	const [isSavingEvaluateConfig, setIsSavingEvaluateConfig] = useState(false);
	const enabledAgentProfiles =
		agentProfiles?.filter((profile) => profile.isEnabled) ?? [];

	useEffect(() => {
		setPostCheckoutScript(data?.postCheckoutScript ?? "");
	}, [data?.postCheckoutScript]);

	useEffect(() => {
		setEvaluateAgentProfileId(data?.evaluateConfig?.agentProfileId || "");
		setEvaluateGroundTruthPath(data?.evaluateConfig?.groundTruthPath ?? "");
	}, [data?.evaluateConfig]);

	return (
		<div className="grid gap-4">
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
			<Card className="bg-background">
				<CardHeader>
					<CardTitle className="text-xl flex items-center gap-2">
						<TerminalSquare className="size-5 text-muted-foreground" />
						Post-Checkout Script
					</CardTitle>
					<CardDescription>
						Run a shell script after scan checkout clones the repository and
						submodules.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="grid gap-3">
						<Textarea
							value={postCheckoutScript}
							onChange={(event) =>
								setPostCheckoutScript(event.currentTarget.value)
							}
							placeholder={"./bootstrap.sh\ncmake -S . -B build"}
							className="min-h-40 font-mono text-sm"
							spellCheck={false}
						/>
						<div className="flex justify-end">
							<Button
								type="button"
								disabled={isSavingPostCheckoutScript}
								onClick={async () => {
									setIsSavingPostCheckoutScript(true);
									try {
										await mutateAsync({
											applicationId,
											postCheckoutScript,
										});
										await utils.application.one.invalidate({ applicationId });
										toast.success("Post-checkout script updated");
									} catch {
										toast.error("Failed to update post-checkout script");
									} finally {
										setIsSavingPostCheckoutScript(false);
									}
								}}
							>
								Save
							</Button>
						</div>
					</div>
				</CardContent>
			</Card>
			<Card className="bg-background">
				<CardHeader>
					<CardTitle className="text-xl flex items-center gap-2">
						<ClipboardCheck className="size-5 text-muted-foreground" />
						Evaluate Config
					</CardTitle>
					<CardDescription>
						Default agent profile and ground-truth path used for manual scan
						evaluation.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="grid gap-4">
						<div className="grid gap-2">
							<label
								htmlFor="evaluate-agent-profile"
								className="text-sm font-medium"
							>
								Agent Profile
							</label>
							<Select
								value={evaluateAgentProfileId}
								onValueChange={setEvaluateAgentProfileId}
							>
								<SelectTrigger id="evaluate-agent-profile">
									<SelectValue placeholder="Select an agent profile" />
								</SelectTrigger>
								<SelectContent>
									{enabledAgentProfiles.map((profile) => (
										<SelectItem
											key={profile.agentProfileId}
											value={profile.agentProfileId}
										>
											{profile.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="grid gap-2">
							<label
								htmlFor="evaluate-ground-truth-path"
								className="text-sm font-medium"
							>
								Ground Truth Path
							</label>
							<Input
								id="evaluate-ground-truth-path"
								value={evaluateGroundTruthPath}
								onChange={(event) =>
									setEvaluateGroundTruthPath(event.currentTarget.value)
								}
								placeholder="/workspace/repo/ground_truth.json"
							/>
							<p className="text-xs text-muted-foreground">
								Use an absolute path inside the evaluation container.
							</p>
						</div>
						<div className="flex justify-end">
							<Button
								type="button"
								disabled={isSavingEvaluateConfig}
								onClick={async () => {
									if (!evaluateAgentProfileId) {
										toast.error("Agent profile is required");
										return;
									}
									setIsSavingEvaluateConfig(true);
									try {
										await mutateAsync({
											applicationId,
											evaluateConfig: {
												agentProfileId: evaluateAgentProfileId,
												groundTruthPath: evaluateGroundTruthPath.trim(),
											},
										});
										await utils.application.one.invalidate({ applicationId });
										toast.success("Evaluate config updated");
									} catch {
										toast.error("Failed to update evaluate config");
									} finally {
										setIsSavingEvaluateConfig(false);
									}
								}}
							>
								Save
							</Button>
						</div>
					</div>
				</CardContent>
			</Card>
		</div>
	);
};
