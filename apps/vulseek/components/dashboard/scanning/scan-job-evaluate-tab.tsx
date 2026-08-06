import { AlertCircle, ClipboardCheck, Loader2 } from "lucide-react";
import { useTranslation } from "next-i18next";
import { useState } from "react";
import { toast } from "sonner";
import { DateTooltip } from "@/components/shared/date-tooltip";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { api, type RouterOutputs } from "@/utils/api";
import { scanT } from "./scan-i18n";
import {
	formatEvaluationMetric,
	getEvaluationResult,
} from "./scan-job-detail-format";

type ScanJobEvaluateTabProps = {
	scanJobId: string;
	serviceType?: "application" | "compose";
	isLoadingJob: boolean;
	scanJob: RouterOutputs["scan"]["jobOverview"] | undefined;
	canEvaluateScanJob: boolean;
	latestEvaluation: RouterOutputs["scan"]["latestEvaluation"] | undefined;
	isLoadingLatestEvaluation: boolean;
	/** Application/compose service record (shared with the shell breadcrumb). */
	serviceData:
		| RouterOutputs["application"]["one"]
		| RouterOutputs["compose"]["one"]
		| undefined;
};

/**
 * Evaluate tab for the shared scan job detail (Phase 4 split from
 * show-scan-job-detail): the run-evaluate action, the latest-result metrics
 * card and the one-off evaluation dialog (application jobs only). Owns the
 * dialog draft state and the start-evaluation mutation; polling queries live
 * in the page/context controller.
 */
