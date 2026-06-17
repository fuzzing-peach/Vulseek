import { validateRequest } from "@dokploy/server/lib/auth";
import type { GetServerSidePropsContext, InferGetServerSidePropsType } from "next";
import type { ReactElement } from "react";
import { ShowScanJobDetail } from "@/components/dashboard/scanning/show-scan-job-detail";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { getLocale, serverSideTranslations } from "@/utils/i18n";

const ScanJobDetailPage = (
	props: InferGetServerSidePropsType<typeof getServerSideProps>,
) => {
	return (
		<ShowScanJobDetail
			projectId={props.projectId}
			environmentId={props.environmentId}
			serviceId={props.composeId}
			scanJobId={props.scanJobId}
			serviceType="compose"
			routeSegment="profiles"
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
				destination: "/",
				permanent: false,
			},
		};
	}

	const { projectId, environmentId, composeId, scanJobId } = context.params || {};

	if (
		typeof projectId !== "string" ||
		typeof environmentId !== "string" ||
		typeof composeId !== "string" ||
		typeof scanJobId !== "string"
	) {
		return { notFound: true };
	}

	return {
		props: {
			...(await serverSideTranslations(getLocale(context.req.cookies), [
				"common",
				"scan",
			])),
			projectId,
			environmentId,
			composeId,
			scanJobId,
		},
	};
}
