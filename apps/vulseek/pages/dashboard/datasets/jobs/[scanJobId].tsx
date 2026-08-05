import { ArrowLeft, Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/router";
import type { ReactElement } from "react";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { BreadcrumbSidebar } from "@/components/shared/breadcrumb-sidebar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/utils/api";

const DatasetScanJobPage = () => {
	const router = useRouter();
	const scanJobId = typeof router.query.scanJobId === "string" ? router.query.scanJobId : "";
	const job = api.scan.one.useQuery({ scanJobId }, { enabled: Boolean(scanJobId), refetchInterval: (data) => data && ["pending", "running", "paused", "finalizing"].includes(data.status) ? 3000 : false });
	const tasks = api.scan.terminalTasks.useQuery({ scanJobId, page: 1, pageSize: 100, query: "", stage: "all", status: "all" }, { enabled: Boolean(scanJobId) });
	const running = api.scan.jobRunningTasks.useQuery({ scanJobId }, { enabled: Boolean(scanJobId), refetchInterval: 3000 });
	if (job.isLoading) return <div className="flex min-h-96 items-center justify-center"><Loader2 className="animate-spin" /></div>;
	if (!job.data) return <div className="p-8 text-center">Scan job not found.</div>;
	const runningTasks = running.data?.tasks ?? [];
	return <><BreadcrumbSidebar list={[{ name: "Datasets", href: "/dashboard/datasets" }, { name: "Scan Job" }, { name: scanJobId.slice(0, 12) }]} /><div className="w-full space-y-5"><Button variant="ghost" size="sm" asChild><Link href="/dashboard/datasets"><ArrowLeft className="size-4" />Datasets</Link></Button><Card><CardHeader><CardTitle>{job.data.title}</CardTitle><CardDescription>{job.data.scanType} · {job.data.status} · {scanJobId}</CardDescription></CardHeader><CardContent><div className="grid gap-3 sm:grid-cols-3"><div className="rounded border p-3"><div className="text-xs text-muted-foreground">Running tasks</div><div className="text-xl font-semibold">{runningTasks.length}</div></div><div className="rounded border p-3"><div className="text-xs text-muted-foreground">Finished tasks</div><div className="text-xl font-semibold">{tasks.data?.total ?? 0}</div></div><div className="rounded border p-3"><div className="text-xs text-muted-foreground">Tokens</div><div className="text-xl font-semibold">{Number(job.data.totalTokens ?? 0).toLocaleString()}</div></div></div></CardContent></Card>{runningTasks.length > 0 && <Card><CardHeader><CardTitle>Running Tasks</CardTitle><CardDescription>Tasks currently executing in this dataset sample.</CardDescription></CardHeader><CardContent><div className="space-y-2">{runningTasks.map((task) => <Link key={task.taskId} href={`/dashboard/datasets/jobs/${encodeURIComponent(scanJobId)}/tasks/${encodeURIComponent(task.taskId)}`} className="flex items-center justify-between rounded-md border p-3 text-sm hover:border-primary"><span className="min-w-0 truncate"><span className="font-medium">{task.title}</span><span className="ml-2 text-xs text-muted-foreground">{task.subtitle}</span></span><span className="ml-3 shrink-0 text-xs text-emerald-600">Running</span></Link>)}</div></CardContent></Card>}<Card><CardHeader><CardTitle>Tasks</CardTitle><CardDescription>Open a task to inspect its details, Files, and Session stream.</CardDescription></CardHeader><CardContent><div className="space-y-2">{tasks.data?.items.map((task) => <Link key={task.taskId} href={`/dashboard/datasets/jobs/${encodeURIComponent(scanJobId)}/tasks/${encodeURIComponent(task.taskId)}`} className="flex items-center justify-between rounded-md border p-3 text-sm hover:border-primary"><span className="min-w-0 truncate"><span className="font-medium">{task.title}</span><span className="ml-2 text-xs text-muted-foreground">{task.stage}</span></span><span className="ml-3 shrink-0 text-xs capitalize text-muted-foreground">{task.status}</span></Link>)}{tasks.data?.items.length === 0 && <p className="text-sm text-muted-foreground">No terminal tasks yet.</p>}</div></CardContent></Card></div></>;
};

DatasetScanJobPage.getLayout = (page: ReactElement) => <DashboardLayout>{page}</DashboardLayout>;
export default DatasetScanJobPage;
