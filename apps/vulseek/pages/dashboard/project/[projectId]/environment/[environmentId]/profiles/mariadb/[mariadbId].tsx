import { createServerSideHelpers } from "@trpc/react-query/server";
import { validateRequest } from "@vulseek/server/lib/auth";
import { HelpCircle, ServerOff } from "lucide-react";
import type {
	GetServerSidePropsContext,
	InferGetServerSidePropsType,
} from "next";
import Head from "next/head";
import Link from "next/link";
import { useRouter } from "next/router";
import type { ReactElement } from "react";
import superjson from "superjson";
import { ShowEnvironment } from "@/components/dashboard/application/environment/show-enviroment";
import { ShowDockerLogs } from "@/components/dashboard/application/logs/show";
import { DeleteService } from "@/components/dashboard/compose/delete-service";
import { ShowBackups } from "@/components/dashboard/database/backups/show-backups";
import { ShowExternalMariadbCredentials } from "@/components/dashboard/mariadb/general/show-external-mariadb-credentials";
import { ShowGeneralMariadb } from "@/components/dashboard/mariadb/general/show-general-mariadb";
import { ShowInternalMariadbCredentials } from "@/components/dashboard/mariadb/general/show-internal-mariadb-credentials";
import { UpdateMariadb } from "@/components/dashboard/mariadb/update-mariadb";
import { ContainerFreeMonitoring } from "@/components/dashboard/monitoring/free/container/show-free-container-monitoring";
import { ContainerPaidMonitoring } from "@/components/dashboard/monitoring/paid/container/show-paid-container-monitoring";
import { ShowDatabaseAdvancedSettings } from "@/components/dashboard/shared/show-database-advanced-settings";
import { MariadbIcon } from "@/components/icons/data-tools-icons";
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

const TABS = [
	{ value: "general", label: "General" },
	{ value: "environment", label: "Environment" },
	{ value: "logs", label: "Logs" },
	{ value: "monitoring", label: "Monitoring" },
	{ value: "backups", label: "Backups" },
	{ value: "advanced", label: "Advanced" },
] as const;

const TAB_VALUES = TABS.map((tab) => tab.value);

const Mariadb = (
	props: InferGetServerSidePropsType<typeof getServerSideProps>,
) => {
	const { mariadbId } = props;
	const router = useRouter();
	const { projectId, environmentId } = router.query;
	const { data } = api.mariadb.one.useQuery({ mariadbId });
	const { data: auth } = api.user.get.useQuery();
	const { data: isCloud } = api.settings.isCloud.useQuery();

	const activeTab = parseTabParam(router.query, TAB_VALUES, "general");
	const showMonitoring = Boolean((data?.serverId && isCloud) || !data?.server);
	const tabs = showMonitoring
		? TABS
		: TABS.filter((tab) => tab.value !== "monitoring");
	const serverInactive = data?.server?.serverStatus === "inactive";

	return (
		<div className="pb-10">
			<UseKeyboardNav forPage="mariadb" />
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
					Database: {data?.name} - {data?.environment?.project?.name} | Vulseek
				</title>
			</Head>
			<DashboardPage>
				<DashboardPageHeader
					icon={<MariadbIcon />}
					title={data?.name}
					status={<StatusTooltip status={data?.applicationStatus} />}
					description={[data?.description, data?.appName]
						.filter(Boolean)
						.join(" · ")}
					actions={
						<>
							<Badge
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
							<UpdateMariadb mariadbId={mariadbId} />
							{(auth?.role === "owner" || auth?.canDeleteServices) && (
								<DeleteService id={mariadbId} type="mariadb" />
							)}
						</>
					}
				/>
				{!serverInactive && (
					<DashboardPageTabs
						tabs={tabs}
						hiddenValues={["monitoring"]}
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
									<>
										<ShowGeneralMariadb mariadbId={mariadbId} />
										<ShowInternalMariadbCredentials mariadbId={mariadbId} />
										<ShowExternalMariadbCredentials mariadbId={mariadbId} />
									</>
								)}
								{activeTab === "environment" && (
									<ShowEnvironment id={mariadbId} type="mariadb" />
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
										serverId={data?.serverId || ""}
										appName={data?.appName || ""}
									/>
								)}
								{activeTab === "backups" && (
									<ShowBackups id={mariadbId} databaseType="mariadb" />
								)}
								{activeTab === "advanced" && (
									<ShowDatabaseAdvancedSettings id={mariadbId} type="mariadb" />
								)}
							</div>
						)}
					</DashboardPageTabContent>
				</DashboardPageBody>
			</DashboardPage>
		</div>
	);
};

export default Mariadb;
Mariadb.getLayout = (page: ReactElement) => {
	return <DashboardLayout>{page}</DashboardLayout>;
};

export async function getServerSideProps(
	ctx: GetServerSidePropsContext<{
		mariadbId: string;
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

	if (typeof params?.mariadbId === "string") {
		try {
			await helpers.mariadb.one.fetch({
				mariadbId: params?.mariadbId,
			});
			await helpers.settings.isCloud.prefetch();
			return {
				props: {
					trpcState: helpers.dehydrate(),
					mariadbId: params?.mariadbId,
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
