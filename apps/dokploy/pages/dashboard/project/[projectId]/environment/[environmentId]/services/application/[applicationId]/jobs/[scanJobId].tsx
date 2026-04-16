import { validateRequest } from "@dokploy/server/lib/auth";
import type { GetServerSidePropsContext, InferGetServerSidePropsType } from "next";
import type { ReactElement } from "react";
import { ShowScanJobDetail } from "@/components/dashboard/scanning/show-scan-job-detail";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";

const ScanJobDetailPage = (
	props: InferGetServerSidePropsType<typeof getServerSideProps>,
) => {
	return (
		<ShowScanJobDetail
			projectId={props.projectId}
			environmentId={props.environmentId}
			serviceId={props.applicationId}
			scanJobId={props.scanJobId}
			serviceType="application"
			routeSegment="services"
		/>
	);
};

export default ScanJobDetailPage;

ScanJobDetailPage.getLayout = function getLayout(page: ReactElement) {
	return <DashboardLayout>{page}</DashboardLayout>;
};

export async function getServerSideProps(context: GetServerSidePropsContext) {
	const session = await validateRequest(context.req);
	if (!session.user) {
		return {
			redirect: {
				destination: "/auth/login",
				permanent: false,
			},
		};
	}

	const { projectId, environmentId, applicationId, scanJobId } =
		context.params || {};

	if (
		typeof projectId !== "string" ||
		typeof environmentId !== "string" ||
		typeof applicationId !== "string" ||
		typeof scanJobId !== "string"
	) {
		return { notFound: true };
	}

	return {
		props: {
			projectId,
			environmentId,
			applicationId,
			scanJobId,
		},
	};
}

