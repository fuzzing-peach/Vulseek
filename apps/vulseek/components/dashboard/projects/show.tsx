import { formatDistanceToNow } from "date-fns";
import {
	AlertTriangle,
	BookIcon,
	ExternalLinkIcon,
	FolderInput,
	MoreHorizontalIcon,
	TrashIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/router";
import { toast } from "sonner";
import {
	CollectionView,
	DashboardPage,
	DashboardPageBody,
	DashboardPageHeader,
	ResourceCard,
	useCollectionQuery,
} from "@/components/dashboard/ui-system";
import { BreadcrumbSidebar } from "@/components/shared/breadcrumb-sidebar";
import { StatusTooltip } from "@/components/shared/status-tooltip";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import type {
	ListQueryConfig,
	ListSortDirection,
} from "@/lib/ui-system/list-query";
import { api, type RouterOutputs } from "@/utils/api";
import { HandleProject } from "./handle-project";
import { ProjectEnvironment } from "./project-environment";

type Project = RouterOutputs["project"]["list"]["items"][number];

const PROJECTS_LIST_CONFIG: ListQueryConfig = {
	prefix: "projects",
	sortOptions: [
		{ value: "name", label: "Name" },
		{ value: "createdAt", label: "Created" },
		{ value: "services", label: "Profiles" },
	],
	filterKeys: [],
	defaultSortKey: "createdAt",
	defaultSortDirection: "desc",
	defaultPageSize: 12,
	pageSizes: [12, 24, 48],
};

const SORT_VALUES: Record<
	string,
	{ key: string; direction: ListSortDirection }
> = {
	"name-asc": { key: "name", direction: "asc" },
	"name-desc": { key: "name", direction: "desc" },
	"createdAt-desc": { key: "createdAt", direction: "desc" },
	"createdAt-asc": { key: "createdAt", direction: "asc" },
	"services-desc": { key: "services", direction: "desc" },
	"services-asc": { key: "services", direction: "asc" },
};

const countServices = (project: Project) =>
	project.environments.reduce(
		(total, env) =>
			total +
			env.applications.length +
			env.compose.length +
			env.mariadb.length +
			env.mongo.length +
			env.mysql.length +
			env.postgres.length +
			env.redis.length,
		0,
	);

const hasServicesWithDomains = (project: Project) =>
	project.environments.some(
		(env) => env.applications.length > 0 || env.compose.length > 0,
	);

const isEmptyServices = (project: Project) =>
	project.environments.every(
		(env) =>
			env.applications.length === 0 &&
			env.compose.length === 0 &&
			env.mariadb.length === 0 &&
			env.mongo.length === 0 &&
			env.mysql.length === 0 &&
			env.postgres.length === 0 &&
			env.redis.length === 0,
	);

export const ShowProjects = () => {
	const router = useRouter();
	const utils = api.useUtils();
	const { data: auth } = api.user.get.useQuery();
	const { mutateAsync } = api.project.remove.useMutation();
	const { state, setState, searchInput, setSearchInput, deferredQuery } =
		useCollectionQuery(router, PROJECTS_LIST_CONFIG);
	const projectList = api.project.list.useQuery(
		{
			page: state.page,
			pageSize: state.pageSize,
			search: deferredQuery || undefined,
			sortKey: state.sortKey as "name" | "createdAt" | "services",
			sortDirection: state.sortDirection,
		},
		{ keepPreviousData: true },
	);

	const canCreate =
		auth?.role === "owner" || auth?.role === "admin" || auth?.canCreateProjects;

	const sortValue = `${state.sortKey}-${state.sortDirection}`;
	const sortSelect = (
		<Select
			value={sortValue}
			onValueChange={(value) => {
				const sort = SORT_VALUES[value];
				if (!sort) return;
				setState((previous) => ({
					...previous,
					sortKey: sort.key,
					sortDirection: sort.direction,
					page: 1,
				}));
			}}
		>
			<SelectTrigger className="w-44">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				<SelectItem value="name-asc">Name (A-Z)</SelectItem>
				<SelectItem value="name-desc">Name (Z-A)</SelectItem>
				<SelectItem value="createdAt-desc">Newest first</SelectItem>
				<SelectItem value="createdAt-asc">Oldest first</SelectItem>
				<SelectItem value="services-desc">Most profiles</SelectItem>
				<SelectItem value="services-asc">Least profiles</SelectItem>
			</SelectContent>
		</Select>
	);

	return (
		<>
			<BreadcrumbSidebar
				list={[{ name: "Projects", href: "/dashboard/projects" }]}
			/>
			<DashboardPage>
				<DashboardPageHeader
					icon={<FolderInput />}
					title="Projects"
					description="Create and manage your projects"
					actions={canCreate ? <HandleProject /> : undefined}
				/>
				<DashboardPageBody>
					<CollectionView
						state={state}
						onStateChange={setState}
						pageSizes={PROJECTS_LIST_CONFIG.pageSizes}
						data={{
							items: projectList.data?.items ?? [],
							total: projectList.data?.total ?? 0,
						}}
						isLoading={projectList.isLoading && !projectList.data}
						isRefreshing={projectList.isFetching && Boolean(projectList.data)}
						getRowId={(project) => project.projectId}
						getRowLabel={(project) => project.name}
						searchValue={searchInput}
						onSearchValueChange={setSearchInput}
						toolbarChildren={sortSelect}
						searchPlaceholder="Filter projects..."
						emptyTitle="No projects found"
						emptyDescription="Create your first project to get started."
						renderCard={(project) => (
							<ProjectCard
								key={project.projectId}
								project={project}
								auth={auth}
								onDelete={async () => {
									await mutateAsync({ projectId: project.projectId })
										.then(() => toast.success("Project deleted successfully"))
										.catch(() => toast.error("Error deleting this project"))
										.finally(() => {
											utils.project.all.invalidate();
											utils.project.list.invalidate();
										});
								}}
							/>
						)}
					/>
				</DashboardPageBody>
			</DashboardPage>
		</>
	);
};

type ProjectCardProps = {
	project: Project;
	auth: { role?: string; canDeleteProjects?: boolean } | undefined;
	onDelete: () => Promise<void>;
};

const ProjectCard = ({ project, auth, onDelete }: ProjectCardProps) => {
	const totalServices = countServices(project);
	const firstEnvironmentId = project.environments[0]?.environmentId;
	const projectHref = firstEnvironmentId
		? `/dashboard/project/${project.projectId}/environment/${firstEnvironmentId}`
		: `/dashboard/project/${project.projectId}`;

	const canDelete = auth?.role === "owner" || auth?.canDeleteProjects === true;

	const createdLabel = project.createdAt
		? `Created ${formatDistanceToNow(new Date(project.createdAt), { addSuffix: true })}`
		: null;

	return (
		<ResourceCard
			href={projectHref}
			title={project.name}
			icon={<BookIcon />}
			actions={
				<ProjectActionsMenu
					project={project}
					canDelete={canDelete}
					onDelete={onDelete}
				/>
			}
			footer={
				<div className="flex w-full items-center justify-between gap-4 text-xs leading-4 text-muted-foreground">
					<span className="min-w-0 truncate">{createdLabel}</span>
					<span className="shrink-0 tabular-nums text-foreground/80">
						{totalServices} {totalServices === 1 ? "profile" : "profiles"}
					</span>
				</div>
			}
		/>
	);
};

const ProjectActionsMenu = ({
	project,
	canDelete,
	onDelete,
}: {
	project: ProjectCardProps["project"];
	canDelete: boolean;
	onDelete: () => Promise<void>;
}) => {
	const emptyServices = isEmptyServices(project);
	const showDomains = hasServicesWithDomains(project);

	// Single top-right control (dokploy-style …), domains live under the menu.
	return (
		<div className="flex shrink-0 items-center">
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						variant="ghost"
						size="icon"
						className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
						aria-label="Project actions"
					>
						<MoreHorizontalIcon className="size-4" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent
					align="end"
					className="max-h-[360px] w-[220px] space-y-1 overflow-y-auto"
				>
					<DropdownMenuLabel className="font-normal">Actions</DropdownMenuLabel>
					<ProjectEnvironment projectId={project.projectId} />
					<HandleProject projectId={project.projectId} />
					{showDomains && (
						<>
							<DropdownMenuSeparator />
							{project.environments.some(
								(env) => env.applications.length > 0,
							) && (
								<DropdownMenuGroup>
									<DropdownMenuLabel>Applications</DropdownMenuLabel>
									{project.environments.map((env) =>
										env.applications.map((app) => (
											<div key={app.applicationId}>
												<DropdownMenuLabel className="flex items-center justify-between text-xs font-normal capitalize text-muted-foreground">
													{app.name}
													<StatusTooltip status={app.applicationStatus} />
												</DropdownMenuLabel>
												{app.domains.map((domain) => (
													<DropdownMenuItem key={domain.domainId} asChild>
														<Link
															className="cursor-pointer justify-between space-x-3 text-xs"
															target="_blank"
															href={`${domain.https ? "https" : "http"}://${domain.host}${domain.path}`}
														>
															<span className="truncate">{domain.host}</span>
															<ExternalLinkIcon className="size-3.5 shrink-0" />
														</Link>
													</DropdownMenuItem>
												))}
											</div>
										)),
									)}
								</DropdownMenuGroup>
							)}
							{project.environments.some((env) => env.compose.length > 0) && (
								<DropdownMenuGroup>
									<DropdownMenuLabel>Compose</DropdownMenuLabel>
									{project.environments.map((env) =>
										env.compose.map((comp) => (
											<div key={comp.composeId}>
												<DropdownMenuLabel className="flex items-center justify-between text-xs font-normal capitalize text-muted-foreground">
													{comp.name}
													<StatusTooltip status={comp.composeStatus} />
												</DropdownMenuLabel>
												{comp.domains.map((domain) => (
													<DropdownMenuItem key={domain.domainId} asChild>
														<Link
															className="cursor-pointer justify-between space-x-3 text-xs"
															target="_blank"
															href={`${domain.https ? "https" : "http"}://${domain.host}${domain.path}`}
														>
															<span className="truncate">{domain.host}</span>
															<ExternalLinkIcon className="size-3.5 shrink-0" />
														</Link>
													</DropdownMenuItem>
												))}
											</div>
										)),
									)}
								</DropdownMenuGroup>
							)}
						</>
					)}
					{canDelete && (
						<>
							<DropdownMenuSeparator />
							<AlertDialog>
								<AlertDialogTrigger className="w-full">
									<DropdownMenuItem
										className="w-full cursor-pointer space-x-3 text-destructive focus:text-destructive"
										onSelect={(e) => e.preventDefault()}
									>
										<TrashIcon className="size-4" />
										<span>Delete</span>
									</DropdownMenuItem>
								</AlertDialogTrigger>
								<AlertDialogContent>
									<AlertDialogHeader>
										<AlertDialogTitle>
											Are you sure to delete this project?
										</AlertDialogTitle>
										{!emptyServices ? (
											<div className="flex flex-row gap-4 rounded-lg bg-yellow-50 p-2 dark:bg-yellow-950">
												<AlertTriangle className="text-yellow-600 dark:text-yellow-400" />
												<span className="text-sm text-yellow-600 dark:text-yellow-400">
													You have active profiles, please delete them first
												</span>
											</div>
										) : (
											<AlertDialogDescription>
												This action cannot be undone
											</AlertDialogDescription>
										)}
									</AlertDialogHeader>
									<AlertDialogFooter>
										<AlertDialogCancel>Cancel</AlertDialogCancel>
										<AlertDialogAction
											disabled={!emptyServices}
											onClick={onDelete}
										>
											Delete
										</AlertDialogAction>
									</AlertDialogFooter>
								</AlertDialogContent>
							</AlertDialog>
						</>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
};
