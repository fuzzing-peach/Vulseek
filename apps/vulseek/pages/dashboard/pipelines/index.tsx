import type { GetServerSidePropsContext, InferGetServerSidePropsType } from "next";
import Link from "next/link";
import { useRouter } from "next/router";
import * as React from "react";
import { createServerSideHelpers } from "@trpc/react-query/server";
import { Plus, Workflow } from "lucide-react";
import superjson from "superjson";
import { validateRequest } from "@vulseek/server/lib/auth";
import {
	CollectionSection,
	DashboardPage,
	DashboardPageBody,
	DashboardPageHeader,
	ResourceCard,
} from "@/components/dashboard/ui-system";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/utils/api";
import { appRouter } from "@/server/api/root";

const PIPELINE_TABS = [
	{ value: "all", label: "All" },
	{ value: "system", label: "System" },
	{ value: "archived", label: "Archived" },
] as const;

export const getServerSideProps = async (
	context: GetServerSidePropsContext,
) => {
	const { user, session } = await validateRequest(context.req);
	if (!user || !session) {
		return { redirect: { destination: "/login", permanent: false } };
	}
	const helpers = createServerSideHelpers({
		router: appRouter,
		ctx: {
			session,
			user,
			req: context.req,
			res: context.res,
			db: undefined,
		} as never,
		transformer: superjson,
	});
	await helpers.pipeline.list.prefetch();
	return {
		props: {
			trpcState: helpers.dehydrate(),
		},
	};
};

const statusBadge = (
	row: { systemKey: string | null; archivedAt: string | null; hasDraft?: boolean },
) => {
	if (row.archivedAt) {
		return (
			<Badge variant="secondary" className="shrink-0">
				Archived
			</Badge>
		);
	}
	if (row.systemKey) {
		return (
			<Badge variant="outline" className="shrink-0 border-sky-500/40 text-sky-600">
				System
			</Badge>
		);
	}
	if (row.hasDraft) {
		return (
			<Badge variant="outline" className="shrink-0 border-amber-500/40 text-amber-600">
				Draft
			</Badge>
		);
	}
	return null;
};

const PipelinesPage = ({
	trpcState,
}: InferGetServerSidePropsType<typeof getServerSideProps>) => {
	void trpcState;
	const router = useRouter();
	const list = api.pipeline.list.useQuery();
	const [tab, setTab] = React.useState<string>("all");

	const rows = list.data ?? [];
	const filtered = rows.filter((row) => {
		if (tab === "system") return Boolean(row.systemKey);
		if (tab === "archived") return Boolean(row.archivedAt);
		return true;
	});

	return (
		<DashboardLayout>
			<DashboardPage>
				<DashboardPageHeader
					icon={<Workflow />}
					title="Pipelines"
					description="Organization-wide scan pipelines"
					actions={
						<Button onClick={() => void router.push("/dashboard/pipelines/new")}>
							<Plus className="size-4" />
							New pipeline
						</Button>
					}
				/>
				<DashboardPageBody>
					<div className="mb-4 flex items-center gap-1 rounded-lg border bg-muted/30 p-1">
						{PIPELINE_TABS.map((item) => (
							<button
								key={item.value}
								type="button"
								onClick={() => setTab(item.value)}
								className={
									"flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors " +
									(tab === item.value
										? "bg-background shadow-sm"
										: "text-muted-foreground hover:text-foreground")
								}
							>
								{item.label}
							</button>
						))}
					</div>

					<CollectionSection
						title="All pipelines"
						description={
							filtered.length > 0
								? `${filtered.length} pipeline${filtered.length === 1 ? "" : "s"} in this organization`
								: "No pipelines yet"
						}
					>
						{filtered.length === 0 ? (
							<div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
								{rows.length === 0
									? "No pipelines yet — create your first one."
									: "Nothing in this tab."}
							</div>
						) : (
							<div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-5">
								{filtered.map((row) => (
									<ResourceCard
										key={row.pipelineId}
										href={`/dashboard/pipelines/${row.pipelineId}`}
										title={row.name}
										description={row.slug}
										metadata={statusBadge(row)}
										footer={
											<span className="text-xs text-muted-foreground">
												{row.currentVersionNumber
													? `v${row.currentVersionNumber} published`
													: "No published version"}
											</span>
										}
									/>
								))}
							</div>
						)}
					</CollectionSection>

					<p className="mt-6 text-xs text-muted-foreground">
						Pipelines are shared across all projects. Drafts are only visible to
						owners and admins; published versions can be run by every member.{" "}
						<Link
							href="/dashboard/pipelines/new"
							className="text-primary hover:underline"
						>
							Create
						</Link>{" "}
						a pipeline or duplicate an existing one to get started.
					</p>
				</DashboardPageBody>
			</DashboardPage>
		</DashboardLayout>
	);
};

export default PipelinesPage;
