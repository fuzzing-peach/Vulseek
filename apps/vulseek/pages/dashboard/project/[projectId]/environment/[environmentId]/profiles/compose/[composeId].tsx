import { createServerSideHelpers } from "@trpc/react-query/server";
import { validateRequest } from "@vulseek/server/lib/auth";
import copy from "copy-to-clipboard";
import { CircuitBoard, HelpCircle, ServerOff } from "lucide-react";
import type {
	GetServerSidePropsContext,
	InferGetServerSidePropsType,
} from "next";
import Head from "next/head";
import Link from "next/link";
import { useRouter } from "next/router";
import { useTranslation } from "next-i18next";
import type { ReactElement } from "react";
import { toast } from "sonner";
import superjson from "superjson";
import { ShowImport } from "@/components/dashboard/application/advanced/import/show-import";
import { ShowVolumes } from "@/components/dashboard/application/advanced/volumes/show-volumes";
import { ShowEnvironment } from "@/components/dashboard/application/environment/show-enviroment";
import { ShowSchedules } from "@/components/dashboard/application/schedules/show-schedules";
import { ShowVolumeBackups } from "@/components/dashboard/application/volume-backups/show-volume-backups";
import { AddCommandCompose } from "@/components/dashboard/compose/advanced/add-command";
import { IsolatedDeploymentTab } from "@/components/dashboard/compose/advanced/add-isolation";
import { ShowComposeAgentProfile } from "@/components/dashboard/compose/advanced/agent-profile/show-agent-profile";
import { DeleteService } from "@/components/dashboard/compose/delete-service";
import { ShowGeneralCompose } from "@/components/dashboard/compose/general/show";
import { ShowDockerLogsCompose } from "@/components/dashboard/compose/logs/show";
import { ShowDockerLogsStack } from "@/components/dashboard/compose/logs/show-stack";
import { UpdateCompose } from "@/components/dashboard/compose/update-compose";
import { ShowBackups } from "@/components/dashboard/database/backups/show-backups";
import { ComposeFreeMonitoring } from "@/components/dashboard/monitoring/free/container/show-free-compose-monitoring";
import { ComposePaidMonitoring } from "@/components/dashboard/monitoring/paid/container/show-paid-compose-monitoring";
import { scanT } from "@/components/dashboard/scanning/scan-i18n";
import { ShowScanJobs } from "@/components/dashboard/scanning/show-scan-jobs";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { BreadcrumbSidebar } from "@/components/shared/breadcrumb-sidebar";
import { StatusTooltip } from "@/components/shared/status-tooltip";
import {
	DashboardPage,
	DashboardPageBody,
	DashboardPageHeader,
	DashboardPageTabContent,
	DashboardPageTabs,
} from "@/components/dashboard/ui-system";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { UseKeyboardNav } from "@/hooks/use-keyboard-nav";
import { parseTabParam } from "@/lib/ui-system/tab-query";
import { appRouter } from "@/server/api/root";
import { api } from "@/utils/api";
import { getLocale, serverSideTranslations } from "@/utils/i18n";

/** Keyboard-shortcut destinations with content but no visible trigger. */
const HIDDEN_TAB_VALUES = ["schedules", "volumeBackups", "logs", "monitoring"];

