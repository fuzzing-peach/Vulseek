import { Loader2, RocketIcon } from "lucide-react";
import { useTranslation } from "next-i18next";
import Link from "next/link";
import { useRouter } from "next/router";
import { DateTooltip } from "@/components/shared/date-tooltip";
import { Badge } from "@/components/ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { api } from "@/utils/api";
import {
	formatResourceTypeLabel,
	formatScanJobStatusLabel,
	formatScanTypeLabel,
	scanT,
	type ScanTranslation,
} from "./scan-i18n";

interface Props {
	id: string;
	type: "application" | "compose";
}

const statusColorMap = {
	pending: "bg-muted-foreground",
	running: "bg-yellow-500",
	paused: "bg-blue-500",
	finalizing: "bg-blue-500",
	finished: "bg-green-500",
	partially_finished: "bg-orange-500",
	failed: "bg-destructive",
	canceled: "bg-destructive",
} as const;

const formatJobTitle = (job: { scanJobId: string }) =>
	`Scan Job (${job.scanJobId.slice(0, 6)})`;

const formatTriggerSource = (t: ScanTranslation, triggerSource: string) =>
	triggerSource === "schedule"
		? scanT(t, "scan.jobs.auto", "auto")
		: triggerSource === "manual"
			? scanT(t, "scan.jobs.manual", "manual")
			: triggerSource;

const formatTokenUsage = (t: ScanTranslation, value?: number | null) => {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return "-";
	}
	return scanT(t, "scan.tokenUsage", "{{count}} tokens", {
		count: new Intl.NumberFormat().format(value),
	});
};

export const ShowScanJobs = ({ id, type }: Props) => {
	const { t } = useTranslation("scan");
	const router = useRouter();
	const { projectId, environmentId } = router.query;
	const routeSegment = "profiles";

	const query =
		type === "application"
			? api.scan.allByApplication.useQuery(
					{ applicationId: id },
					{
						enabled: !!id,
						refetchInterval: 1000,
					},
				)
			: api.scan.allByCompose.useQuery(
					{ composeId: id },
					{
						enabled: !!id,
						refetchInterval: 1000,
					},
				);

	const jobs = query.data;
	const isLoading = query.isLoading;

	return (
		<Card className="bg-background border-none">
			<CardHeader className="flex flex-row items-center justify-between flex-wrap gap-2">
				<div className="flex flex-col gap-2">
					<CardTitle className="text-xl">{scanT(t, "scan.jobs.title", "Jobs")}</CardTitle>
					<CardDescription>
						{scanT(t, "scan.jobs.description", "See the scan job queue for this {{type}}", {
							type: formatResourceTypeLabel(t, type),
						})}
					</CardDescription>
				</div>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				{isLoading ? (
					<div className="flex w-full flex-row items-center justify-center gap-3 pt-10 min-h-[25vh]">
						<Loader2 className="size-6 text-muted-foreground animate-spin" />
						<span className="text-base text-muted-foreground">
							{scanT(t, "scan.jobs.loading", "Loading jobs...")}
						</span>
					</div>
				) : jobs?.length === 0 ? (
					<div className="flex w-full flex-col items-center justify-center gap-3 pt-10 min-h-[25vh]">
						<RocketIcon className="size-8 text-muted-foreground" />
						<span className="text-base text-muted-foreground">
							{scanT(t, "scan.jobs.empty", "No jobs found")}
						</span>
					</div>
				) : (
					<div className="flex flex-col gap-4">
						{jobs?.map((job) => (
							<Link
								key={job.scanJobId}
								href={`/dashboard/project/${projectId}/environment/${environmentId}/${routeSegment}/${type}/${id}/jobs/${job.scanJobId}`}
							>
								<div
									className={cn(
										"flex items-center justify-between rounded-lg border p-4 gap-2 group relative cursor-pointer transition-colors",
										job.status === "running"
											? "border-yellow-500/35 bg-yellow-500/5 shadow-[0_0_24px_rgba(234,179,8,0.08)] hover:bg-yellow-500/10"
											: "bg-transparent hover:bg-border",
									)}
								>
									<div className="flex flex-col gap-1">
										<span className="flex items-center gap-2 font-medium text-foreground">
											{formatJobTitle(job)}
										</span>
										{job.description && (
											<span className="text-sm text-muted-foreground break-all">
												{job.description}
											</span>
										)}
										{job.note && (
											<span className="text-sm text-foreground/80 break-all">
												{scanT(t, "scan.jobs.note", "Note: {{note}}", {
													note: job.note,
												})}
											</span>
										)}
										<div className="flex items-center gap-2 text-xs text-muted-foreground">
											<Badge variant="outline">
												{formatScanTypeLabel(t, job.scanType)}
											</Badge>
											<span>{formatTriggerSource(t, job.triggerSource)}</span>
											<span>{formatTokenUsage(t, job.totalTokens)}</span>
										</div>
									</div>
									<div className="flex flex-col items-end gap-2">
										<span className="flex items-center gap-2 text-sm capitalize">
											{job.status === "running" ? (
												<span className="relative flex size-2.5">
													<span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-yellow-400 opacity-75" />
													<span className="relative inline-flex size-2.5 rounded-full bg-yellow-500" />
												</span>
											) : (
												<span
													className={cn(
														"size-2.5 rounded-full",
														statusColorMap[job.status],
													)}
												/>
											)}
											{formatScanJobStatusLabel(t, job.status)}
										</span>
										<DateTooltip date={job.createdAt} />
									</div>
								</div>
							</Link>
						))}
					</div>
				)}
			</CardContent>
		</Card>
	);
};
