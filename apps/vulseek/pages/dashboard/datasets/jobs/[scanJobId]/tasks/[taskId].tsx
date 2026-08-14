import { useRouter } from "next/router";
import type { ReactElement } from "react";
import { ShowScanTaskDetail } from "@/components/dashboard/scanning/show-scan-task-detail";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import {
	datasetScanNavigation,
	datasetTrialScanNavigation,
} from "@/lib/ui-system/route-builders";
import { api } from "@/utils/api";

const DatasetTaskPage = () => {
	const router = useRouter();
	const scanJobId =
		typeof router.query.scanJobId === "string" ? router.query.scanJobId : "";
	const { data: trialNavigation } =
		api.dataset.evaluations.navigationByScanJob.useQuery(
			{ scanJobId },
			{ enabled: Boolean(scanJobId) },
		);

	return (
		<ShowScanTaskDetail
			navigation={
				trialNavigation
					? datasetTrialScanNavigation(trialNavigation)
					: datasetScanNavigation()
			}
		/>
	);
};

DatasetTaskPage.getLayout = (page: ReactElement) => (
	<DashboardLayout>{page}</DashboardLayout>
);
export default DatasetTaskPage;
