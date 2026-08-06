import { createServerSideHelpers } from "@trpc/react-query/server";
import type { findProjectById } from "@vulseek/server";
import { validateRequest } from "@vulseek/server/lib/auth";
import {
	Ban,
	CheckCircle2,
	CircuitBoard,
	FolderInput,
	GlobeIcon,
	Loader2,
	Play,
	PlusIcon,
	ServerIcon,
	SquareTerminal,
	Trash2,
} from "lucide-react";
import type {
	GetServerSidePropsContext,
	InferGetServerSidePropsType,
} from "next";
import Head from "next/head";
import { useRouter } from "next/router";
import { type ReactElement, useMemo, useState } from "react";
import { toast } from "sonner";
import superjson from "superjson";
import { AddAiAssistant } from "@/components/dashboard/project/add-ai-assistant";
import { AddApplication } from "@/components/dashboard/project/add-application";
import { AddCompose } from "@/components/dashboard/project/add-compose";
import { AddDatabase } from "@/components/dashboard/project/add-database";
import { AddTemplate } from "@/components/dashboard/project/add-template";
import { AdvancedEnvironmentSelector } from "@/components/dashboard/project/advanced-environment-selector";
import { DuplicateProject } from "@/components/dashboard/project/duplicate-project";
import { EnvironmentVariables } from "@/components/dashboard/project/environment-variables";
import { HandleProject } from "@/components/dashboard/projects/handle-project";
import { ProjectEnvironment } from "@/components/dashboard/projects/project-environment";
import {
	MariadbIcon,
	MongodbIcon,
	MysqlIcon,
	PostgresqlIcon,
	RedisIcon,
} from "@/components/icons/data-tools-icons";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { AlertBlock } from "@/components/shared/alert-block";
import { BreadcrumbSidebar } from "@/components/shared/breadcrumb-sidebar";
import { DateTooltip } from "@/components/shared/date-tooltip";
import { DialogAction } from "@/components/shared/dialog-action";
import { StatusTooltip } from "@/components/shared/status-tooltip";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
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
import {
	CollectionView,
	DashboardPage,
	DashboardPageBody,
	DashboardPageHeader,
	ResourceCard,
	useCollectionQuery,
} from "@/components/dashboard/ui-system";
import type {
	ListQueryConfig,
	ListSortDirection,
} from "@/lib/ui-system/list-query";
import { appRouter } from "@/server/api/root";
import { api } from "@/utils/api";

export type Services = {
	appName: string;
	serverId?: string | null;
	name: string;
	type:
		| "mariadb"
		| "application"
		| "postgres"
		| "mysql"
		| "mongo"
		| "redis"
		| "compose";
	description?: string | null;
	id: string;
	createdAt: string;
	status?: "idle" | "running" | "done" | "error";
};

type Project = Awaited<ReturnType<typeof findProjectById>>;
type Environment = Project["environments"][0];

export const extractServicesFromEnvironment = (
	environment: Environment | undefined,
) => {
	if (!environment) return [];

	const allServices: Services[] = [];

	const applications: Services[] =
		environment.applications?.map((item) => ({
			appName: item.appName,
			name: item.name,
			type: "application",
			id: item.applicationId,
			createdAt: item.createdAt,
			status: item.applicationStatus,
			description: item.description,
			serverId: item.serverId,
		})) || [];

	const mariadb: Services[] =
		environment.mariadb?.map((item) => ({
			appName: item.appName,
			name: item.name,
			type: "mariadb",
			id: item.mariadbId,
			createdAt: item.createdAt,
			status: item.applicationStatus,
			description: item.description,
			serverId: item.serverId,
		})) || [];

	const postgres: Services[] =
		environment.postgres?.map((item) => ({
			appName: item.appName,
			name: item.name,
			type: "postgres",
			id: item.postgresId,
			createdAt: item.createdAt,
			status: item.applicationStatus,
			description: item.description,
			serverId: item.serverId,
		})) || [];

	const mongo: Services[] =
		environment.mongo?.map((item) => ({
			appName: item.appName,
			name: item.name,
			type: "mongo",
			id: item.mongoId,
			createdAt: item.createdAt,
			status: item.applicationStatus,
			description: item.description,
			serverId: item.serverId,
		})) || [];

	const redis: Services[] =
		environment.redis?.map((item) => ({
			appName: item.appName,
			name: item.name,
			type: "redis",
			id: item.redisId,
			createdAt: item.createdAt,
			status: item.applicationStatus,
			description: item.description,
			serverId: item.serverId,
		})) || [];

	const mysql: Services[] =
		environment.mysql?.map((item) => ({
			appName: item.appName,
			name: item.name,
			type: "mysql",
			id: item.mysqlId,
			createdAt: item.createdAt,
			status: item.applicationStatus,
			description: item.description,
			serverId: item.serverId,
		})) || [];

	const compose: Services[] =
		environment.compose?.map((item) => ({
			appName: item.appName,
			name: item.name,
			type: "compose",
			id: item.composeId,
			createdAt: item.createdAt,
			status: item.composeStatus,
			description: item.description,
			serverId: item.serverId,
		})) || [];

	allServices.push(
		...applications,
		...mysql,
		...redis,
		...mongo,
		...postgres,
		...mariadb,
		...compose,
	);

	allServices.sort((a, b) => {
		return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
	});

	return allServices;
};

