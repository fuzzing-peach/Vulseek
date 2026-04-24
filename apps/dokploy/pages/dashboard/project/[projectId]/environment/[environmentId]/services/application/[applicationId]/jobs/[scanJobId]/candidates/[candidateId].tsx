import { validateRequest } from "@dokploy/server/lib/auth";
import type { GetServerSidePropsContext } from "next";
import type { ReactElement } from "react";
import { ShowScanCandidateDetail } from "@/components/dashboard/scanning/show-scan-candidate-detail";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";

const Page = () => {
	return <ShowScanCandidateDetail serviceType="application" routeSegment="services" />;
};

export default Page;


Page.getLayout = function getLayout(page: ReactElement) {
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

	const { projectId, environmentId, applicationId, scanJobId, candidateId } =
		context.params || {};

	if (
		typeof projectId !== "string" ||
		typeof environmentId !== "string" ||
		typeof applicationId !== "string" ||
		typeof scanJobId !== "string" ||
		typeof candidateId !== "string"
	) {
		return { notFound: true };
	}

	return {
		props: {
			projectId,
			environmentId,
			applicationId,
			scanJobId,
			candidateId,
		},
	};
}
