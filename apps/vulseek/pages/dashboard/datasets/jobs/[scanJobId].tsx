import { useRouter } from "next/router";
import type { GetServerSidePropsContext } from "next";
import type { ReactElement } from "react";
import { ShowScanJobDetail } from "@/components/dashboard/scanning/show-scan-job-detail";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import {
	datasetScanNavigation,
	datasetTrialScanNavigation,
} from "@/lib/ui-system/route-builders";
import { api } from "@/utils/api";
import { getLocale, serverSideTranslations } from "@/utils/i18n";

const DatasetScanJobPage = () => {
	const router = useRouter();
	const scanJobId =
		typeof router.query.scanJobId === "string" ? router.query.scanJobId : "";
	const { data: trialNavigation } =
		api.dataset.evaluations.navigationByScanJob.useQuery(
			{ scanJobId },
			{ enabled: Boolean(scanJobId) },
		);
	return (
		<ShowScanJobDetail
			scanJobId={scanJobId}
			navigation={
				trialNavigation
					? datasetTrialScanNavigation(trialNavigation)
					: datasetScanNavigation()
			}
		/>
	);
};

DatasetScanJobPage.getLayout = (page: ReactElement) => (
	<DashboardLayout>{page}</DashboardLayout>
);

export async function getServerSideProps(context: GetServerSidePropsContext) {
	return {
		props: {
			...(await serverSideTranslations(getLocale(context.req.cookies), [
				"common",
				"scan",
			])),
		},
	};
}

export default DatasetScanJobPage;
