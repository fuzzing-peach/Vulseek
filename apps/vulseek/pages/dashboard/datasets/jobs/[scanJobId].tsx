import { useRouter } from "next/router";
import type { ReactElement } from "react";
import { ShowScanJobDetail } from "@/components/dashboard/scanning/show-scan-job-detail";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { datasetScanNavigation } from "@/lib/ui-system/route-builders";

const DatasetScanJobPage = () => {
	const router = useRouter();
	const scanJobId =
		typeof router.query.scanJobId === "string" ? router.query.scanJobId : "";
	return (
		<ShowScanJobDetail
			scanJobId={scanJobId}
			navigation={datasetScanNavigation()}
		/>
	);
};

DatasetScanJobPage.getLayout = (page: ReactElement) => (
	<DashboardLayout>{page}</DashboardLayout>
);
export default DatasetScanJobPage;
