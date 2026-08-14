"use client";

import { ScanStageSettingsPanel } from "@/components/dashboard/shared/scan-stage-settings-panel";
import { ScanPipelineYamlViewer } from "@/components/dashboard/shared/scan-pipeline-yaml-viewer";
import { SecurityPolicyCard } from "@/components/dashboard/shared/security-policy-card";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
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
	const [analysisReportTemplate, setAnalysisReportTemplate] = useState("");
	const [isSavingPostCheckoutScript, setIsSavingPostCheckoutScript] =
		useState(false);
	const [isSavingAnalysisReportTemplate, setIsSavingAnalysisReportTemplate] =
		useState(false);
	const [injectionPrompt, setInjectionPrompt] = useState("");
	const [isSavingInjectionPrompt, setIsSavingInjectionPrompt] =
		useState(false);
	useEffect(() => {
		setPostCheckoutScript(data?.postCheckoutScript ?? "");
	}, [data?.postCheckoutScript]);

	useEffect(() => {
		setAnalysisReportTemplate(data?.analysisReportTemplate ?? "");
	}, [data?.analysisReportTemplate]);

	useEffect(() => {
		setInjectionPrompt(data?.injectionPrompt ?? "");
	}, [data?.injectionPrompt]);

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
			<ScanPipelineYamlViewer />
			<SecurityPolicyCard
				value={data?.securityPolicy}
				onSave={async (securityPolicy) => {
					await mutateAsync({
						applicationId,
						securityPolicy,
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
						Analysis Report Template
					</CardTitle>
					<CardDescription>
						Custom markdown template injected into every analyze task. The
						analysis agent will read the saved file and format the report to
						match it.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="grid gap-3">
						<Textarea
							value={analysisReportTemplate}
							onChange={(event) =>
								setAnalysisReportTemplate(event.currentTarget.value)
							}
							placeholder={"# Analysis Report\n\n## Summary\n- ..."}
							className="min-h-56 font-mono text-sm"
							spellCheck={false}
						/>
						<div className="flex justify-end">
							<Button
								type="button"
								disabled={isSavingAnalysisReportTemplate}
								onClick={async () => {
									setIsSavingAnalysisReportTemplate(true);
									try {
										await mutateAsync({
											applicationId,
											analysisReportTemplate,
										});
										await utils.application.one.invalidate({ applicationId });
										toast.success("Analysis report template updated");
									} catch {
										toast.error(
											"Failed to update analysis report template",
										);
									} finally {
										setIsSavingAnalysisReportTemplate(false);
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
						Injection Prompt
					</CardTitle>
					<CardDescription>
						Additional instructions appended to every AI stage prompt during
						scanning. Use this to inject custom context or constraints.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="grid gap-3">
						<Textarea
							value={injectionPrompt}
							onChange={(event) =>
								setInjectionPrompt(event.currentTarget.value)
							}
							placeholder={
								"Focus on authentication bypass and privilege escalation vulnerabilities."
							}
							className="min-h-40 font-mono text-sm"
							spellCheck={false}
						/>
						<div className="flex justify-end">
							<Button
								type="button"
								disabled={isSavingInjectionPrompt}
								onClick={async () => {
									setIsSavingInjectionPrompt(true);
									try {
										await mutateAsync({
											applicationId,
											injectionPrompt,
										});
										await utils.application.one.invalidate({ applicationId });
										toast.success("Injection prompt updated");
									} catch {
										toast.error("Failed to update injection prompt");
									} finally {
										setIsSavingInjectionPrompt(false);
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
