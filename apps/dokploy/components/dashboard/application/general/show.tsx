import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import {
	Ban,
	GitBranch,
	PackageSearch,
	RefreshCcw,
	Shield,
	Terminal,
} from "lucide-react";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ShowBuildChooseForm } from "@/components/dashboard/application/build/show";
import { ShowProviderForm } from "@/components/dashboard/application/general/generic/show";
import { CreateScanDialog } from "@/components/dashboard/scanning/create-scan-dialog";
import { CheckoutLogModal } from "@/components/dashboard/scanning/checkout-log-modal";
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

	const { mutateAsync: reload, isLoading: isReloading } =
		api.application.reload.useMutation();

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
			toast.success("Checkout image built successfully");
			setCheckoutFinalized(true);
			void refetchCheckoutImageStatus();
			refetch();
		}
		if (checkoutStatus.status === "failed") {
			toast.error("Checkout build failed");
			setCheckoutFinalized(true);
			refetch();
		}
	}, [checkoutStatus, checkoutFinalized, refetch, refetchCheckoutImageStatus]);

	return (
		<>
			<Card className="bg-background">
				<CardHeader>
					<CardTitle className="text-xl">Scan Settings</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-row gap-4 flex-wrap">
					<TooltipProvider delayDuration={0} disableHoverableContent={false}>
							<Button
								variant="default"
								isLoading={isCreatingScanJob}
								onClick={async () => {
									await createScanJob({
										applicationId: applicationId,
										scanType: "delta",
										triggerSource: "manual",
									})
										.then(() => {
											toast.success("Delta scan started successfully");
											refetch();
											router.push(
												`/dashboard/project/${data?.environment.projectId}/environment/${data?.environmentId}/profiles/application/${applicationId}?tab=deployments`,
											);
										})
										.catch(() => {
											toast.error("Error starting delta scan");
										});
								}}
								className="flex items-center gap-1.5 group focus-visible:ring-2 focus-visible:ring-offset-2"
							>
								<Tooltip>
									<TooltipTrigger asChild>
										<div className="flex items-center">
											<GitBranch className="size-4 mr-1" />
											Delta Scan
										</div>
									</TooltipTrigger>
									<TooltipPrimitive.Portal>
										<TooltipContent sideOffset={5} className="z-[60]">
											<p>
												Scans recent code changes incrementally
											</p>
										</TooltipContent>
									</TooltipPrimitive.Portal>
								</Tooltip>
							</Button>
						<DialogAction
							title="Reload Application"
							description="Are you sure you want to reload this application?"
							type="default"
							onClick={async () => {
								await reload({
									applicationId: applicationId,
									appName: data?.appName || "",
								})
									.then(() => {
										toast.success("Application reloaded successfully");
										refetch();
									})
									.catch(() => {
										toast.error("Error reloading application");
									});
							}}
						>
							<Button
								variant="secondary"
								isLoading={isReloading}
								className="flex items-center gap-1.5 group focus-visible:ring-2 focus-visible:ring-offset-2"
							>
								<Tooltip>
									<TooltipTrigger asChild>
										<div className="flex items-center">
											<RefreshCcw className="size-4 mr-1" />
											Reload
										</div>
									</TooltipTrigger>
									<TooltipPrimitive.Portal>
										<TooltipContent sideOffset={5} className="z-[60]">
											<p>Reload the application without rebuilding it</p>
										</TooltipContent>
									</TooltipPrimitive.Portal>
								</Tooltip>
							</Button>
						</DialogAction>
						<CreateScanDialog
							title="Full Scan"
							description="Configure ref, tag, and k for this full scan. Dokploy will persist them on the scan job."
							isLoading={isCreatingScanJob}
							serviceData={
								data ? (data as unknown as Record<string, unknown>) : undefined
							}
							onSubmit={async ({ targetRef, targetTag, commitWindow }) => {
								const scanJobsResult = await refetchScanJobs();
								const hasPendingFullScan = Boolean(
									scanJobsResult.data?.some(
										(scanJob) =>
											scanJob.scanType === "full" &&
											(scanJob.status === "queued" ||
												scanJob.status === "scanning" ||
												scanJob.status === "analyzing"),
									),
								);
								if (hasPendingFullScan) {
									toast.error("A full scan is already pending");
									return;
								}
								await createScanJob({
									applicationId: applicationId,
									scanType: "full",
									triggerSource: "manual",
									targetRef,
									targetTag,
									commitWindow,
								})
									.then(() => {
										toast.success("Full scan started successfully");
										refetch();
										router.push(
											`/dashboard/project/${data?.environment.projectId}/environment/${data?.environmentId}/profiles/application/${applicationId}?tab=deployments`,
										);
									})
									.catch(() => {
										toast.error("Error starting full scan");
									});
							}}
							trigger={
							<Button
								variant="secondary"
								isLoading={isCreatingScanJob}
								className="flex items-center gap-1.5 group focus-visible:ring-2 focus-visible:ring-offset-2"
							>
								<Tooltip>
									<TooltipTrigger asChild>
										<div className="flex items-center">
											<Shield className="size-4 mr-1" />
											Full Scan
										</div>
									</TooltipTrigger>
									<TooltipPrimitive.Portal>
										<TooltipContent sideOffset={5} className="z-[60]">
											<p>
												Scans the full codebase from the current source
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
												Checkouting
											</div>
										</TooltipTrigger>
										<TooltipPrimitive.Portal>
											<TooltipContent sideOffset={5} className="z-[60]">
												<p>Open checkout build logs</p>
											</TooltipContent>
										</TooltipPrimitive.Portal>
									</Tooltip>
								</Button>
							) : (
								<DialogAction
									title={isCheckouted ? "Recheckout" : "Checkout"}
									description={
										isCheckouted
											? "Checkout image already exists. Recheckout image?"
											: "Generate scan Dockerfile and build a checkout image?"
									}
									type="default"
									onClick={async () => {
										setCheckoutLogs("");
										setCheckoutFinalized(false);
										await checkout({
											applicationId: applicationId,
										})
											.then((result) => {
												setCheckoutId(result.checkoutId);
												setCheckoutModalOpen(true);
											})
											.catch((error) => {
												const message =
													error instanceof Error
														? error.message
														: "Checkout failed";
												setCheckoutLogs(message);
												toast.error("Error during checkout build");
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
													{isCheckouted ? "Recheckout" : "Checkout"}
												</div>
											</TooltipTrigger>
											<TooltipPrimitive.Portal>
												<TooltipContent sideOffset={5} className="z-[60]">
													<p>
														{isCheckouted
															? "Checkout image already exists; click to recheckout"
															: "Generate Dockerfile and build checkout image"}
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
							Open Terminal
						</Button>
					</DockerTerminalModal>
					<div className="flex flex-row items-center gap-2 rounded-md px-4 py-2 border">
						<span className="text-sm font-medium">Autoscan</span>
						<Switch
							aria-label="Toggle autoscan"
							checked={data?.autoDeploy || false}
							onCheckedChange={async (enabled) => {
								await update({
									applicationId,
									autoDeploy: enabled,
								})
									.then(async () => {
										toast.success("Auto Scan Updated");
										await refetch();
									})
									.catch(() => {
										toast.error("Error updating Auto Scan");
									});
							}}
							className="flex flex-row gap-2 items-center data-[state=checked]:bg-primary"
						/>
					</div>

					<div className="flex flex-row items-center gap-2 rounded-md px-4 py-2 border">
						<span className="text-sm font-medium">Clean Cache</span>
						<Switch
							aria-label="Toggle clean cache"
							checked={data?.cleanCache || false}
							onCheckedChange={async (enabled) => {
								await update({
									applicationId,
									cleanCache: enabled,
								})
									.then(async () => {
										toast.success("Clean Cache Updated");
										await refetch();
									})
									.catch(() => {
										toast.error("Error updating Clean Cache");
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
				title="Checkout Build Logs"
				description="Docker build output for scan checkout image"
				logs={checkoutLogs}
				isLoading={isCheckouting && !checkoutLogs}
			/>
			<ShowProviderForm applicationId={applicationId} />
			<ShowBuildChooseForm applicationId={applicationId} />
		</>
	);
};
