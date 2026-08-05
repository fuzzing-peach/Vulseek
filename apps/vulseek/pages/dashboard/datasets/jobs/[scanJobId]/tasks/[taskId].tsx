import { ArrowLeft, ChevronLeft, FileText, Folder, Loader2, Radio } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/router";
import { useState, type ReactElement } from "react";
import { TaskSessionStream } from "@/components/dashboard/scanning/task-session-stream";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { BreadcrumbSidebar } from "@/components/shared/breadcrumb-sidebar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/utils/api";

const DatasetTaskPage = () => {
	const router = useRouter();
	const scanJobId = typeof router.query.scanJobId === "string" ? router.query.scanJobId : "";
	const taskId = typeof router.query.taskId === "string" ? router.query.taskId : "";
	const [tab, setTab] = useState<"details" | "files" | "session">("details");
	const [directoryPath, setDirectoryPath] = useState("");
	const [selectedFile, setSelectedFile] = useState<string | null>(null);
	const task = api.scan.task.useQuery({ taskId, scanJobId }, { enabled: Boolean(taskId && scanJobId), refetchInterval: (data) => data && ["pending", "launching", "launched", "starting", "running"].includes(data.task.status) ? 2000 : false });
	const files = api.scan.listTaskDirectory.useQuery({ taskId, scanJobId, directoryPath: directoryPath || undefined }, { enabled: Boolean(taskId && scanJobId && tab === "files") });
	const file = api.scan.readTaskFile.useQuery({ taskId, scanJobId, filePath: selectedFile ?? "" }, { enabled: Boolean(selectedFile && tab === "files") });
	const parentDirectory = directoryPath.includes("/") ? directoryPath.slice(0, directoryPath.lastIndexOf("/")) : "";
	const openDirectory = (path: string) => {
		setDirectoryPath(path);
		setSelectedFile(null);
	};

	if (task.isLoading) return <div className="flex min-h-96 items-center justify-center"><Loader2 className="animate-spin" /></div>;
	if (!task.data) return <div className="p-8 text-center">Task not found.</div>;
	const current = task.data.task;
	return <><BreadcrumbSidebar list={[{ name: "Datasets", href: "/dashboard/datasets" }, { name: "Scan Job", href: `/dashboard/datasets/jobs/${encodeURIComponent(scanJobId)}` }, { name: current.name }]} /><div className="w-full space-y-5"><Button variant="ghost" size="sm" asChild><Link href={`/dashboard/datasets/jobs/${encodeURIComponent(scanJobId)}`}><ArrowLeft className="size-4" />Scan Job</Link></Button><Card><CardHeader><CardTitle>{current.name}</CardTitle><CardDescription>{current.stageName} · {current.status} · {taskId}</CardDescription></CardHeader><CardContent><div className="flex gap-2 border-b pb-3"><Button variant={tab === "details" ? "default" : "ghost"} size="sm" onClick={() => setTab("details")}>Details</Button><Button variant={tab === "files" ? "default" : "ghost"} size="sm" onClick={() => setTab("files")}><FileText className="size-4" />Files</Button><Button variant={tab === "session" ? "default" : "ghost"} size="sm" onClick={() => setTab("session")}><Radio className="size-4" />Session</Button></div>{tab === "details" && <div className="mt-4 grid gap-4"><div className="grid gap-3 sm:grid-cols-3"><div><div className="text-xs text-muted-foreground">Status</div><div className="capitalize">{current.status}</div></div><div><div className="text-xs text-muted-foreground">Input tokens</div><div>{Number(current.inputTokens ?? 0).toLocaleString()}</div></div><div><div className="text-xs text-muted-foreground">Output tokens</div><div>{Number(current.outputTokens ?? 0).toLocaleString()}</div></div></div><pre className="max-h-[32rem] overflow-auto rounded-md bg-muted p-4 text-xs">{JSON.stringify({ input: current.input, output: current.output, errorMessage: current.errorMessage }, null, 2)}</pre></div>}{tab === "files" && <div className="mt-4 grid gap-4 md:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]"><div className="space-y-1">{directoryPath && <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground"><Folder className="size-4" />{directoryPath}</div>}{files.data?.map((entry) => entry.type === "file" ? <button type="button" key={entry.id} className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted" onClick={() => setSelectedFile(entry.id)}><FileText className="size-4" />{entry.name}</button> : <button type="button" key={entry.id} className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted" onClick={() => openDirectory(entry.id)}><Folder className="size-4" />{entry.name}/</button>)}{files.data?.length === 0 && <p className="text-sm text-muted-foreground">No visible files.</p>}<Button type="button" variant="ghost" size="sm" disabled={!directoryPath} onClick={() => openDirectory(parentDirectory)}><ChevronLeft className="size-4" />Parent directory</Button></div><pre className="max-h-[32rem] overflow-auto rounded-md bg-muted p-4 text-xs">{file.data?.content ?? (selectedFile ? "Loading..." : "Select a file")}</pre></div>}{tab === "session" && <div className="mt-4"><TaskSessionStream taskId={taskId} /></div>}</CardContent></Card></div></>;
};

DatasetTaskPage.getLayout = (page: ReactElement) => <DashboardLayout>{page}</DashboardLayout>;
export default DatasetTaskPage;
