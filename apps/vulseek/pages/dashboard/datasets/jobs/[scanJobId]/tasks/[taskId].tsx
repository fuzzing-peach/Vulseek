import type { ReactElement } from "react";
import { ShowScanTaskDetail } from "@/components/dashboard/scanning/show-scan-task-detail";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { datasetScanNavigation } from "@/lib/ui-system/route-builders";

const DatasetTaskPage = () => (
	<ShowScanTaskDetail navigation={datasetScanNavigation()} />
);

DatasetTaskPage.getLayout = (page: ReactElement) => (
	<DashboardLayout>{page}</DashboardLayout>
);
export default DatasetTaskPage;
