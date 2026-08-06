import { createServerSideHelpers } from "@trpc/react-query/server";
import { validateRequest } from "@vulseek/server/lib/auth";
import copy from "copy-to-clipboard";
import { GlobeIcon, HelpCircle, ServerOff } from "lucide-react";
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
import { ShowAgentProfile } from "@/components/dashboard/application/advanced/agent-profile/show-agent-profile";
import { ShowClusterSettings } from "@/components/dashboard/application/advanced/cluster/show-cluster-settings";
import { AddCommand } from "@/components/dashboard/application/advanced/general/add-command";
import { ShowPorts } from "@/components/dashboard/application/advanced/ports/show-port";
import { ShowRedirects } from "@/components/dashboard/application/advanced/redirects/show-redirects";
import { ShowSecurity } from "@/components/dashboard/application/advanced/security/show-security";
import { ShowResources } from "@/components/dashboard/application/advanced/show-resources";
import { ShowTraefikConfig } from "@/components/dashboard/application/advanced/traefik/show-traefik-config";
import { ShowVolumes } from "@/components/dashboard/application/advanced/volumes/show-volumes";
import { ShowEnvironment } from "@/components/dashboard/application/environment/show";
import { ShowGeneralApplication } from "@/components/dashboard/application/general/show";
import { ShowDockerLogs } from "@/components/dashboard/application/logs/show";
import { ShowSchedules } from "@/components/dashboard/application/schedules/show-schedules";
import { UpdateApplication } from "@/components/dashboard/application/update-application";
import { ShowVolumeBackups } from "@/components/dashboard/application/volume-backups/show-volume-backups";
import { DeleteService } from "@/components/dashboard/compose/delete-service";
import { ContainerFreeMonitoring } from "@/components/dashboard/monitoring/free/container/show-free-container-monitoring";
import { ContainerPaidMonitoring } from "@/components/dashboard/monitoring/paid/container/show-paid-container-monitoring";
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
const HIDDEN_TAB_VALUES = ["schedules", "volume-backups", "logs", "monitoring"];

const Service = (
	props: InferGetServerSidePropsType<typeof getServerSideProps>,
) => {
	const { t } = useTranslation("scan");
	const { t: commonT } = useTranslation("common");
	const { applicationId } = props;
	const router = useRouter();
	const { projectId, environmentId } = router.query;
	const { data } = api.application.one.useQuery(
		{ applicationId },
		{
			refetchInterval: 5000,
		},
	);

	const { data: isCloud } = api.settings.isCloud.useQuery();
	const { data: auth } = api.user.get.useQuery();

	const tabs = [
		{ value: "general", label: commonT("application.tabs.general") },
		{ value: "environment", label: commonT("application.tabs.environment") },
		{
			value: "deployments",
			label: scanT(t, "scan.jobs.title", "Jobs"),
		},
		{ value: "advanced", label: commonT("application.tabs.advanced") },
	];
	const tabValues = [...tabs.map((tab) => tab.value), ...HIDDEN_TAB_VALUES];
	const activeTab = parseTabParam(router.query, tabValues, "general");
	const serverInactive = data?.server?.serverStatus === "inactive";

	return (
		<div className="pb-10">
			<UseKeyboardNav forPage="application" />
			<BreadcrumbSidebar
				list={[
					{
						name: scanT(t, "scan.breadcrumb.projects", "Projects"),
						href: "/dashboard/projects",
					},
					{
						name: data?.environment.project.name || "",
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
					{commonT("application.pageTitlePrefix")}: {data?.name} -{" "}
					{data?.environment.project.name} | Vulseek
				</title>
			</Head>
			<DashboardPage>
				<DashboardPageHeader
					icon={<GlobeIcon />}
					title={data?.name}
					status={<StatusTooltip status={data?.applicationStatus} />}
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
										toast.success(commonT("application.ipCopied"));
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
								{data?.server?.name || commonT("application.defaultServer")}
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
												{commonT("application.serverInactiveDeployBlocked")}
											</span>
										</TooltipContent>
									</Tooltip>
								</TooltipProvider>
							)}
							<UpdateApplication applicationId={applicationId} />
							{(auth?.role === "owner" || auth?.canDeleteServices) && (
								<DeleteService id={applicationId} type="application" />
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
										{commonT("application.serverDisabledMessage", {
											server: data?.server?.name ?? "",
										})}
									</span>
									<span className="text-center text-base text-muted-foreground">
										{commonT("application.goTo")}{" "}
										<Link
											href="/dashboard/settings/billing"
											className="text-primary"
										>
											{commonT("application.billing")}
										</Link>
									</span>
								</div>
							</div>
						) : (
							<div className="flex flex-col gap-4">
								{activeTab === "general" && (
									<ShowGeneralApplication applicationId={applicationId} />
								)}
								{activeTab === "environment" && (
									<ShowEnvironment applicationId={applicationId} />
								)}
								{activeTab === "monitoring" && (
									<div className="flex flex-col gap-4 border rounded-lg p-6">
										{data?.serverId && isCloud ? (
											<ContainerPaidMonitoring
												appName={data?.appName || ""}
												baseUrl={`${
													data?.serverId
														? `http://${data?.server?.ipAddress}:${data?.server?.metricsConfig?.server?.port}`
														: "http://localhost:4500"
												}`}
												token={data?.server?.metricsConfig?.server?.token || ""}
											/>
										) : (
											<ContainerFreeMonitoring appName={data?.appName || ""} />
										)}
									</div>
								)}
								{activeTab === "logs" && (
									<ShowDockerLogs
										appName={data?.appName || ""}
										serverId={data?.serverId || ""}
									/>
								)}
								{activeTab === "schedules" && (
									<ShowSchedules
										id={applicationId}
										scheduleType="application"
									/>
								)}
								{activeTab === "deployments" && (
									<ShowScanJobs id={applicationId} type="application" />
								)}
								{activeTab === "volume-backups" && (
									<div className="flex flex-col gap-4 border rounded-lg">
										<ShowVolumeBackups
											id={applicationId}
											type="application"
											serverId={data?.serverId || ""}
										/>
									</div>
								)}
								{activeTab === "advanced" && (
									<>
										<ShowAgentProfile applicationId={applicationId} />
										<AddCommand applicationId={applicationId} />
										<ShowClusterSettings
											id={applicationId}
											type="application"
										/>
										<ShowResources id={applicationId} type="application" />
										<ShowVolumes id={applicationId} type="application" />
										<ShowRedirects applicationId={applicationId} />
										<ShowSecurity applicationId={applicationId} />
										<ShowPorts applicationId={applicationId} />
										<ShowTraefikConfig applicationId={applicationId} />
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
		applicationId: string;
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
	if (typeof params?.applicationId === "string") {
		try {
			await helpers.application.one.fetch({
				applicationId: params?.applicationId,
			});

			await helpers.settings.isCloud.prefetch();

			return {
				props: {
					...(await serverSideTranslations(getLocale(req.cookies), [
						"common",
						"scan",
					])),
					trpcState: helpers.dehydrate(),
					applicationId: params?.applicationId,
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
