import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { Ban, GitBranch, PackageSearch, Shield, Terminal } from "lucide-react";
import { useTranslation } from "next-i18next";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CreateScanDialog } from "@/components/dashboard/scanning/create-scan-dialog";
import { CheckoutLogModal } from "@/components/dashboard/scanning/checkout-log-modal";
import { scanT } from "@/components/dashboard/scanning/scan-i18n";
import { DialogAction } from "@/components/shared/dialog-action";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/utils/api";
import { DockerTerminalModal } from "../../settings/web-server/docker-terminal-modal";

interface Props {
	composeId: string;
}

const SCAN_BUTTON_CLASS_NAME =
	"flex items-center gap-1.5 border border-black bg-black text-white hover:bg-black/90 focus-visible:ring-2 focus-visible:ring-offset-2 dark:border-white dark:bg-white dark:text-black dark:hover:bg-white/90";

export const ComposeActions = ({ composeId }: Props) => {
	const { t } = useTranslation("scan");
	const router = useRouter();
	const { data, refetch } = api.compose.one.useQuery(
		{
			composeId,
		},
		{ enabled: !!composeId },
	);
	const { refetch: refetchScanJobs } = api.scan.allByCompose.useQuery(
		{
			composeId,
		},
		{
			enabled: !!composeId,
		},
	);
	const { mutateAsync: update } = api.compose.update.useMutation();
	const { mutateAsync: checkout, isLoading: isCheckingOut } =
		api.scan.checkout.useMutation();
	const { mutateAsync: createScanJob, isLoading: isCreatingScanJob } =
		api.scan.create.useMutation();
	const { mutateAsync: stop, isLoading: isStopping } =
		api.compose.stop.useMutation();
	const [checkoutModalOpen, setCheckoutModalOpen] = useState(false);
	const [checkoutId, setCheckoutId] = useState<string | null>(null);
	const [checkoutLogs, setCheckoutLogs] = useState("");
	const [checkoutFinalized, setCheckoutFinalized] = useState(false);
	const { data: checkoutImageStatus, refetch: refetchCheckoutImageStatus } =
		api.scan.checkoutImageStatus.useQuery(
			{
				composeId,
			},
			{
				enabled: !!composeId,
			},
		);
	const { data: runningCheckoutTask } = api.scan.runningCheckout.useQuery(
		{
			composeId,
		},
		{
			enabled: !!composeId,
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
			`Tag: ${checkoutStatus.gitTag || "none"}`,
			`Enable Submodules: ${checkoutStatus.enableSubmodules ? "true" : "false"}`,
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
			<div className="flex flex-row gap-4 w-full flex-wrap ">
				<TooltipProvider delayDuration={0} disableHoverableContent={false}>
					<CreateScanDialog
						title={scanT(t, "scan.actions.fullScan", "漏洞挖掘")}
						description={scanT(
							t,
							"scan.actions.fullScanDescription",
							"Configure ref and tag for this vulnerability scan. If tag is empty, Dokploy will scan the most recent tag version.",
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
										"A vulnerability scan is already pending",
									),
								);
								return;
							}
							await createScanJob({
								composeId: composeId,
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
											"Vulnerability scan started successfully",
										),
									);
									refetch();
									router.push(
										`/dashboard/project/${data?.environment.projectId}/environment/${data?.environmentId}/profiles/compose/${composeId}?tab=deployments`,
									);
								})
								.catch(() => {
									toast.error(
										scanT(
											t,
											"scan.actions.fullScanStartError",
											"Error starting vulnerability scan",
										),
									);
								});
						}}
						trigger={
							<Button
								variant="default"
								isLoading={isCreatingScanJob}
								className={SCAN_BUTTON_CLASS_NAME}
							>
								<Tooltip>
									<TooltipTrigger asChild>
										<div className="flex items-center">
											<Shield className="size-4 mr-1" />
											{scanT(t, "scan.actions.fullScan", "漏洞挖掘")}
										</div>
									</TooltipTrigger>
									<TooltipPrimitive.Portal>
										<TooltipContent sideOffset={5} className="z-[60]">
											<p>
												{scanT(
													t,
													"scan.actions.fullScanTooltip",
													"Profiles the repository, models attack surfaces, identifies targets, and scans candidate findings",
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
								composeId: composeId,
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
										`/dashboard/project/${data?.environment.projectId}/environment/${data?.environmentId}/profiles/compose/${composeId}?tab=deployments`,
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
								variant="default"
								isLoading={isCreatingScanJob}
								className={SCAN_BUTTON_CLASS_NAME}
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
													"Scans targets impacted by the target/base diff",
												)}
											</p>
										</TooltipContent>
									</TooltipPrimitive.Portal>
								</Tooltip>
							</Button>
						}
					/>
					{data?.composeType === "docker-compose" &&
					data?.composeStatus === "idle" ? (
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
										composeId,
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
							title="Stop Compose"
							description="Are you sure you want to stop this compose?"
							onClick={async () => {
								await stop({
									composeId: composeId,
								})
									.then(() => {
										toast.success("Compose stopped successfully");
										refetch();
									})
									.catch(() => {
										toast.error("Error stopping compose");
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
											<p>Stop the currently running compose</p>
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
					appType={data?.composeType || "docker-compose"}
				>
					<Button
						variant="outline"
						className="flex items-center gap-1.5 focus-visible:ring-2 focus-visible:ring-offset-2"
					>
						<Terminal className="size-4 mr-1" />
						{scanT(t, "scan.actions.openTerminal", "Open Terminal")}
					</Button>
				</DockerTerminalModal>
			</div>
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
		</>
	);
};
