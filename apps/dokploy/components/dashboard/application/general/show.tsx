import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { Ban, GitBranch, PackageSearch, Shield, Terminal } from "lucide-react";
import { useTranslation } from "next-i18next";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ShowBuildChooseForm } from "@/components/dashboard/application/build/show";
import { ShowProviderForm } from "@/components/dashboard/application/general/generic/show";
import { CreateScanDialog } from "@/components/dashboard/scanning/create-scan-dialog";
import { CheckoutLogModal } from "@/components/dashboard/scanning/checkout-log-modal";
import { scanT } from "@/components/dashboard/scanning/scan-i18n";
import { DialogAction } from "@/components/shared/dialog-action";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/utils/api";
import { DockerTerminalModal } from "../../settings/web-server/docker-terminal-modal";

interface Props {
	applicationId: string;
}

export const ShowGeneralApplication = ({ applicationId }: Props) => {
	const { t } = useTranslation("scan");
	const router = useRouter();
	const { data, refetch } = api.application.one.useQuery(
		{
			applicationId,
		},
		{ enabled: !!applicationId },
	);
	const { refetch: refetchScanJobs } = api.scan.allByApplication.useQuery(
		{
			applicationId,
		},
		{
			enabled: !!applicationId,
		},
	);
	const { mutateAsync: update } = api.application.update.useMutation();
	const { mutateAsync: checkout, isLoading: isCheckingOut } =
		api.scan.checkout.useMutation();
	const { mutateAsync: stop, isLoading: isStopping } =
		api.application.stop.useMutation();
	const { mutateAsync: createScanJob, isLoading: isCreatingScanJob } =
		api.scan.create.useMutation();

	const [checkoutModalOpen, setCheckoutModalOpen] = useState(false);
	const [checkoutId, setCheckoutId] = useState<string | null>(null);
	const [checkoutLogs, setCheckoutLogs] = useState("");
	const [checkoutFinalized, setCheckoutFinalized] = useState(false);
	const { data: checkoutImageStatus, refetch: refetchCheckoutImageStatus } =
		api.scan.checkoutImageStatus.useQuery(
			{
				applicationId,
			},
			{
				enabled: !!applicationId,
			},
		);
	const { data: runningCheckoutTask } = api.scan.runningCheckout.useQuery(
		{
			applicationId,
		},
		{
			enabled: !!applicationId,
			refetchInterval: checkoutFinalized ? false : 2000,
		},
	);
	const { data: checkoutStatus } = api.scan.checkoutStatus.useQuery(
		{
			checkoutId: checkoutId || "",
		},
		{
			enabled: !!checkoutId,
			refetchInterval: checkoutId && !checkoutFinalized ? 1500 : false,
		},
	);
	const isCheckouting =
		checkoutStatus?.status === "running" ||
		runningCheckoutTask?.status === "running";
	const isCheckouted = checkoutImageStatus?.exists === true;

	useEffect(() => {
		if (!checkoutId && runningCheckoutTask?.checkoutId) {
			setCheckoutId(runningCheckoutTask.checkoutId);
			setCheckoutFinalized(false);
		}
	}, [checkoutId, runningCheckoutTask]);

	useEffect(() => {
		if (checkoutId && checkoutStatus === null && !runningCheckoutTask) {
			setCheckoutFinalized(true);
			setCheckoutId(null);
		}
	}, [checkoutId, checkoutStatus, runningCheckoutTask]);

	useEffect(() => {
		if (!checkoutStatus) return;
		const logs = [
			`Image: ${checkoutStatus.imageTag}`,
			`Repository: ${checkoutStatus.gitUrl}`,
			`Branch: ${checkoutStatus.gitBranch}`,
			`Enable Submodules: ${checkoutStatus.enableSubmodules ? "true" : "false"}`,
			`Post Checkout Script: ${
				checkoutStatus.postCheckoutScript?.trim() ? "configured" : "none"
			}`,
			`Build Probe: ${checkoutStatus.dockerBuildProbe}`,
			"",
			"===== Dockerfile =====",
			checkoutStatus.dockerfileTemplate || "",
			"",
			"===== docker build stdout =====",
			checkoutStatus.stdout || "",
			"",
			"===== docker build stderr =====",
			checkoutStatus.stderr || "",
			checkoutStatus.errorMessage
				? `\n===== error =====\n${checkoutStatus.errorMessage}`
				: "",
		].join("\n");
		setCheckoutLogs(logs);

		if (checkoutFinalized) return;
		if (checkoutStatus.status === "completed") {
			toast.success(
				scanT(t, "scan.actions.checkoutBuilt", "Checkout image built successfully"),
			);
			setCheckoutFinalized(true);
			void refetchCheckoutImageStatus();
			refetch();
		}
		if (checkoutStatus.status === "failed") {
			toast.error(scanT(t, "scan.actions.checkoutBuildFailed", "Checkout build failed"));
			setCheckoutFinalized(true);
			refetch();
		}
	}, [checkoutStatus, checkoutFinalized, refetch, refetchCheckoutImageStatus, t]);

	return (
		<>
			<Card className="bg-background">
				<CardHeader>
					<CardTitle className="text-xl">
						{scanT(t, "scan.actions.title", "Actions")}
					</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-row gap-4 flex-wrap">
					<TooltipProvider delayDuration={0} disableHoverableContent={false}>
						<CreateScanDialog
							title={scanT(t, "scan.actions.fullScan", "Full Scan")}
							description={scanT(
								t,
								"scan.actions.fullScanDescription",
								"Configure ref and tag for this full scan. If tag is empty, Dokploy will scan the most recent tag version.",
							)}
							isLoading={isCreatingScanJob}
							showCommitWindow={false}
							showFullScanPreview
							serviceData={
								data ? (data as unknown as Record<string, unknown>) : undefined
							}
							onSubmit={async ({
								targetRef,
								targetTag,
								commitWindow,
								scanRuntimeSettings,
							}) => {
								const scanJobsResult = await refetchScanJobs();
								const hasPendingFullScan = Boolean(
									scanJobsResult.data?.some(
										(scanJob) =>
											scanJob.scanType === "full" &&
											(scanJob.status === "pending" ||
												scanJob.status === "running" ||
												scanJob.status === "paused"),
									),
								);
								if (hasPendingFullScan) {
									toast.error(
										scanT(
											t,
											"scan.actions.fullScanPending",
											"A full scan is already pending",
										),
									);
									return;
								}
								await createScanJob({
									applicationId: applicationId,
									scanType: "full",
									triggerSource: "manual",
									targetRef,
									targetTag,
									commitWindow,
									scanRuntimeSettings,
								})
									.then(() => {
										toast.success(
											scanT(
												t,
												"scan.actions.fullScanStarted",
												"Full scan started successfully",
											),
										);
										refetch();
										router.push(
											`/dashboard/project/${data?.environment.projectId}/environment/${data?.environmentId}/profiles/application/${applicationId}?tab=deployments`,
										);
									})
									.catch(() => {
										toast.error(
											scanT(
												t,
												"scan.actions.fullScanStartError",
												"Error starting full scan",
											),
										);
									});
							}}
							trigger={
								<Button
									variant="default"
									isLoading={isCreatingScanJob}
									className="flex items-center gap-1.5 border border-black bg-black text-white hover:bg-black/90 focus-visible:ring-2 focus-visible:ring-offset-2 dark:border-white dark:bg-white dark:text-black dark:hover:bg-white/90"
								>
									<Tooltip>
										<TooltipTrigger asChild>
											<div className="flex items-center">
												<Shield className="size-4 mr-1" />
												{scanT(t, "scan.actions.fullScan", "Full Scan")}
											</div>
										</TooltipTrigger>
										<TooltipPrimitive.Portal>
											<TooltipContent sideOffset={5} className="z-[60]">
												<p>
													{scanT(
														t,
														"scan.actions.fullScanTooltip",
														"Scans the full codebase from the current source",
													)}
												</p>
											</TooltipContent>
										</TooltipPrimitive.Portal>
									</Tooltip>
								</Button>
							}
						/>
						<CreateScanDialog
							title={scanT(t, "scan.actions.deltaScan", "Delta Scan")}
							description={scanT(
								t,
								"scan.actions.deltaScanDescription",
								"Configure ref, tag, and commit window for this delta scan. Dokploy compares the target commit against target~k unless a base SHA is already set on the job.",
							)}
							isLoading={isCreatingScanJob}
							showCommitWindow
							showFullScanPreview
							scanType="delta"
							serviceData={
								data ? (data as unknown as Record<string, unknown>) : undefined
							}
							onSubmit={async ({
								targetRef,
								targetTag,
								commitWindow,
								scanRuntimeSettings,
							}) => {
								const scanJobsResult = await refetchScanJobs();
								const hasPendingDeltaScan = Boolean(
									scanJobsResult.data?.some(
										(scanJob) =>
											scanJob.scanType === "delta" &&
											(scanJob.status === "pending" ||
												scanJob.status === "running" ||
												scanJob.status === "paused"),
									),
								);
								if (hasPendingDeltaScan) {
									toast.error(
										scanT(
											t,
											"scan.actions.deltaScanPending",
											"A delta scan is already pending",
										),
									);
									return;
								}
								await createScanJob({
									applicationId: applicationId,
									scanType: "delta",
									triggerSource: "manual",
									targetRef,
									targetTag,
									commitWindow,
									scanRuntimeSettings,
								})
									.then(() => {
										toast.success(
											scanT(
												t,
												"scan.actions.deltaScanStarted",
												"Delta scan started successfully",
											),
										);
										refetch();
										router.push(
											`/dashboard/project/${data?.environment.projectId}/environment/${data?.environmentId}/profiles/application/${applicationId}?tab=deployments`,
										);
									})
									.catch(() => {
										toast.error(
											scanT(
												t,
												"scan.actions.deltaScanStartError",
												"Error starting delta scan",
											),
										);
									});
							}}
							trigger={
								<Button
									variant="secondary"
									isLoading={isCreatingScanJob}
									className="flex items-center gap-1.5 focus-visible:ring-2 focus-visible:ring-offset-2"
								>
									<Tooltip>
										<TooltipTrigger asChild>
											<div className="flex items-center">
												<GitBranch className="size-4 mr-1" />
												{scanT(t, "scan.actions.deltaScan", "Delta Scan")}
											</div>
										</TooltipTrigger>
										<TooltipPrimitive.Portal>
											<TooltipContent sideOffset={5} className="z-[60]">
												<p>
													{scanT(
														t,
														"scan.actions.deltaScanTooltip",
														"Scans functions impacted by the target/base diff",
													)}
												</p>
											</TooltipContent>
										</TooltipPrimitive.Portal>
									</Tooltip>
								</Button>
							}
						/>

						{data?.applicationStatus === "idle" ? (
							isCheckouting ? (
								<Button
									variant="secondary"
									onClick={() => setCheckoutModalOpen(true)}
									className="flex items-center gap-1.5 group focus-visible:ring-2 focus-visible:ring-offset-2"
								>
									<Tooltip>
										<TooltipTrigger asChild>
											<div className="flex items-center">
												<PackageSearch className="size-4 mr-1" />
												{scanT(t, "scan.actions.checkouting", "Checkouting")}
											</div>
										</TooltipTrigger>
										<TooltipPrimitive.Portal>
											<TooltipContent sideOffset={5} className="z-[60]">
												<p>
													{scanT(
														t,
														"scan.actions.checkoutLogsTooltip",
														"Open checkout build logs",
													)}
												</p>
											</TooltipContent>
										</TooltipPrimitive.Portal>
									</Tooltip>
								</Button>
							) : (
								<DialogAction
									title={
										isCheckouted
											? scanT(t, "scan.actions.recheckoutTitle", "Recheckout")
											: scanT(t, "scan.actions.checkoutTitle", "Checkout")
									}
									description={
										isCheckouted
											? scanT(
													t,
													"scan.actions.recheckoutDescription",
													"Checkout image already exists. Recheckout image?",
												)
											: scanT(
													t,
													"scan.actions.checkoutDescription",
													"Generate scan Dockerfile and build a checkout image?",
												)
									}
									type="default"
									onClick={async () => {
										setCheckoutLogs("");
										setCheckoutId(null);
										setCheckoutFinalized(true);
										await checkout({
											applicationId: applicationId,
										})
											.then((result) => {
												setCheckoutId(result.checkoutId);
												setCheckoutFinalized(false);
												setCheckoutModalOpen(true);
											})
											.catch((error) => {
												const message =
													error instanceof Error
														? error.message
														: scanT(t, "scan.actions.checkoutFailed", "Checkout failed");
												setCheckoutLogs(message);
												setCheckoutFinalized(true);
												toast.error(
													scanT(
														t,
														"scan.actions.checkoutBuildError",
														"Error during checkout build",
													),
												);
											});
									}}
								>
									<Button
										variant="secondary"
										isLoading={isCheckingOut}
										className="flex items-center gap-1.5 group focus-visible:ring-2 focus-visible:ring-offset-2"
									>
										<Tooltip>
											<TooltipTrigger asChild>
												<div className="flex items-center">
													<PackageSearch className="size-4 mr-1" />
													{isCheckouted
														? scanT(t, "scan.actions.recheckout", "Recheckout")
														: scanT(t, "scan.actions.checkout", "Checkout")}
												</div>
											</TooltipTrigger>
											<TooltipPrimitive.Portal>
												<TooltipContent sideOffset={5} className="z-[60]">
													<p>
														{isCheckouted
															? scanT(
																	t,
																	"scan.actions.recheckoutTooltip",
																	"Checkout image already exists; click to recheckout",
																)
															: scanT(
																	t,
																	"scan.actions.checkoutTooltip",
																	"Generate Dockerfile and build checkout image",
																)}
													</p>
												</TooltipContent>
											</TooltipPrimitive.Portal>
										</Tooltip>
									</Button>
								</DialogAction>
							)
						) : (
							<DialogAction
								title="Stop Application"
								description="Are you sure you want to stop this application?"
								onClick={async () => {
									await stop({
										applicationId: applicationId,
									})
										.then(() => {
											toast.success("Application stopped successfully");
											refetch();
										})
										.catch(() => {
											toast.error("Error stopping application");
										});
								}}
							>
								<Button
									variant="destructive"
									isLoading={isStopping}
									className="flex items-center gap-1.5 group focus-visible:ring-2 focus-visible:ring-offset-2"
								>
									<Tooltip>
										<TooltipTrigger asChild>
											<div className="flex items-center">
												<Ban className="size-4 mr-1" />
												Stop
											</div>
										</TooltipTrigger>
										<TooltipPrimitive.Portal>
											<TooltipContent sideOffset={5} className="z-[60]">
												<p>Stop the currently running application</p>
											</TooltipContent>
										</TooltipPrimitive.Portal>
									</Tooltip>
								</Button>
							</DialogAction>
						)}
					</TooltipProvider>
					<DockerTerminalModal
						appName={data?.appName || ""}
						serverId={data?.serverId || ""}
					>
						<Button
							variant="outline"
							className="flex items-center gap-1.5 focus-visible:ring-2 focus-visible:ring-offset-2"
						>
							<Terminal className="size-4 mr-1" />
							{scanT(t, "scan.actions.openTerminal", "Open Terminal")}
						</Button>
					</DockerTerminalModal>
					<div className="flex flex-row items-center gap-2 rounded-md px-4 py-2 border">
						<span className="text-sm font-medium">
							{scanT(t, "scan.actions.cleanCache", "Clean Cache")}
						</span>
						<Switch
							aria-label="Toggle clean cache"
							checked={data?.cleanCache || false}
							onCheckedChange={async (enabled) => {
								await update({
									applicationId,
									cleanCache: enabled,
								})
									.then(async () => {
										toast.success(
											scanT(
												t,
												"scan.actions.cleanCacheUpdated",
												"Clean Cache Updated",
											),
										);
										await refetch();
									})
									.catch(() => {
										toast.error(
											scanT(
												t,
												"scan.actions.cleanCacheUpdateError",
												"Error updating Clean Cache",
											),
										);
									});
							}}
							className="flex flex-row gap-2 items-center data-[state=checked]:bg-primary"
						/>
					</div>
				</CardContent>
			</Card>
			<CheckoutLogModal
				open={checkoutModalOpen}
				onOpenChange={setCheckoutModalOpen}
				title={scanT(t, "scan.actions.checkoutBuildLogs", "Checkout Build Logs")}
				description={scanT(
					t,
					"scan.actions.checkoutBuildLogsDescription",
					"Docker build output for scan checkout image",
				)}
				logs={checkoutLogs}
				isLoading={isCheckouting && !checkoutLogs}
			/>
			<ShowProviderForm applicationId={applicationId} />
			<ShowBuildChooseForm applicationId={applicationId} />
		</>
	);
};
