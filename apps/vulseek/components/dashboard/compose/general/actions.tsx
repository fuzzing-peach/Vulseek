import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { Ban, GitBranch, Shield, Terminal } from "lucide-react";
import { useRouter } from "next/router";
import { useTranslation } from "next-i18next";
import { toast } from "sonner";
import { CheckoutImageAction } from "@/components/dashboard/scanning/checkout-image-action";
import { CreateScanDialog } from "@/components/dashboard/scanning/create-scan-dialog";
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
	const { mutateAsync: createScanJob, isLoading: isCreatingScanJob } =
		api.scan.create.useMutation();
	const { mutateAsync: stop, isLoading: isStopping } =
		api.compose.stop.useMutation();
	return (
		<>
			<div className="flex flex-row gap-4 w-full flex-wrap ">
				<TooltipProvider delayDuration={0} disableHoverableContent={false}>
					<CreateScanDialog
						title={scanT(t, "scan.actions.fullScan", "漏洞挖掘")}
						description={scanT(
							t,
							"scan.actions.fullScanDescription",
							"Configure ref and tag for this vulnerability scan. If tag is empty, Vulseek will scan the most recent tag version.",
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
							"Configure ref, tag, and commit window for this delta scan. Vulseek compares the target commit against target~k unless a base SHA is already set on the job.",
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
						<CheckoutImageAction
							target={{ composeId }}
							onCheckoutComplete={async () => {
								await refetch();
							}}
						/>
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
		</>
	);
};