const SERVICES_CONFIG: ListQueryConfig = {
	prefix: "profiles",
	sortOptions: [
		{ value: "name", label: "Name" },
		{ value: "type", label: "Type" },
		{ value: "createdAt", label: "Created" },
	],
	filterKeys: ["type"],
	allowedFilterValues: { type: [] },
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
	"type-asc": { key: "type", direction: "asc" },
	"type-desc": { key: "type", direction: "desc" },
	"createdAt-desc": { key: "createdAt", direction: "desc" },
	"createdAt-asc": { key: "createdAt", direction: "asc" },
};

const SERVICE_TYPE_OPTIONS = [
	{ value: "application", label: "Application" },
	{ value: "postgres", label: "PostgreSQL" },
	{ value: "mariadb", label: "MariaDB" },
	{ value: "mongo", label: "MongoDB" },
	{ value: "mysql", label: "MySQL" },
	{ value: "redis", label: "Redis" },
	{ value: "compose", label: "Compose" },
];

const ServiceTypeIcon = ({ type }: { type: Services["type"] }) => {
	switch (type) {
		case "postgres":
			return <PostgresqlIcon className="h-7 w-7" />;
		case "redis":
			return <RedisIcon className="h-7 w-7" />;
		case "mariadb":
			return <MariadbIcon className="h-7 w-7" />;
		case "mongo":
			return <MongodbIcon className="h-7 w-7" />;
		case "mysql":
			return <MysqlIcon className="h-7 w-7" />;
		case "application":
			return <GlobeIcon className="h-6 w-6" />;
		case "compose":
			return <CircuitBoard className="h-6 w-6" />;
	}
};

