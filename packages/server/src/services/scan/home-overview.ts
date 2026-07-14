import {
	getScanHomeActivity,
	getScanHomeSummary,
	getScanHomeWorkload,
} from "./home-overview-queries";

export * from "./home-overview-aggregate";

export const getScanHomeOverviewSummary = getScanHomeSummary;
export const getScanHomeOverviewActivity = getScanHomeActivity;
export const getScanHomeOverviewWorkload = getScanHomeWorkload;

export const getScanHomeOverview = async (input: {
	organizationId: string;
	days?: number;
}) => {
	const [summary, activity, workload] = await Promise.all([
		getScanHomeSummary(input.organizationId),
		getScanHomeActivity({
			organizationId: input.organizationId,
			days: input.days,
		}),
		getScanHomeWorkload(input.organizationId),
	]);
	return {
		...summary,
		running: workload,
		dailyActivity: activity.days,
	};
};
