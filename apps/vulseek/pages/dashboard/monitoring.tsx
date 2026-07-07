import { IS_CLOUD } from "@vulseek/server/constants";
import { validateRequest } from "@vulseek/server/lib/auth";
import { Loader2 } from "lucide-react";
import type { GetServerSidePropsContext } from "next";
import type { ReactElement } from "react";
import { ContainerFreeMonitoring } from "@/components/dashboard/monitoring/free/container/show-free-container-monitoring";
import { ShowPaidMonitoring } from "@/components/dashboard/monitoring/paid/servers/show-paid-monitoring";
import { GlobalScanMonitoring } from "@/components/dashboard/monitoring/scan/global-scan-monitoring";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { api } from "@/utils/api";

const BASE_URL = "http://localhost:3001/metrics";

const DEFAULT_TOKEN = "metrics";

const Dashboard = () => {
	const [toggleMonitoring, _setToggleMonitoring] = useLocalStorage(
		"monitoring-enabled",
		false,
	);

	const { data: monitoring, isLoading } = api.user.getMetricsToken.useQuery();
	return (
		<div className="space-y-4 pb-10">
			<Tabs defaultValue="system">
				<TabsList>
					<TabsTrigger value="system">System</TabsTrigger>
					<TabsTrigger value="scan">Scan Activity</TabsTrigger>
				</TabsList>
				<TabsContent value="system">
					{isLoading ? (
						<Card className="bg-sidebar  p-2.5 rounded-xl  mx-auto  items-center">
							<div className="rounded-xl bg-background flex shadow-md px-4 min-h-[50vh] justify-center items-center text-muted-foreground">
								Loading...
								<Loader2 className="h-4 w-4 animate-spin" />
							</div>
						</Card>
					) : (
						<>
							{toggleMonitoring ? (
								<Card className="bg-sidebar  p-2.5 rounded-xl  mx-auto">
									<div className="rounded-xl bg-background shadow-md">
										<ShowPaidMonitoring
											BASE_URL={
												process.env.NODE_ENV === "production"
													? `http://${monitoring?.serverIp}:${monitoring?.metricsConfig?.server?.port}/metrics`
													: BASE_URL
											}
											token={
												process.env.NODE_ENV === "production"
													? monitoring?.metricsConfig?.server?.token
													: DEFAULT_TOKEN
											}
										/>
									</div>
								</Card>
							) : (
								<Card className="h-full bg-sidebar  p-2.5 rounded-xl">
									<div className="rounded-xl bg-background shadow-md p-6">
										<ContainerFreeMonitoring appName="vulseek" />
									</div>
								</Card>
							)}
						</>
					)}
				</TabsContent>
				<TabsContent value="scan">
					<div className="py-4">
						<GlobalScanMonitoring />
					</div>
				</TabsContent>
			</Tabs>
		</div>
	);
};

export default Dashboard;

Dashboard.getLayout = (page: ReactElement) => {
	return <DashboardLayout>{page}</DashboardLayout>;
};
export async function getServerSideProps(
	ctx: GetServerSidePropsContext<{ serviceId: string }>,
) {
	if (IS_CLOUD) {
		return {
			redirect: {
				permanent: true,
				destination: "/dashboard/projects",
			},
		};
	}
	const { user } = await validateRequest(ctx.req);
	if (!user) {
		return {
			redirect: {
				permanent: true,
				destination: "/",
			},
		};
	}

	return {
		props: {},
	};
}
