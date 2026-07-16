import { Hammer, PackageSearch, ScrollText } from "lucide-react";
import { useTranslation } from "next-i18next";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/utils/api";
import { CheckoutLogModal } from "./checkout-log-modal";
import { scanT } from "./scan-i18n";

type CheckoutTarget =
	| { applicationId: string; composeId?: never }
	| { applicationId?: never; composeId: string };

type Props = {
	target: CheckoutTarget;
	onCheckoutComplete?: () => void | Promise<void>;
};

const formatDateTime = (value?: string | null) => {
	if (!value) return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

const toolsStatusVariant = (
	state?: "missing" | "ready" | "building" | "failed",
) => {
	if (state === "ready") return "green" as const;
	if (state === "building") return "blue" as const;
	if (state === "failed") return "red" as const;
	return "yellow" as const;
};

export const CheckoutImageAction = ({ target, onCheckoutComplete }: Props) => {
	const { t } = useTranslation("scan");
	const [dialogOpen, setDialogOpen] = useState(false);
	const [checkoutLogOpen, setCheckoutLogOpen] = useState(false);
	const [toolsLogOpen, setToolsLogOpen] = useState(false);
	const [checkoutId, setCheckoutId] = useState<string | null>(null);
	const [toolsBuildId, setToolsBuildId] = useState<string | null>(null);
	const [checkoutFinalized, setCheckoutFinalized] = useState(true);
	const notifiedToolsBuildRef = useRef<string | null>(null);

	const { mutateAsync: checkout, isLoading: isStartingCheckout } =
		api.scan.checkout.useMutation();
	const { mutateAsync: rebuildTools, isLoading: isStartingToolsBuild } =
		api.scan.rebuildCheckoutTools.useMutation();
	const { data: checkoutImageStatus, refetch: refetchCheckoutImageStatus } =
		api.scan.checkoutImageStatus.useQuery(target);
	const { data: runningCheckoutTask } = api.scan.runningCheckout.useQuery(
		target,
		{
			refetchInterval: (data) => (data?.status === "running" ? 2000 : false),
		},
	);
	const { data: checkoutStatus } = api.scan.checkoutStatus.useQuery(
		{ checkoutId: checkoutId || "" },
		{
			enabled: Boolean(checkoutId),
			refetchInterval: checkoutId && !checkoutFinalized ? 1500 : false,
		},
	);
	const { data: toolsStatus, refetch: refetchToolsStatus } =
		api.scan.checkoutToolsStatus.useQuery(undefined, {
			enabled: dialogOpen || Boolean(toolsBuildId),
			refetchInterval: (data) => (data?.state === "building" ? 1800 : false),
		});
	const activeToolsBuildId =
		toolsBuildId ||
		toolsStatus?.activeBuildId ||
		checkoutStatus?.toolsBuildId ||
		null;
	const { data: toolsBuildStatus } = api.scan.checkoutToolsBuildStatus.useQuery(
		{ buildId: activeToolsBuildId || "" },
		{
			enabled: Boolean(activeToolsBuildId),
			refetchInterval: (data) => (data?.status === "running" ? 1500 : false),
		},
	);

	const isCheckouting =
		checkoutStatus?.status === "running" ||
		runningCheckoutTask?.status === "running";
	const isCheckouted = checkoutImageStatus?.exists === true;
	const toolsImageReady = toolsStatus?.exists === true;

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
		if (!checkoutStatus || checkoutFinalized) return;
		if (checkoutStatus.status === "completed") {
			setCheckoutFinalized(true);
			void refetchCheckoutImageStatus();
			void onCheckoutComplete?.();
			toast.success(
				scanT(
					t,
					"scan.actions.checkoutBuilt",
					"Checkout image built successfully",
				),
			);
		}
		if (checkoutStatus.status === "failed") {
			setCheckoutFinalized(true);
			void onCheckoutComplete?.();
			toast.error(
				scanT(t, "scan.actions.checkoutBuildFailed", "Checkout build failed"),
			);
		}
	}, [
		checkoutFinalized,
		checkoutStatus,
		onCheckoutComplete,
		refetchCheckoutImageStatus,
		t,
	]);

	useEffect(() => {
		if (!toolsBuildStatus || toolsBuildStatus.status === "running") return;
		if (notifiedToolsBuildRef.current === toolsBuildStatus.buildId) return;
		notifiedToolsBuildRef.current = toolsBuildStatus.buildId;
		void refetchToolsStatus();
		if (toolsBuildStatus.status === "completed") {
			toast.success(
				scanT(
					t,
					"scan.actions.toolsBuildSuccess",
					"Tools image built successfully",
				),
			);
		} else {
			toast.error(
				toolsBuildStatus.errorMessage ||
					scanT(t, "scan.actions.toolsBuildFailed", "Tools image build failed"),
			);
		}
	}, [refetchToolsStatus, t, toolsBuildStatus]);

	const checkoutLogs = useMemo(() => {
		if (!checkoutStatus) return "";
		return [
			`Image: ${checkoutStatus.imageTag}`,
			`Tools: ${checkoutStatus.toolsVersion}`,
			`Phase: ${checkoutStatus.phase}`,
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
	}, [checkoutStatus]);

	const toolsLogs = useMemo(() => {
		if (!toolsBuildStatus) return "Build logs are unavailable.";
		return [
			`Image: ${toolsBuildStatus.imageTag}`,
			`Version: ${toolsBuildStatus.version}`,
			`Status: ${toolsBuildStatus.status}`,
			`Started: ${toolsBuildStatus.startedAt}`,
			`Finished: ${toolsBuildStatus.finishedAt || "running"}`,
			"",
			"===== docker build stdout =====",
			toolsBuildStatus.stdout || "",
			"",
			"===== docker build stderr =====",
			toolsBuildStatus.stderr || "",
			toolsBuildStatus.errorMessage
				? `\n===== error =====\n${toolsBuildStatus.errorMessage}`
				: "",
		].join("\n");
	}, [toolsBuildStatus]);

	const handleCheckout = async () => {
		try {
			const result = await checkout(target);
			setCheckoutId(result.checkoutId);
			setCheckoutFinalized(false);
			setDialogOpen(false);
			setCheckoutLogOpen(true);
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: scanT(t, "scan.actions.checkoutFailed", "Checkout failed"),
			);
		}
	};

	const handleToolsBuild = async () => {
		try {
			const build = await rebuildTools();
			notifiedToolsBuildRef.current = null;
			setToolsBuildId(build.buildId);
			await refetchToolsStatus();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to start tools build",
			);
		}
	};

	return (
		<>
			<Button
				variant="secondary"
				onClick={() => {
					if (isCheckouting) setCheckoutLogOpen(true);
					else setDialogOpen(true);
				}}
				className="flex items-center gap-1.5 focus-visible:ring-2 focus-visible:ring-offset-2"
			>
				<PackageSearch className="size-4" />
				{isCheckouting
					? scanT(t, "scan.actions.checkouting", "Checkouting")
					: isCheckouted
						? scanT(t, "scan.actions.recheckout", "Recheckout")
						: scanT(t, "scan.actions.checkout", "Checkout")}
			</Button>

			<Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
				<DialogContent className="sm:max-w-2xl">
					<DialogHeader>
						<DialogTitle>
							{scanT(t, "scan.actions.checkoutDialogTitle", "Checkout image")}
						</DialogTitle>
						<DialogDescription>
							{scanT(
								t,
								"scan.actions.checkoutDialogDescription",
								"Review the shared tools image before building this checkout image.",
							)}
						</DialogDescription>
					</DialogHeader>

					<section className="space-y-4 py-2">
						<div className="flex flex-wrap items-center justify-between gap-3">
							<div>
								<h3 className="text-sm font-semibold">
									{scanT(t, "scan.actions.toolsImage", "Tools image")}
								</h3>
								<p className="text-sm text-muted-foreground">
									{scanT(
										t,
										"scan.actions.toolsImageDescription",
										"Shared scanner and agent toolchain",
									)}
								</p>
							</div>
							<Badge variant={toolsStatusVariant(toolsStatus?.state)}>
								{toolsStatus?.state || "loading"}
							</Badge>
						</div>
						<dl className="grid gap-3 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
							<dt className="text-muted-foreground">
								{scanT(t, "scan.actions.toolsVersion", "Version")}
							</dt>
							<dd className="font-mono">{toolsStatus?.shortVersion || "-"}</dd>
							<dt className="text-muted-foreground">
								{scanT(t, "scan.actions.toolsFullHash", "Full hash")}
							</dt>
							<dd className="break-all font-mono text-xs">
								{toolsStatus?.version || "-"}
							</dd>
							<dt className="text-muted-foreground">Image</dt>
							<dd className="break-all font-mono text-xs">
								{toolsStatus?.imageTag || "-"}
							</dd>
							<dt className="text-muted-foreground">
								{scanT(t, "scan.actions.toolsBuiltAt", "Built at")}
							</dt>
							<dd>
								{formatDateTime(toolsStatus?.builtAt) ||
									scanT(t, "scan.actions.toolsNotBuilt", "Not built")}
							</dd>
						</dl>
						{toolsStatus?.lastError ? (
							<p className="text-sm text-destructive">
								{toolsStatus.lastError}
							</p>
						) : null}
						<div className="flex flex-wrap gap-2">
							{activeToolsBuildId ? (
								<Button
									variant="outline"
									onClick={() => {
										setDialogOpen(false);
										setToolsLogOpen(true);
									}}
								>
									<ScrollText className="mr-2 size-4" />
									{scanT(t, "scan.actions.viewToolsLogs", "View tools logs")}
								</Button>
							) : null}
							{toolsStatus?.canRebuild ? (
								<Button
									variant="outline"
									onClick={handleToolsBuild}
									isLoading={isStartingToolsBuild}
									disabled={toolsStatus.state === "building"}
								>
									<Hammer className="mr-2 size-4" />
									{toolsStatus.exists
										? scanT(
												t,
												"scan.actions.toolsRebuild",
												"Rebuild tools image",
											)
										: scanT(t, "scan.actions.toolsBuild", "Build tools image")}
								</Button>
							) : null}
						</div>
					</section>

					<section className="space-y-3 border-t pt-5">
						<div>
							<h3 className="text-sm font-semibold">
								{scanT(t, "scan.actions.checkoutImage", "Checkout image")}
							</h3>
							<p className="text-sm text-muted-foreground">
								{isCheckouted
									? scanT(
											t,
											"scan.actions.checkoutImageExists",
											"A checkout image already exists for this target.",
										)
									: scanT(
											t,
											"scan.actions.checkoutImageDescription",
											"Build the target repository on top of the tools image.",
										)}
							</p>
						</div>
						<p className="break-all font-mono text-xs text-muted-foreground">
							{checkoutImageStatus?.imageTag || "-"}
						</p>
					</section>

					<DialogFooter>
						<Button variant="outline" onClick={() => setDialogOpen(false)}>
							{scanT(t, "scan.dialog.cancel", "Cancel")}
						</Button>
						<Button
							onClick={handleCheckout}
							isLoading={isStartingCheckout}
							disabled={isStartingCheckout || !toolsImageReady}
							title={
								!toolsImageReady
									? scanT(
											t,
											"scan.actions.toolsImageRequired",
											"Build the tools image before building a checkout image.",
										)
									: undefined
							}
						>
							<PackageSearch className="mr-2 size-4" />
							{isCheckouted
								? scanT(
										t,
										"scan.actions.rebuildCheckoutImage",
										"Rebuild checkout image",
									)
								: scanT(
										t,
										"scan.actions.buildCheckoutImage",
										"Build checkout image",
									)}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<CheckoutLogModal
				open={toolsLogOpen}
				onOpenChange={setToolsLogOpen}
				title={scanT(
					t,
					"scan.actions.toolsBuildLogs",
					"Tools Image Build Logs",
				)}
				description={scanT(
					t,
					"scan.actions.toolsBuildLogsDescription",
					"Docker build output for the shared checkout tools image",
				)}
				logs={toolsLogs}
				isLoading={toolsBuildStatus?.status === "running"}
			/>
			<CheckoutLogModal
				open={checkoutLogOpen}
				onOpenChange={setCheckoutLogOpen}
				title={scanT(
					t,
					"scan.actions.checkoutBuildLogs",
					"Checkout Build Logs",
				)}
				description={scanT(
					t,
					"scan.actions.checkoutBuildLogsDescription",
					"Docker build output for scan checkout image",
				)}
				logs={checkoutLogs}
				isLoading={Boolean(isCheckouting && !checkoutLogs)}
			/>
		</>
	);
};