export const ScanJobEvaluateTab = ({
	scanJobId,
	serviceType,
	isLoadingJob,
	scanJob,
	canEvaluateScanJob,
	latestEvaluation,
	isLoadingLatestEvaluation,
	serviceData,
}: ScanJobEvaluateTabProps) => {
	const { t } = useTranslation("scan");
	const utils = api.useUtils();
	const startEvaluationMutation = api.scan.startEvaluation.useMutation();
	const { data: agentProfiles } = api.ai.getAgentProfiles.useQuery(undefined, {
		enabled: serviceType === "application",
	});
	const enabledAgentProfiles =
		agentProfiles?.filter((profile) => profile.isEnabled) ?? [];
	const applicationEvaluateConfig =
		serviceType === "application" &&
		serviceData &&
		"evaluateConfig" in serviceData
			? serviceData.evaluateConfig
			: { agentProfileId: "", groundTruthPath: "" };
	const [isEvaluateDialogOpen, setIsEvaluateDialogOpen] = useState(false);
	const [evaluateAgentProfileIdDraft, setEvaluateAgentProfileIdDraft] =
		useState("");
	const [evaluateGroundTruthPathDraft, setEvaluateGroundTruthPathDraft] =
		useState("");

	return (
		<>
			{serviceType !== "application" ? (
				<div className="flex items-center gap-2 text-muted-foreground">
					<AlertCircle className="size-4" />
					{scanT(
						t,
						"scan.evaluate.applicationOnly",
						"Evaluate is only available for application scan jobs.",
					)}
				</div>
			) : isLoadingJob ? (
				<div className="flex items-center gap-2 text-muted-foreground">
					<Loader2 className="size-4 animate-spin" />
					{scanT(t, "scan.job.loading", "Loading job...")}
				</div>
			) : !scanJob ? (
				<div className="flex items-center gap-2 text-muted-foreground">
					<AlertCircle className="size-4" />
					{scanT(t, "scan.job.notFound", "Job not found")}
				</div>
			) : (
				<div className="grid gap-4">
					<div className="rounded-lg border p-4">
						<div className="flex flex-wrap items-center justify-between gap-3">
							<div>
								<div className="text-lg font-semibold">
									{scanT(t, "scan.evaluate.title", "Evaluate")}
								</div>
								<div className="text-sm text-muted-foreground">
									{scanT(
										t,
										"scan.evaluate.description",
										"Latest manual evaluation against configured ground truth.",
									)}
								</div>
							</div>
							<Button
								type="button"
								variant="outline"
								disabled={!canEvaluateScanJob || startEvaluationMutation.isLoading}
								onClick={() => {
									setEvaluateAgentProfileIdDraft(
										applicationEvaluateConfig?.agentProfileId || "",
									);
									setEvaluateGroundTruthPathDraft(
										applicationEvaluateConfig?.groundTruthPath ?? "",
									);
									setIsEvaluateDialogOpen(true);
								}}
							>
								{startEvaluationMutation.isLoading ? (
									<>
										<Loader2 className="mr-2 size-4 animate-spin" />
										{scanT(t, "scan.evaluate.starting", "Starting...")}
									</>
								) : (
									<>
										<ClipboardCheck className="mr-2 size-4" />
										{scanT(t, "scan.evaluate.action", "Evaluate")}
									</>
								)}
							</Button>
						</div>
					</div>
					<Card className="bg-background">
						<CardHeader>
							<div className="flex items-start justify-between gap-3">
								<div>
									<CardTitle className="text-xl">
										{scanT(t, "scan.evaluate.latest", "Latest Result")}
									</CardTitle>
									<CardDescription>
										{scanT(
											t,
											"scan.evaluate.latestDescription",
											"Metrics from the latest evaluation run for this job.",
										)}
									</CardDescription>
								</div>
								{isLoadingLatestEvaluation ? (
									<Loader2 className="size-4 animate-spin text-muted-foreground" />
								) : null}
							</div>
						</CardHeader>
						<CardContent>
							{latestEvaluation ? (
								<div className="grid gap-3 md:grid-cols-4">
									<div className="rounded-lg border p-3">
										<div className="text-sm text-muted-foreground">
											{scanT(t, "scan.field.status", "Status")}
										</div>
										<div className="font-medium capitalize">
											{latestEvaluation.status}
										</div>
									</div>
									<div className="rounded-lg border p-3">
										<div className="text-sm text-muted-foreground">
											{scanT(t, "scan.status.finished", "Finished")}
										</div>
										<div className="font-medium">
											{latestEvaluation.finishedAt ? (
												<DateTooltip date={latestEvaluation.finishedAt} />
											) : (
												"-"
											)}
										</div>
									</div>
									<div className="rounded-lg border p-3">
										<div className="text-sm text-muted-foreground">
											TP / FP / FN
										</div>
										<div className="font-medium tabular-nums">
											{String(
												getEvaluationResult(latestEvaluation)?.truePositive ??
													"-",
											)}
											{" / "}
											{String(
												getEvaluationResult(latestEvaluation)?.falsePositive ??
													"-",
											)}
											{" / "}
											{String(
												getEvaluationResult(latestEvaluation)?.falseNegative ??
													"-",
											)}
										</div>
									</div>
									<div className="rounded-lg border p-3">
										<div className="text-sm text-muted-foreground">
											Precision / Recall / F1
										</div>
										<div className="font-medium tabular-nums">
											{formatEvaluationMetric(
												getEvaluationResult(latestEvaluation)?.precision,
											)}
											{" / "}
											{formatEvaluationMetric(
												getEvaluationResult(latestEvaluation)?.recall,
											)}
											{" / "}
											{formatEvaluationMetric(
												getEvaluationResult(latestEvaluation)?.f1,
											)}
										</div>
									</div>
									{getEvaluationResult(latestEvaluation)?.summary ? (
										<div className="rounded-lg border p-3 md:col-span-4">
											<div className="text-sm text-muted-foreground">
												{scanT(t, "scan.field.summary", "Summary")}
											</div>
											<div className="font-medium">
												{String(getEvaluationResult(latestEvaluation)?.summary)}
											</div>
										</div>
									) : null}
									{latestEvaluation.errorMessage ? (
										<div className="rounded-lg border p-3 md:col-span-4">
											<div className="text-sm text-muted-foreground">
												{scanT(t, "scan.field.errorMessage", "Error")}
											</div>
											<div className="font-medium text-destructive break-all">
												{latestEvaluation.errorMessage}
											</div>
										</div>
									) : null}
								</div>
							) : (
								<div className="text-sm text-muted-foreground">
									{scanT(
										t,
										"scan.evaluate.empty",
										"No evaluation has been run for this job.",
									)}
								</div>
							)}
						</CardContent>
					</Card>
				</div>
			)}
			<Dialog open={isEvaluateDialogOpen} onOpenChange={setIsEvaluateDialogOpen}>
				<DialogContent className="sm:max-w-2xl">
					<DialogHeader>
						<DialogTitle>{scanT(t, "scan.evaluate.title", "Evaluate")}</DialogTitle>
						<DialogDescription>
							{scanT(
								t,
								"scan.evaluate.dialogDescription",
								"Run a one-off evaluation using these settings. Changes here do not update application defaults.",
							)}
						</DialogDescription>
					</DialogHeader>
					<div className="grid gap-4">
						<div className="grid gap-2">
							<label
								htmlFor="run-evaluate-agent-profile"
								className="text-sm font-medium"
							>
								{scanT(t, "scan.evaluate.agentProfile", "Agent Profile")}
							</label>
							<Select
								value={evaluateAgentProfileIdDraft}
								onValueChange={setEvaluateAgentProfileIdDraft}
							>
								<SelectTrigger id="run-evaluate-agent-profile">
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
								htmlFor="run-evaluate-ground-truth-path"
								className="text-sm font-medium"
							>
								{scanT(t, "scan.evaluate.groundTruthPath", "Ground Truth Path")}
							</label>
							<Input
								id="run-evaluate-ground-truth-path"
								value={evaluateGroundTruthPathDraft}
								onChange={(event) =>
									setEvaluateGroundTruthPathDraft(event.currentTarget.value)
								}
								placeholder="/workspace/repo/ground_truth.json"
							/>
							<p className="text-xs text-muted-foreground">
								{scanT(
									t,
									"scan.evaluate.groundTruthHelp",
									"Use an absolute path inside the evaluation container.",
								)}
							</p>
						</div>
					</div>
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => setIsEvaluateDialogOpen(false)}
						>
							{scanT(t, "scan.dialog.cancel", "Cancel")}
						</Button>
						<Button
							type="button"
							disabled={startEvaluationMutation.isLoading}
							onClick={async () => {
								if (!evaluateAgentProfileIdDraft) {
									toast.error(
										scanT(
											t,
											"scan.evaluate.agentProfileRequired",
											"Agent profile is required",
										),
									);
									return;
								}
								const groundTruthPath = evaluateGroundTruthPathDraft.trim();
								if (!groundTruthPath.startsWith("/")) {
									toast.error(
										"Ground truth path must be an absolute container path",
									);
									return;
								}
								try {
									await startEvaluationMutation.mutateAsync({
										scanJobId,
										configSnapshot: {
											agentProfileId: evaluateAgentProfileIdDraft,
											groundTruthPath,
										},
									});
									setIsEvaluateDialogOpen(false);
									toast.success(
										scanT(
											t,
											"scan.evaluate.startedToast",
											"Evaluation started",
										),
									);
									await utils.scan.latestEvaluation.invalidate({
										scanJobId,
									});
								} catch (error) {
									toast.error(
										error instanceof Error
											? error.message
											: scanT(
													t,
													"scan.evaluate.startError",
													"Failed to start evaluation",
												),
									);
								}
							}}
						>
							{startEvaluationMutation.isLoading ? (
								<>
									<Loader2 className="mr-2 size-4 animate-spin" />
									{scanT(t, "scan.evaluate.starting", "Starting...")}
								</>
							) : (
								<>
									<ClipboardCheck className="mr-2 size-4" />
									{scanT(t, "scan.evaluate.run", "Run Evaluate")}
								</>
							)}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
};
