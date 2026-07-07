import { validateRequest } from "@vulseek/server/lib/auth";
import { createServerSideHelpers } from "@trpc/react-query/server";
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
import { type ReactElement, useEffect, useState } from "react";
import { toast } from "sonner";
import superjson from "superjson";
import { ShowClusterSettings } from "@/components/dashboard/application/advanced/cluster/show-cluster-settings";
import { ShowAgentProfile } from "@/components/dashboard/application/advanced/agent-profile/show-agent-profile";
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
import { ShowScanJobs } from "@/components/dashboard/scanning/show-scan-jobs";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { BreadcrumbSidebar } from "@/components/shared/breadcrumb-sidebar";
import { DashboardPanelShell } from "@/components/shared/dashboard-panel-shell";
import { StatusTooltip } from "@/components/shared/status-tooltip";
import { Badge } from "@/components/ui/badge";
import {
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { UseKeyboardNav } from "@/hooks/use-keyboard-nav";
import { appRouter } from "@/server/api/root";
import { api } from "@/utils/api";
import { getLocale, serverSideTranslations } from "@/utils/i18n";
import { scanT } from "@/components/dashboard/scanning/scan-i18n";

type TabState =
	| "general"
	| "environment"
	| "projects"
	| "settings"
	| "advanced"
	| "deployments"
	| "monitoring"
	| "volume-backups";

const HIDDEN_JOB_TABS = new Set([
	"schedules",
	"volume-backups",
	"logs",
	"monitoring",
]);

const normalizeApplicationTab = (value: unknown): TabState => {
	if (typeof value === "string" && !HIDDEN_JOB_TABS.has(value)) {
		return value as TabState;
	}
	return "general";
};

const Service = (
	props: InferGetServerSidePropsType<typeof getServerSideProps>,
) => {
	const { t } = useTranslation("scan");
	const { t: commonT } = useTranslation("common");
	const [_toggleMonitoring, _setToggleMonitoring] = useState(false);
	const { applicationId, activeTab } = props;
	const router = useRouter();
	const { projectId, environmentId } = router.query;
	const [tab, setTab] = useState<TabState>(normalizeApplicationTab(activeTab));

	useEffect(() => {
		if (router.query.tab) {
			setTab(normalizeApplicationTab(router.query.tab));
		}
	}, [router.query.tab]);

	const { data } = api.application.one.useQuery(
		{ applicationId },
		{
			refetchInterval: 5000,
		},
	);

	const { data: isCloud } = api.settings.isCloud.useQuery();
	const { data: auth } = api.user.get.useQuery();

	return (
		<div className="pb-10">
			<UseKeyboardNav forPage="application" />
			<BreadcrumbSidebar
				list={[
					{ name: scanT(t, "scan.breadcrumb.projects", "Projects"), href: "/dashboard/projects" },
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
			<div className="w-full">
				<DashboardPanelShell>
						<CardHeader className="flex flex-row justify-between items-center">
							<div className="flex flex-col">
								<CardTitle className="text-xl flex flex-row gap-2">
									<div className="relative flex flex-row gap-4">
										<div className="absolute -right-1 -top-2">
											<StatusTooltip status={data?.applicationStatus} />
										</div>

										<GlobeIcon className="h-6 w-6 text-muted-foreground" />
									</div>
									{data?.name}
								</CardTitle>
								{data?.description && (
									<CardDescription>{data?.description}</CardDescription>
								)}

								<span className="text-sm text-muted-foreground">
									{data?.appName}
								</span>
							</div>
							<div className="flex flex-col h-fit w-fit gap-2">
								<div className="flex flex-row h-fit w-fit gap-2">
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
													<Label className="break-all w-fit flex flex-row gap-1 items-center">
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
								</div>

								<div className="flex flex-row gap-2 justify-end">
									<UpdateApplication applicationId={applicationId} />
									{(auth?.role === "owner" || auth?.canDeleteServices) && (
										<DeleteService id={applicationId} type="application" />
									)}
								</div>
							</div>
						</CardHeader>
						<CardContent className="space-y-2 py-8 border-t">
							{data?.server?.serverStatus === "inactive" ? (
								<div className="flex h-[55vh] border-2 rounded-xl border-dashed p-4">
									<div className="max-w-3xl mx-auto flex flex-col items-center justify-center self-center gap-3">
										<ServerOff className="size-10 text-muted-foreground self-center" />
										<span className="text-center text-base text-muted-foreground">
											{commonT("application.serverDisabledMessage", {
												server: data.server.name,
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
								<Tabs
									value={tab}
									defaultValue="general"
									className="w-full"
									onValueChange={(e) => {
										setTab(e as TabState);
										const newPath = `/dashboard/project/${projectId}/environment/${environmentId}/profiles/application/${applicationId}?tab=${e}`;
										router.push(newPath);
									}}
								>
									<div className="flex flex-row items-center justify-between w-full overflow-auto">
										<TabsList className="flex gap-8 max-md:gap-4 justify-start">
											<TabsTrigger value="general">
												{commonT("application.tabs.general")}
											</TabsTrigger>
											<TabsTrigger value="environment">
												{commonT("application.tabs.environment")}
											</TabsTrigger>
											<TabsTrigger value="deployments">
												{scanT(t, "scan.jobs.title", "Jobs")}
											</TabsTrigger>
											<TabsTrigger value="advanced">
												{commonT("application.tabs.advanced")}
											</TabsTrigger>
										</TabsList>
									</div>

									<TabsContent value="general">
										<div className="flex flex-col gap-4 pt-2.5">
											<ShowGeneralApplication applicationId={applicationId} />
										</div>
									</TabsContent>
									<TabsContent value="environment">
										<div className="flex flex-col gap-4 pt-2.5">
											<ShowEnvironment applicationId={applicationId} />
										</div>
									</TabsContent>

									<TabsContent value="monitoring">
										<div className="pt-2.5">
											<div className="flex flex-col gap-4 border rounded-lg p-6">
												{data?.serverId && isCloud ? (
													<ContainerPaidMonitoring
														appName={data?.appName || ""}
														baseUrl={`${data?.serverId ? `http://${data?.server?.ipAddress}:${data?.server?.metricsConfig?.server?.port}` : "http://localhost:4500"}`}
														token={
															data?.server?.metricsConfig?.server?.token || ""
														}
													/>
												) : (
													<>
														{/* {monitoring?.enabledFeatures &&
															isCloud &&
															data?.serverId && (
																<div className="flex flex-row border w-fit p-4 rounded-lg items-center gap-2">
																	<Label className="text-muted-foreground">
																		Change Monitoring
																	</Label>
																	<Switch
																		checked={toggleMonitoring}
																		onCheckedChange={setToggleMonitoring}
																	/>
																</div>
															)} */}

														{/* {toggleMonitoring ? (
															<ContainerPaidMonitoring
																appName={data?.appName || ""}
																baseUrl={`http://${monitoring?.serverIp}:${monitoring?.metricsConfig?.server?.port}`}
																token={
																	monitoring?.metricsConfig?.server?.token || ""
																}
															/>
														) : ( */}
														<div>
															<ContainerFreeMonitoring
																appName={data?.appName || ""}
															/>
														</div>
														{/* )} */}
													</>
												)}
											</div>
										</div>
									</TabsContent>

									<TabsContent value="logs">
										<div className="flex flex-col gap-4 pt-2.5">
											<ShowDockerLogs
												appName={data?.appName || ""}
												serverId={data?.serverId || ""}
											/>
										</div>
									</TabsContent>
									<TabsContent value="schedules">
										<div className="flex flex-col gap-4 pt-2.5">
											<ShowSchedules
												id={applicationId}
												scheduleType="application"
											/>
										</div>
									</TabsContent>
									<TabsContent value="deployments" className="w-full pt-2.5">
										<div className="flex flex-col gap-4 border rounded-lg">
											<ShowScanJobs id={applicationId} type="application" />
										</div>
									</TabsContent>
									<TabsContent value="volume-backups" className="w-full pt-2.5">
										<div className="flex flex-col gap-4 border rounded-lg">
											<ShowVolumeBackups
												id={applicationId}
												type="application"
												serverId={data?.serverId || ""}
											/>
										</div>
									</TabsContent>
									<TabsContent value="advanced">
										<div className="flex flex-col gap-4 pt-2.5">
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
										</div>
									</TabsContent>
								</Tabs>
							)}
						</CardContent>
				</DashboardPanelShell>
			</div>
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
		activeTab: TabState;
		environmentId: string;
	}>,
) {
	const { query, params, req, res } = ctx;

	const activeTab = query.tab;
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
					activeTab: (activeTab || "general") as TabState,
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