const EnvironmentPage = (
	props: InferGetServerSidePropsType<typeof getServerSideProps>,
) => {
	const utils = api.useUtils();
	const [isBulkActionLoading, setIsBulkActionLoading] = useState(false);
	const { projectId, environmentId } = props;
	const { data: auth } = api.user.get.useQuery();

	const {
		data: projectData,
		isLoading,
		refetch,
	} = api.project.one.useQuery({ projectId });
	const { data: currentEnvironment } = api.environment.one.useQuery({
		environmentId,
	});
	const { data: allProjects } = api.project.all.useQuery();
	const router = useRouter();

	const [isMoveDialogOpen, setIsMoveDialogOpen] = useState(false);
	const [selectedTargetProject, setSelectedTargetProject] =
		useState<string>("");
	const [selectedTargetEnvironment, setSelectedTargetEnvironment] =
		useState<string>("");

	const { data: selectedProjectEnvironments } =
		api.environment.byProjectId.useQuery(
			{ projectId: selectedTargetProject },
			{ enabled: !!selectedTargetProject },
		);

	const applications = extractServicesFromEnvironment(currentEnvironment);

	const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	const [isDropdownOpen, setIsDropdownOpen] = useState(false);
	const [isBulkDeleteDialogOpen, setIsBulkDeleteDialogOpen] = useState(false);
	const [deleteVolumes, setDeleteVolumes] = useState(false);

	const { state, setState, searchInput, setSearchInput, deferredQuery } =
		useCollectionQuery(router, SERVICES_CONFIG);

	const profilesList = api.environment.profiles.list.useQuery(
		{
			environmentId,
			page: state.page,
			pageSize: state.pageSize,
			types: state.filters.type as Services["type"][] | undefined,
			sortKey: state.sortKey as "name" | "type" | "createdAt",
			sortDirection: state.sortDirection,
			search: deferredQuery || undefined,
		},
		{ keepPreviousData: true },
	);

	const composeActions = {
		start: api.compose.start.useMutation(),
		stop: api.compose.stop.useMutation(),
		move: api.compose.move.useMutation(),
		delete: api.compose.delete.useMutation(),
		deploy: api.compose.deploy.useMutation(),
	};

	const applicationActions = {
		start: api.application.start.useMutation(),
		stop: api.application.stop.useMutation(),
		move: api.application.move.useMutation(),
		delete: api.application.delete.useMutation(),
		deploy: api.application.deploy.useMutation(),
	};

	const postgresActions = {
		start: api.postgres.start.useMutation(),
		stop: api.postgres.stop.useMutation(),
		move: api.postgres.move.useMutation(),
		delete: api.postgres.remove.useMutation(),
		deploy: api.postgres.deploy.useMutation(),
	};

	const mysqlActions = {
		start: api.mysql.start.useMutation(),
		stop: api.mysql.stop.useMutation(),
		move: api.mysql.move.useMutation(),
		delete: api.mysql.remove.useMutation(),
		deploy: api.mysql.deploy.useMutation(),
	};

	const mariadbActions = {
		start: api.mariadb.start.useMutation(),
		stop: api.mariadb.stop.useMutation(),
		move: api.mariadb.move.useMutation(),
		delete: api.mariadb.remove.useMutation(),
		deploy: api.mariadb.deploy.useMutation(),
	};

	const redisActions = {
		start: api.redis.start.useMutation(),
		stop: api.redis.stop.useMutation(),
		move: api.redis.move.useMutation(),
		delete: api.redis.remove.useMutation(),
		deploy: api.redis.deploy.useMutation(),
	};

	const mongoActions = {
		start: api.mongo.start.useMutation(),
		stop: api.mongo.stop.useMutation(),
		move: api.mongo.move.useMutation(),
		delete: api.mongo.remove.useMutation(),
		deploy: api.mongo.deploy.useMutation(),
	};

	const serviceTypeOf = (serviceId: string) =>
		applications.find((service) => service.id === serviceId)?.type;

	const runBulkAction = async (
		action: (serviceId: string, type: Services["type"]) => Promise<unknown>,
		successMessage: string,
		errorMessage: (serviceId: string, error: unknown) => string,
		onSuccess: () => void = () => {},
	) => {
		let success = 0;
		setIsBulkActionLoading(true);
		for (const serviceId of selectedIds) {
			const type = serviceTypeOf(serviceId);
			if (!type) continue;
			try {
				await action(serviceId, type);
				success++;
			} catch (error) {
				toast.error(errorMessage(serviceId, error));
			}
		}
		if (success > 0) {
			toast.success(successMessage);
			refetch();
		}
		onSuccess();
		setSelectedIds(new Set());
		setIsDropdownOpen(false);
		setIsBulkActionLoading(false);
	};

	const handleBulkStart = () =>
		runBulkAction(
			(serviceId, type) => {
				switch (type) {
					case "application":
						return applicationActions.start.mutateAsync({
							applicationId: serviceId,
						});
					case "compose":
						return composeActions.start.mutateAsync({ composeId: serviceId });
					case "postgres":
						return postgresActions.start.mutateAsync({ postgresId: serviceId });
					case "mysql":
						return mysqlActions.start.mutateAsync({ mysqlId: serviceId });
					case "mariadb":
						return mariadbActions.start.mutateAsync({ mariadbId: serviceId });
					case "redis":
						return redisActions.start.mutateAsync({ redisId: serviceId });
					case "mongo":
						return mongoActions.start.mutateAsync({ mongoId: serviceId });
				}
			},
			`${selectedIds.size} profiles started successfully`,
			(serviceId, error) =>
				`Error starting profile ${serviceId}: ${error instanceof Error ? error.message : "Unknown error"}`,
		);

	const handleBulkStop = () =>
		runBulkAction(
			(serviceId, type) => {
				switch (type) {
					case "application":
						return applicationActions.stop.mutateAsync({
							applicationId: serviceId,
						});
					case "compose":
						return composeActions.stop.mutateAsync({ composeId: serviceId });
					case "postgres":
						return postgresActions.stop.mutateAsync({ postgresId: serviceId });
					case "mysql":
						return mysqlActions.stop.mutateAsync({ mysqlId: serviceId });
					case "mariadb":
						return mariadbActions.stop.mutateAsync({ mariadbId: serviceId });
					case "redis":
						return redisActions.stop.mutateAsync({ redisId: serviceId });
					case "mongo":
						return mongoActions.stop.mutateAsync({ mongoId: serviceId });
				}
			},
			`${selectedIds.size} profiles stopped successfully`,
			(serviceId, error) =>
				`Error stopping profile ${serviceId}: ${error instanceof Error ? error.message : "Unknown error"}`,
		);

	const handleBulkMove = () => {
		if (!selectedTargetProject) {
			toast.error("Please select a target project");
			return;
		}
		if (!selectedTargetEnvironment) {
			toast.error("Please select a target environment");
			return;
		}

		void runBulkAction(
			async (serviceId, type) => {
				switch (type) {
					case "application":
						await applicationActions.move.mutateAsync({
							applicationId: serviceId,
							targetEnvironmentId: selectedTargetEnvironment,
						});
						break;
					case "compose":
						await composeActions.move.mutateAsync({
							composeId: serviceId,
							targetEnvironmentId: selectedTargetEnvironment,
						});
						break;
					case "postgres":
						await postgresActions.move.mutateAsync({
							postgresId: serviceId,
							targetEnvironmentId: selectedTargetEnvironment,
						});
						break;
					case "mysql":
						await mysqlActions.move.mutateAsync({
							mysqlId: serviceId,
							targetEnvironmentId: selectedTargetEnvironment,
						});
						break;
					case "mariadb":
						await mariadbActions.move.mutateAsync({
							mariadbId: serviceId,
							targetEnvironmentId: selectedTargetEnvironment,
						});
						break;
					case "redis":
						await redisActions.move.mutateAsync({
							redisId: serviceId,
							targetEnvironmentId: selectedTargetEnvironment,
						});
						break;
					case "mongo":
						await mongoActions.move.mutateAsync({
							mongoId: serviceId,
							targetEnvironmentId: selectedTargetEnvironment,
						});
						break;
				}
				await utils.environment.one.invalidate({
					environmentId,
				});
			},
			`${selectedIds.size} profiles moved successfully`,
			(serviceId, error) =>
				`Error moving profile ${serviceId}: ${error instanceof Error ? error.message : "Unknown error"}`,
			() => {
				setIsMoveDialogOpen(false);
				setSelectedTargetProject("");
				setSelectedTargetEnvironment("");
			},
		);
	};

	const handleBulkDelete = (deleteVolumesFlag = false) =>
		runBulkAction(
			async (serviceId, type) => {
				switch (type) {
					case "application":
						await applicationActions.delete.mutateAsync({
							applicationId: serviceId,
						});
						break;
					case "compose":
						await composeActions.delete.mutateAsync({
							composeId: serviceId,
							deleteVolumes: deleteVolumesFlag,
						});
						break;
					case "postgres":
						await postgresActions.delete.mutateAsync({
							postgresId: serviceId,
						});
						break;
					case "mysql":
						await mysqlActions.delete.mutateAsync({
							mysqlId: serviceId,
						});
						break;
					case "mariadb":
						await mariadbActions.delete.mutateAsync({
							mariadbId: serviceId,
						});
						break;
					case "redis":
						await redisActions.delete.mutateAsync({
							redisId: serviceId,
						});
						break;
					case "mongo":
						await mongoActions.delete.mutateAsync({
							mongoId: serviceId,
						});
						break;
				}
				await utils.environment.one.invalidate({
					environmentId,
				});
			},
			`${selectedIds.size} profiles deleted successfully`,
			(serviceId, error) =>
				`Error deleting profile ${serviceId}: ${error instanceof Error ? error.message : "Unknown error"}`,
		);

	const handleBulkDeploy = () =>
		runBulkAction(
			(serviceId, type) => {
				switch (type) {
					case "application":
						return applicationActions.deploy.mutateAsync({
							applicationId: serviceId,
						});
					case "compose":
						return composeActions.deploy.mutateAsync({
							composeId: serviceId,
						});
					case "postgres":
						return postgresActions.deploy.mutateAsync({
							postgresId: serviceId,
						});
					case "mysql":
						return mysqlActions.deploy.mutateAsync({
							mysqlId: serviceId,
						});
					case "mariadb":
						return mariadbActions.deploy.mutateAsync({
							mariadbId: serviceId,
						});
					case "redis":
						return redisActions.deploy.mutateAsync({
							redisId: serviceId,
						});
					case "mongo":
						return mongoActions.deploy.mutateAsync({
							mongoId: serviceId,
						});
				}
			},
			`${selectedIds.size} profile${selectedIds.size !== 1 ? "s" : ""} deployed successfully`,
			(serviceId, error) =>
				`Error deploying profile ${serviceId}: ${error instanceof Error ? error.message : "Unknown error"}`,
		);

	const selectedServicesWithRunningStatus = useMemo(
		() =>
			[...selectedIds]
				.map((id) => applications.find((service) => service.id === id))
				.filter(
					(service): service is Services => service?.status === "running",
				),
		[selectedIds, applications],
	);

	if (isLoading) {
		return (
			<div className="flex flex-row gap-2 items-center justify-center text-sm text-muted-foreground min-h-[60vh]">
				<span>Loading...</span>
				<Loader2 className="animate-spin size-4" />
			</div>
		);
	}

	if (!currentEnvironment) {
		return (
			<div className="flex flex-col items-center justify-center min-h-[60vh]">
				<span className="text-lg font-medium text-muted-foreground">
					Environment not found
				</span>
			</div>
		);
	}

	const canCreateProfile =
		auth?.role === "owner" || auth?.canCreateServices === true;

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
			<SelectTrigger className="w-44" aria-label="Sort profiles">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				<SelectItem value="name-asc">Name (A-Z)</SelectItem>
				<SelectItem value="name-desc">Name (Z-A)</SelectItem>
				<SelectItem value="type-asc">Type (A-Z)</SelectItem>
				<SelectItem value="type-desc">Type (Z-A)</SelectItem>
				<SelectItem value="createdAt-desc">Newest first</SelectItem>
				<SelectItem value="createdAt-asc">Oldest first</SelectItem>
			</SelectContent>
		</Select>
	);

	const toggleRow = (id: string) => {
		setSelectedIds((previous) => {
			const next = new Set(previous);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	return (
		<>
			<BreadcrumbSidebar
				list={[
					{ name: "Projects", href: "/dashboard/projects" },
					{
						name: projectData?.name || "",
					},
					{
						name: currentEnvironment.name,
					},
				]}
			/>
			<Head>
				<title>
					Environment: {currentEnvironment.name} | {projectData?.name} | Vulseek
				</title>
			</Head>
			<DashboardPage>
				<DashboardPageHeader
					icon={<FolderInput />}
					title={
						// Project name + env selector must not share a compressed
						// size-7 button slot (that overlapped "wordpress" / "production").
						<span className="flex min-w-0 max-w-full items-center gap-2">
							<span className="min-w-0 shrink truncate">
								{currentEnvironment.project.name}
							</span>
							<span className="flex shrink-0 items-center gap-1">
								<AdvancedEnvironmentSelector
									projectId={projectId}
									currentEnvironmentId={environmentId}
								/>
								<EnvironmentVariables environmentId={environmentId}>
									<Button
										variant="ghost"
										size="icon"
										className="size-7"
										aria-label="Environment variables"
									>
										<SquareTerminal className="size-4 text-muted-foreground" />
									</Button>
								</EnvironmentVariables>
							</span>
						</span>
					}
					description={
						projectData?.description ||
						currentEnvironment.description ||
						"No description provided"
					}
					actions={
						<>
							<HandleProject projectId={projectId} trigger="button" />
							<ProjectEnvironment projectId={projectId}>
								<Button variant="outline">Project Environment</Button>
							</ProjectEnvironment>
							{canCreateProfile && (
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<Button>
											<PlusIcon className="h-4 w-4" />
											Create Profile
										</Button>
									</DropdownMenuTrigger>
									<DropdownMenuContent
										className="w-[200px] space-y-2"
										align="end"
									>
										<DropdownMenuLabel className="text-sm font-normal">
											Actions
										</DropdownMenuLabel>
										<DropdownMenuSeparator />
										<AddApplication
											projectName={projectData?.name}
											environmentId={environmentId}
										/>
										<AddDatabase
											projectName={projectData?.name}
											environmentId={environmentId}
										/>
										<AddCompose
											projectName={projectData?.name}
											environmentId={environmentId}
										/>
										<AddTemplate environmentId={environmentId} />
										<AddAiAssistant
											projectName={projectData?.name}
											environmentId={environmentId}
										/>
									</DropdownMenuContent>
								</DropdownMenu>
							)}
						</>
					}
				/>
				<DashboardPageBody>
					<CollectionView
						state={state}
						onStateChange={setState}
						pageSizes={SERVICES_CONFIG.pageSizes}
						data={{
							items: profilesList.data?.items ?? [],
							total: profilesList.data?.total ?? 0,
						}}
						isLoading={profilesList.isLoading && !profilesList.data}
						isRefreshing={profilesList.isFetching && Boolean(profilesList.data)}
						getRowId={(service) => service.id}
						getRowLabel={(service) => service.name}
						searchValue={searchInput}
						onSearchValueChange={setSearchInput}
						searchPlaceholder="Filter profiles..."
						toolbarChildren={sortSelect}
						filters={[
							{
								key: "type",
								label: "Type",
								options: SERVICE_TYPE_OPTIONS,
							},
						]}
						emptyTitle={
							applications.length === 0
								? "No profiles added yet"
								: "No profiles found with the current filters"
						}
						emptyDescription={
							applications.length === 0
								? "Click on Create Profile to add one."
								: "Try adjusting your search or filters"
						}
						bulkActions={
							<DropdownMenu
								open={isDropdownOpen}
								onOpenChange={setIsDropdownOpen}
							>
								<DropdownMenuTrigger asChild>
									<Button
										variant="outline"
										size="sm"
										isLoading={isBulkActionLoading}
									>
										Bulk Actions
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end">
									<DropdownMenuLabel>Actions</DropdownMenuLabel>
									<DropdownMenuSeparator />
									<DialogAction
										title="Start Profiles"
										description={`Are you sure you want to start ${selectedIds.size} profiles?`}
										type="default"
										onClick={handleBulkStart}
									>
										<Button variant="ghost" className="w-full justify-start">
											<CheckCircle2 className="mr-2 h-4 w-4" />
											Start
										</Button>
									</DialogAction>
									<DialogAction
										title="Deploy Profiles"
										description={`Are you sure you want to deploy ${selectedIds.size} profile${selectedIds.size !== 1 ? "s" : ""}? This will redeploy/restart the selected profiles.`}
										onClick={handleBulkDeploy}
										type="default"
										disabled={isBulkActionLoading}
									>
										<Button variant="ghost" className="w-full justify-start">
											<Play className="mr-2 h-4 w-4" />
											Deploy
										</Button>
									</DialogAction>
									<DialogAction
										title="Stop Profiles"
										description={`Are you sure you want to stop ${selectedIds.size} profiles?`}
										type="destructive"
										onClick={handleBulkStop}
									>
										<Button
											variant="ghost"
											className="w-full justify-start text-destructive"
										>
											<Ban className="mr-2 h-4 w-4" />
											Stop
										</Button>
									</DialogAction>
									{(auth?.role === "owner" || auth?.canDeleteServices) && (
										<>
											<DialogAction
												title="Delete Profiles"
												description={
													<div className="space-y-3">
														<p>
															Are you sure you want to delete {selectedIds.size}{" "}
															profiles? This action cannot be undone.
														</p>
														{selectedServicesWithRunningStatus.length > 0 && (
															<AlertBlock type="warning">
																Warning:{" "}
																{selectedServicesWithRunningStatus.length} of
																the selected profiles are currently running.
																Please stop these profiles first before
																deleting:{" "}
																{selectedServicesWithRunningStatus
																	.map((s) => s.name)
																	.join(", ")}
															</AlertBlock>
														)}
													</div>
												}
												type="destructive"
												disabled={selectedServicesWithRunningStatus.length > 0}
												onClick={() => setIsBulkDeleteDialogOpen(true)}
											>
												<Button
													variant="ghost"
													className="w-full justify-start text-destructive"
												>
													<Trash2 className="mr-2 h-4 w-4" />
													Delete
												</Button>
											</DialogAction>
											<DuplicateProject
												environmentId={environmentId}
												services={applications}
												selectedServiceIds={[...selectedIds]}
											/>
										</>
									)}

									<Dialog
										open={isMoveDialogOpen}
										onOpenChange={setIsMoveDialogOpen}
									>
										<DialogTrigger asChild>
											<Button variant="ghost" className="w-full justify-start">
												<FolderInput className="mr-2 h-4 w-4" />
												Move
											</Button>
										</DialogTrigger>
										<DialogContent>
											<DialogHeader>
												<DialogTitle>Move Profiles</DialogTitle>
												<DialogDescription>
													Select the target project and environment to move{" "}
													{selectedIds.size} profiles
												</DialogDescription>
											</DialogHeader>
											<div className="flex flex-col gap-4">
												{allProjects?.length === 0 ? (
													<div className="flex flex-col items-center justify-center gap-2 py-4">
														<FolderInput className="h-8 w-8 text-muted-foreground" />
														<p className="text-sm text-muted-foreground text-center">
															No other projects available. Create a new project
															first to move profiles.
														</p>
													</div>
												) : (
													<>
														{/* Step 1: Select Project */}
														<div className="flex flex-col gap-2">
															<label
																htmlFor="target-project"
																className="text-sm font-medium"
															>
																Target Project
															</label>
															<Select
																value={selectedTargetProject}
																onValueChange={(value) => {
																	setSelectedTargetProject(value);
																	setSelectedTargetEnvironment(""); // Reset environment when project changes
																}}
															>
																<SelectTrigger>
																	<SelectValue placeholder="Select target project" />
																</SelectTrigger>
																<SelectContent>
																	{allProjects?.map((project) => (
																		<SelectItem
																			key={project.projectId}
																			value={project.projectId}
																		>
																			{project.name}
																		</SelectItem>
																	))}
																</SelectContent>
															</Select>
														</div>

														{/* Step 2: Select Environment (only show if project is selected) */}
														{selectedTargetProject && (
															<div className="flex flex-col gap-2">
																<label
																	htmlFor="target-environment"
																	className="text-sm font-medium"
																>
																	Target Environment
																</label>
																<Select
																	value={selectedTargetEnvironment}
																	onValueChange={setSelectedTargetEnvironment}
																>
																	<SelectTrigger>
																		<SelectValue placeholder="Select target environment" />
																	</SelectTrigger>
																	<SelectContent>
																		{selectedProjectEnvironments
																			?.filter(
																				(env) =>
																					env.environmentId !== environmentId,
																			)
																			.map((env) => (
																				<SelectItem
																					key={env.environmentId}
																					value={env.environmentId}
																				>
																					{env.name}
																				</SelectItem>
																			))}
																	</SelectContent>
																</Select>
															</div>
														)}
													</>
												)}
											</div>
											<DialogFooter>
												<Button
													variant="outline"
													onClick={() => {
														setIsMoveDialogOpen(false);
														setSelectedTargetProject("");
														setSelectedTargetEnvironment("");
													}}
												>
													Cancel
												</Button>
												<Button
													onClick={handleBulkMove}
													isLoading={isBulkActionLoading}
													disabled={
														allProjects?.length === 0 ||
														!selectedTargetProject ||
														!selectedTargetEnvironment
													}
												>
													Move Profiles
												</Button>
											</DialogFooter>
										</DialogContent>
									</Dialog>

									{/* Bulk Delete Dialog */}
									<Dialog
										open={isBulkDeleteDialogOpen}
										onOpenChange={setIsBulkDeleteDialogOpen}
									>
										<DialogContent>
											<DialogHeader>
												<DialogTitle>Delete Profiles</DialogTitle>
												<DialogDescription>
													Are you sure you want to delete {selectedIds.size}{" "}
													profile
													{selectedIds.size !== 1 ? "s" : ""}? This action
													cannot be undone.
												</DialogDescription>
											</DialogHeader>

											<div className="space-y-4">
												{/* Show profiles to be deleted */}
												<div className="max-h-40 overflow-y-auto space-y-2">
													{[...selectedIds].map((serviceId) => {
														const service = applications.find(
															(s) => s.id === serviceId,
														);
														return service ? (
															<div
																key={serviceId}
																className="flex items-center space-x-2 text-sm"
															>
																<span className="px-2 py-1 text-xs bg-secondary rounded">
																	{service.type}
																</span>
																<span>{service.name}</span>
															</div>
														) : null;
													})}
												</div>

												{/* Volume deletion option for compose profiles */}
												{(() => {
													const servicesWithVolumeSupport = [
														...selectedIds,
													].filter((serviceId) => {
														const service = applications.find(
															(s) => s.id === serviceId,
														);
														// Currently only compose profiles support volume deletion
														return service?.type === "compose";
													});

													if (servicesWithVolumeSupport.length === 0)
														return null;

													return (
														<div className="space-y-2">
															<div className="flex items-center space-x-2">
																<Checkbox
																	id="deleteVolumes"
																	checked={deleteVolumes}
																	onCheckedChange={(checked) =>
																		setDeleteVolumes(checked === true)
																	}
																/>
																<label
																	htmlFor="deleteVolumes"
																	className="text-sm font-medium"
																>
																	Delete volumes associated with profiles
																</label>
															</div>
															<p className="text-xs text-muted-foreground">
																Volume deletion is available for:{" "}
																{servicesWithVolumeSupport.length} compose
																profile
																{servicesWithVolumeSupport.length !== 1
																	? "s"
																	: ""}
															</p>
														</div>
													);
												})()}
											</div>

											<DialogFooter>
												<Button
													variant="outline"
													onClick={() => {
														setIsBulkDeleteDialogOpen(false);
														setDeleteVolumes(false); // Reset checkbox
													}}
												>
													Cancel
												</Button>
												<Button
													variant="destructive"
													onClick={() => {
														handleBulkDelete(deleteVolumes);
														setIsBulkDeleteDialogOpen(false);
														setDeleteVolumes(false); // Reset checkbox
													}}
													disabled={isBulkActionLoading}
												>
													Delete Profiles
												</Button>
											</DialogFooter>
										</DialogContent>
									</Dialog>
								</DropdownMenuContent>
							</DropdownMenu>
						}
						selectedIds={selectedIds}
						onToggleRow={toggleRow}
						onTogglePage={(pageIds, allSelected) => {
							setSelectedIds((previous) => {
								const next = new Set(previous);
								if (allSelected) {
									for (const id of pageIds) next.delete(id);
								} else {
									for (const id of pageIds) next.add(id);
								}
								return next;
							});
						}}
						onClearSelection={() => setSelectedIds(new Set())}
						renderCard={(service) => (
							<ResourceCard
								key={service.id}
								href={
									"/dashboard/project/" +
									projectId +
									"/environment/" +
									environmentId +
									"/profiles/" +
									service.type +
									"/" +
									service.id
								}
								title={service.name}
								description={service.description || undefined}
								icon={<ServiceTypeIcon type={service.type} />}
								actions={
									<div className="flex items-center gap-2">
										{service.serverId ? (
											<ServerIcon className="size-4 text-muted-foreground" />
										) : null}
										<StatusTooltip status={service.status} />
									</div>
								}
								footer={
									<div className="flex w-full items-center justify-between gap-4 text-xs leading-5 text-muted-foreground">
										<DateTooltip date={service.createdAt}>Created</DateTooltip>
										{/* h-5 matches text-xs row — size-8 checkbox made profile cards taller */}
										<div className="relative z-20 flex h-5 items-center">
											<Checkbox
												checked={selectedIds.has(service.id)}
												onCheckedChange={() => toggleRow(service.id)}
												aria-label={`Select profile ${service.name}`}
											/>
										</div>
									</div>
								}
							/>
						)}
					/>
				</DashboardPageBody>
			</DashboardPage>
		</>
	);
};

export default EnvironmentPage;
EnvironmentPage.getLayout = (page: ReactElement) => {
	return <DashboardLayout>{page}</DashboardLayout>;
};

export async function getServerSideProps(
	ctx: GetServerSidePropsContext<{ projectId: string; environmentId: string }>,
) {
	const { params } = ctx;

	const { req, res } = ctx;
	const { user, session } = await validateRequest(req);
	if (!user) {
		return {
			redirect: {
				permanent: true,
				destination: "/",
			},
		};
	}

	// Fetch data from external API
	const helpers = createServerSideHelpers({
		router: appRouter,
		ctx: {
			req: req as any,
			res: res as any,
			db: null as any,
			session: session as any,
			user: user as any,
		},
		transformer: superjson,
	});

	// Valid project and environment
	if (
		typeof params?.projectId === "string" &&
		typeof params?.environmentId === "string"
	) {
		try {
			await helpers.project.one.fetch({
				projectId: params.projectId,
			});

			await helpers.environment.one.fetch({
				environmentId: params.environmentId,
			});

			await helpers.environment.byProjectId.fetch({
				projectId: params.projectId,
			});

			return {
				props: {
					trpcState: helpers.dehydrate(),
					projectId: params.projectId,
					environmentId: params.environmentId,
				},
			};
		} catch {
			return {
				redirect: {
					permanent: false,
					destination: "/",
				},
			};
		}
	}

	return {
		redirect: {
			permanent: false,
			destination: "/",
		},
	};
}
