import { ArrowLeft, ExternalLink, Loader2, Pause, Play, Square } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/router";
import type { ReactElement } from "react";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { BreadcrumbSidebar } from "@/components/shared/breadcrumb-sidebar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/utils/api";

const numberFormat = new Intl.NumberFormat();
const moneyFormat = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 4 });

const EvaluationDetailPage = () => {
	const router = useRouter();
	const evaluationId = typeof router.query.evaluationId === "string" ? router.query.evaluationId : "";
	const query = api.dataset.evaluations.one.useQuery(
		{ evaluationId },
		{
			enabled: Boolean(evaluationId),
			refetchInterval: (data) => data && ["running", "pending", "paused"].includes(data.status) ? 3000 : false,
		},
	);
	const pause = api.dataset.pause.useMutation();
	const start = api.dataset.start.useMutation();
	const cancel = api.dataset.cancel.useMutation();
	const refresh = async (action: () => Promise<unknown>) => { try { await action(); await query.refetch(); } catch {} };
	if (query.isLoading) return <div className="flex min-h-96 items-center justify-center"><Loader2 className="animate-spin" /></div>;
	if (!query.data) return <div className="p-8 text-center">Evaluation not found.</div>;
	const active = ["running", "pending", "paused"].includes(query.data.status);
	const totals = query.data.totals;
	return (
		<>
			<BreadcrumbSidebar list={[{ name: "Datasets", href: "/dashboard/datasets" }, { name: query.data.datasetName }, { name: query.data.name }]} />
			<div className="w-full space-y-5">
				<Button variant="ghost" size="sm" asChild><Link href={`/dashboard/datasets/${query.data.datasetId}`}><ArrowLeft className="size-4" />Dataset</Link></Button>
				<Card><CardHeader><div className="flex items-start justify-between gap-4"><div><CardTitle>{query.data.name}</CardTitle><CardDescription>{query.data.pipelineId} · {query.data.status} · {query.data.profileKey} · {query.data.trials.length} trials</CardDescription></div><div className="flex gap-2">{query.data.status === "running" && <Button variant="outline" size="sm" onClick={() => refresh(() => pause.mutateAsync({ evaluationId }))}><Pause className="size-4" />Pause</Button>}{query.data.status === "paused" && <Button variant="outline" size="sm" onClick={() => refresh(() => start.mutateAsync({ evaluationId }))}><Play className="size-4" />Resume</Button>}{active && <Button variant="destructive" size="sm" onClick={() => refresh(() => cancel.mutateAsync({ evaluationId }))}><Square className="size-4" />Cancel</Button>}</div></div></CardHeader><CardContent className="grid gap-3 sm:grid-cols-3"><div className="rounded-lg border p-4"><div className="text-xs text-muted-foreground">Total tokens</div><div className="mt-1 text-xl font-semibold">{numberFormat.format(totals.totalTokens)}</div></div><div className="rounded-lg border p-4"><div className="text-xs text-muted-foreground">Total duration</div><div className="mt-1 text-xl font-semibold">{Math.round(totals.durationMs / 1000).toLocaleString()}s</div></div><div className="rounded-lg border p-4"><div className="text-xs text-muted-foreground">Estimated cost</div><div className="mt-1 text-xl font-semibold">{moneyFormat.format(totals.estimatedCost)}</div></div></CardContent></Card>
				<Card><CardHeader><CardTitle>Trials</CardTitle><CardDescription>Samples run in round-robin order. Each scan job retains its normal task, file, and session artifacts.</CardDescription></CardHeader><CardContent><div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b text-left"><th className="p-3">Sample</th><th className="p-3">Repetition</th><th className="p-3">Status</th><th className="p-3">Duration</th><th className="p-3">Tokens</th><th className="p-3">Cost</th><th className="p-3">Scan Job</th></tr></thead><tbody>{query.data.trials.map((trial) => <tr key={trial.trialId} className="border-b align-top"><td className="p-3"><div className="font-medium">{trial.sample?.title || trial.sample?.sampleKey || trial.sampleId}</div><div className="font-mono text-xs text-muted-foreground">{trial.sample?.sampleKey || trial.sampleId}</div></td><td className="p-3">{trial.repetition}</td><td className="p-3 capitalize">{trial.status}</td><td className="p-3">{trial.durationMs ? `${Math.round(trial.durationMs / 1000)}s` : "-"}</td><td className="p-3">{numberFormat.format(trial.totalTokens)}</td><td className="p-3">{moneyFormat.format(trial.estimatedCost)}</td><td className="p-3">{trial.scanJobId ? <Link className="inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline" href={`/dashboard/datasets/jobs/${encodeURIComponent(trial.scanJobId)}`}>{trial.scanJobId.slice(0, 12)}<ExternalLink className="size-3" /></Link> : "-"}{trial.errorMessage && <div className="mt-1 max-w-xs text-xs text-destructive">{trial.errorMessage}</div>}</td></tr>)}</tbody></table></div></CardContent></Card>				{query.data.errorMessage && <Card><CardHeader><CardTitle className="text-destructive">Error</CardTitle></CardHeader><CardContent className="text-sm text-destructive">{query.data.errorMessage}</CardContent></Card>}
			</div>
		</>
	);
};

EvaluationDetailPage.getLayout = (page: ReactElement) => <DashboardLayout>{page}</DashboardLayout>;
export default EvaluationDetailPage;
