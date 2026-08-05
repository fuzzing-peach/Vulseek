import { ArrowRight, Database, Loader2 } from "lucide-react";
import Link from "next/link";
import type { ReactElement } from "react";
import { BreadcrumbSidebar } from "@/components/shared/breadcrumb-sidebar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { api } from "@/utils/api";
import { CreateDatasetDialog } from "@/components/dashboard/datasets/create-dataset-dialog";

const DatasetsPage = () => {
	const query = api.dataset.all.useQuery();
	const { data: auth } = api.user.get.useQuery();
	return (
		<>
			<BreadcrumbSidebar list={[{ name: "Datasets", href: "/dashboard/datasets" }]} />
			<div className="w-full">
				<Card className="h-full bg-sidebar p-2.5 rounded-xl">
					<div className="rounded-xl bg-background shadow-md">
						<div className="flex items-center justify-between gap-4 p-6">
							<div>
								<CardTitle className="flex items-center gap-2"><Database className="size-5 text-muted-foreground" />Datasets</CardTitle>
								<CardDescription>Evaluate scan pipelines against reproducible sample collections.</CardDescription>
							</div>
							{(auth?.role === "owner" || auth?.role === "admin") && <CreateDatasetDialog />}
						</div>
						<CardContent className="grid gap-4 border-t p-6 sm:grid-cols-2 xl:grid-cols-3">
							{query.isLoading && <div className="col-span-full flex min-h-48 items-center justify-center"><Loader2 className="size-5 animate-spin" /></div>}
							{!query.isLoading && query.data?.length === 0 && <div className="col-span-full py-20 text-center text-muted-foreground">No datasets yet.</div>}
							{query.data?.map((dataset) => (
								<Link key={dataset.datasetId} href={`/dashboard/datasets/${dataset.datasetId}`} className="group rounded-lg border bg-card p-5 transition-colors hover:border-primary">
									<div className="flex items-start justify-between gap-3"><div><h2 className="font-semibold">{dataset.name}</h2><p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{dataset.description || "No description"}</p></div><ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-1" /></div>
									<div className="mt-5 flex gap-4 text-xs text-muted-foreground"><span>{dataset.sampleCount} samples</span><span>{dataset.evaluationCount} evaluations</span></div>
								</Link>
							))}
						</CardContent>
					</div>
				</Card>
			</div>
		</>
	);
};

DatasetsPage.getLayout = (page: ReactElement) => <DashboardLayout>{page}</DashboardLayout>;
export default DatasetsPage;