const Service = (
	props: InferGetServerSidePropsType<typeof getServerSideProps>,
) => {
	const { t } = useTranslation("scan");
	const { composeId } = props;
	const router = useRouter();
	const { projectId, environmentId } = router.query;
	const { data } = api.compose.one.useQuery({ composeId });

	const { data: auth } = api.user.get.useQuery();
	const { data: isCloud } = api.settings.isCloud.useQuery();

	const tabs = [
		{ value: "general", label: "General" },
		{ value: "environment", label: "Environment" },
		{
			value: "deployments",
			label: scanT(t, "scan.jobs.title", "Jobs"),
		},
		{ value: "backups", label: "Backups" },
		{ value: "advanced", label: "Advanced" },
	];
	const tabValues = [...tabs.map((tab) => tab.value), ...HIDDEN_TAB_VALUES];
	const activeTab = parseTabParam(router.query, tabValues, "general");
	const serverInactive = data?.server?.serverStatus === "inactive";

	return (
		<div className="pb-10">
			<UseKeyboardNav forPage="compose" />
			<BreadcrumbSidebar
				list={[
					{ name: "Projects", href: "/dashboard/projects" },
					{
						name: data?.environment?.project?.name || "",
					},
					{
						name: data?.environment?.name || "",
						href: `/dashboard/project/${projectId}/environment/${environmentId}`,
					},
					{
						name: data?.name || "",
					},
				]}
			/>
			<Head>
				<title>
					Compose: {data?.name} - {data?.environment?.project?.name} | Vulseek
				</title>
			</Head>
			<DashboardPage>
				<DashboardPageHeader
					icon={<CircuitBoard />}
					title={data?.name}
					status={<StatusTooltip status={data?.composeStatus} />}
					description={[data?.description, data?.appName]
						.filter(Boolean)
						.join(" · ")}
					actions={
						<>
							<Badge
								className="cursor-pointer"
								onClick={() => {
									if (data?.server?.ipAddress) {
										copy(data.server.ipAddress);
										toast.success("IP Address Copied!");
									}
								}}
								variant={
									!data?.serverId
										? "default"
										: data?.server?.serverStatus === "active"
											? "default"
											: "destructive"
								}
							>
								{data?.server?.name || "Vulseek Server"}
							</Badge>
							{data?.server?.serverStatus === "inactive" && (
								<TooltipProvider delayDuration={0}>
									<Tooltip>
										<TooltipTrigger asChild>
											<Label className="flex w-fit cursor-pointer items-center gap-1">
												<HelpCircle className="size-4 text-muted-foreground" />
											</Label>
										</TooltipTrigger>
										<TooltipContent
											className="z-[999] w-[300px]"
											align="start"
											side="top"
										>
											<span>
												You cannot, deploy this application because the server
												is inactive, please upgrade your plan to add more
												servers.
											</span>
										</TooltipContent>
									</Tooltip>
								</TooltipProvider>
							)}
							<UpdateCompose composeId={composeId} />
							{(auth?.role === "owner" || auth?.canDeleteServices) && (
								<DeleteService id={composeId} type="compose" />
							)}
						</>
					}
				/>
				{!serverInactive && (
					<DashboardPageTabs
						tabs={tabs}
						hiddenValues={HIDDEN_TAB_VALUES}
						fallback="general"
					/>
				)}
				<DashboardPageBody>
					<DashboardPageTabContent>
						{serverInactive ? (
							<div className="flex h-[55vh] border-2 rounded-xl border-dashed p-4">
								<div className="max-w-3xl mx-auto flex flex-col items-center justify-center self-center gap-3">
									<ServerOff className="size-10 text-muted-foreground self-center" />
									<span className="text-center text-base text-muted-foreground">
										This profile is hosted on the server {data?.server?.name},
										but this server has been disabled because your current plan
										doesn't include enough servers. Please purchase more servers
										to regain access to this application.
									</span>
									<span className="text-center text-base text-muted-foreground">
										Go to{" "}
										<Link
											href="/dashboard/settings/billing"
											className="text-primary"
										>
											Billing
										</Link>
									</span>
								</div>
							</div>
						) : (
							<div className="flex flex-col gap-4">
								{activeTab === "general" && (
									<ShowGeneralCompose composeId={composeId} />
								)}
								{activeTab === "environment" && (
									<ShowEnvironment id={composeId} type="compose" />
								)}
								{activeTab === "backups" && (
									<ShowBackups id={composeId} backupType="compose" />
								)}
								{activeTab === "schedules" && (
									<ShowSchedules id={composeId} scheduleType="compose" />
								)}
								{activeTab === "volumeBackups" && (
									<ShowVolumeBackups
										id={composeId}
										type="compose"
										serverId={data?.serverId || ""}
									/>
								)}
								{activeTab === "monitoring" && (
									<div className="flex flex-col border rounded-lg">
										{data?.serverId && isCloud ? (
											<ComposePaidMonitoring
												serverId={data?.serverId || ""}
												baseUrl={`${
													data?.serverId
														? `http://${data?.server?.ipAddress}:${data?.server?.metricsConfig?.server?.port}`
														: "http://localhost:4500"
												}`}
												appName={data?.appName || ""}
												token={data?.server?.metricsConfig?.server?.token || ""}
												appType={data?.composeType || "docker-compose"}
											/>
										) : (
											<ComposeFreeMonitoring
												serverId={data?.serverId || ""}
												appName={data?.appName || ""}
												appType={data?.composeType || "docker-compose"}
											/>
										)}
									</div>
								)}
								{activeTab === "logs" &&
									(data?.composeType === "docker-compose" ? (
										<ShowDockerLogsCompose
											serverId={data?.serverId || ""}
											appName={data?.appName || ""}
											appType={data?.composeType || "docker-compose"}
										/>
									) : (
										<ShowDockerLogsStack
											serverId={data?.serverId || ""}
											appName={data?.appName || ""}
										/>
									))}
								{activeTab === "deployments" && (
									<ShowScanJobs id={composeId} type="compose" />
								)}
								{activeTab === "advanced" && (
									<>
										<ShowComposeAgentProfile composeId={composeId} />
										<AddCommandCompose composeId={composeId} />
										<ShowVolumes id={composeId} type="compose" />
										<ShowImport composeId={composeId} />
										<IsolatedDeploymentTab composeId={composeId} />
									</>
								)}
							</div>
						)}
					</DashboardPageTabContent>
				</DashboardPageBody>
			</DashboardPage>
		</div>
	);
};

export default Service;
Service.getLayout = (page: ReactElement) => {
	return <DashboardLayout>{page}</DashboardLayout>;
};

export async function getServerSideProps(
	ctx: GetServerSidePropsContext<{
		composeId: string;
		environmentId: string;
	}>,
) {
	const { params, req, res } = ctx;
	const { user, session } = await validateRequest(req);
	if (!user) {
		return {
			redirect: {
				permanent: true,
				destination: "/",
			},
		};
	}
	// Fetch data from external API
	const helpers = createServerSideHelpers({
		router: appRouter,
		ctx: {
			req: req as any,
			res: res as any,
			db: null as any,
			session: session as any,
			user: user as any,
		},
		transformer: superjson,
	});

	// Valid project, if not return to initial homepage....
	if (typeof params?.composeId === "string") {
		try {
			await helpers.compose.one.fetch({
				composeId: params?.composeId,
			});
			await helpers.settings.isCloud.prefetch();
			return {
				props: {
					...(await serverSideTranslations(getLocale(req.cookies), [
						"common",
						"scan",
					])),
					trpcState: helpers.dehydrate(),
					composeId: params?.composeId,
					environmentId: params?.environmentId,
				},
			};
		} catch {
			return {
				redirect: {
					permanent: false,
					destination: "/dashboard/projects",
				},
			};
		}
	}

	return {
		redirect: {
			permanent: false,
			destination: "/",
		},
	};
}
