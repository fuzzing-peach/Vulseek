import { Loader2, RocketIcon } from "lucide-react";
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

interface Props {
	id: string;
	type: "application" | "compose";
}

const statusColorMap = {
	queued: "bg-muted-foreground",
	scanning: "bg-yellow-500",
	analyzing: "bg-sky-500",
	completed: "bg-green-500",
	failed: "bg-destructive",
} as const;

const formatJobTitle = (job: {
	scanJobId: string;
}) => `Scan Job (${job.scanJobId.slice(0, 6)})`;

export const ShowScanJobs = ({ id, type }: Props) => {
	const router = useRouter();
	const { projectId, environmentId } = router.query;
	const routeSegment = router.asPath.includes("/services/")
		? "services"
		: "profiles";

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
					<CardTitle className="text-xl">Jobs</CardTitle>
					<CardDescription>See the scan job queue for this {type}</CardDescription>
				</div>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				{isLoading ? (
					<div className="flex w-full flex-row items-center justify-center gap-3 pt-10 min-h-[25vh]">
						<Loader2 className="size-6 text-muted-foreground animate-spin" />
						<span className="text-base text-muted-foreground">Loading jobs...</span>
					</div>
				) : jobs?.length === 0 ? (
					<div className="flex w-full flex-col items-center justify-center gap-3 pt-10 min-h-[25vh]">
						<RocketIcon className="size-8 text-muted-foreground" />
						<span className="text-base text-muted-foreground">No jobs found</span>
					</div>
				) : (
					<div className="flex flex-col gap-4">
						{jobs?.map((job) => (
							<Link
								key={job.scanJobId}
								href={`/dashboard/project/${projectId}/environment/${environmentId}/${routeSegment}/${type}/${id}/jobs/${job.scanJobId}`}
							>
								<div className="flex items-center justify-between rounded-lg border p-4 gap-2 group relative cursor-pointer bg-transparent transition-colors hover:bg-border">
									<div className="flex flex-col gap-1">
										<span className="flex items-center gap-2 font-medium text-foreground">
											{formatJobTitle(job)}
										</span>
										{job.description && (
											<span className="text-sm text-muted-foreground break-all">
												{job.description}
											</span>
										)}
										<div className="flex items-center gap-2 text-xs text-muted-foreground">
											<Badge variant="outline">
												{job.scanType === "delta" ? "Delta Scan" : "Full Scan"}
											</Badge>
											<span>k={job.commitWindow}</span>
											<span>{job.triggerSource}</span>
										</div>
									</div>
									<div className="flex flex-col items-end gap-2">
										<span className="flex items-center gap-2 text-sm capitalize">
											<span
												className={cn(
													"size-2.5 rounded-full",
													statusColorMap[job.status],
												)}
											/>
											{job.status}
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
