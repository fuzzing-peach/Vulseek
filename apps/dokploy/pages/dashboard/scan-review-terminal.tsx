import { validateRequest } from "@dokploy/server/lib/auth";
import type { GetServerSidePropsContext } from "next";
import type { ReactElement } from "react";
import { ShowScanReviewTerminal } from "@/components/dashboard/scanning/show-scan-review-terminal";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { getLocale, serverSideTranslations } from "@/utils/i18n";

const ScanReviewTerminalPage = () => <ShowScanReviewTerminal />;

export default ScanReviewTerminalPage;

ScanReviewTerminalPage.getLayout = function getLayout(page: ReactElement) {
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

	return {
		props: {
			...(await serverSideTranslations(getLocale(context.req.cookies), [
				"common",
				"scan",
			])),
		},
	};
}
