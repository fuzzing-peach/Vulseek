import Head from "next/head";
import { useTranslation } from "next-i18next";
import { ResearchRegistryPanels } from "@/components/dashboard/scanning/research-registry-panels";
import { ScanJobCandidatesTab } from "@/components/dashboard/scanning/scan-job-candidates-tab";
import { ScanJobEvaluateTab } from "@/components/dashboard/scanning/scan-job-evaluate-tab";
import { ScanJobFilesTab } from "@/components/dashboard/scanning/scan-job-files-tab";
import { ScanJobOverviewTab } from "@/components/dashboard/scanning/scan-job-overview-tab";
import { ScanJobTasksTab } from "@/components/dashboard/scanning/scan-job-tasks-tab";
import { ScanMonitoring } from "@/components/dashboard/scanning/scan-monitoring";
import {
	TobGoalCandidatesPanel,
	TobGoalFindingsPanel,
} from "@/components/dashboard/scanning/tob-goal-registry-panels";
import {
	DashboardPage,
	DashboardPageBody,
	DashboardPageHeader,
	DashboardPageTabContent,
	DashboardPageTabs,
} from "@/components/dashboard/ui-system";
import { BreadcrumbSidebar } from "@/components/shared/breadcrumb-sidebar";
import { CopyValueButton } from "@/components/shared/copy-value-button";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { isTerminalScanJobStatus, scanT } from "./scan-i18n";
import {
	type Props,
	ScanJobDetailProvider,
	useScanJobDetail,
} from "./scan-job-detail-context";

/**
 * Shared scan job detail shell (Phase 4). All query/URL controller state
 * lives in ScanJobDetailProvider; this component only composes the header,
 * tabs and per-tab components from context values.
 */
const ScanJobDetailShell = () => {
	const { t } = useTranslation("scan");
	const {
		projectId,
		environmentId,
		serviceId,
		scanJobId,
		serviceType,
		routeSegment,
		navigation,
		serviceData,
		activeTab,
		handleTabChange,
		researchRegistryTabs,
		isLoadingJob,
		scanJob,
		queuePendingCounts,
		resultSummary,
		isLoadingResultSummary,
		refreshScanJobViews,
		canEvaluateScanJob,
		latestEvaluation,
		isLoadingLatestEvaluation,
		candidates,
		isLoadingCandidates,
		isFetchingCandidates,
		candidatePagination,
		candidateQuery,
		onSearchChange,
		analysisFilters,
		onAnalysisFilterToggle,
		onClearAnalysisFilters,
		verifyFilters,
		onVerifyFilterToggle,
		onClearVerifyFilters,
		triageFilters,
		onTriageFilterToggle,
		onClearTriageFilters,
		onToggleCandidateSort,
		candidatePageSize,
		onPageSizeChange,
		onPageChange,
		buildCandidateDetailHref,
		onCandidateLinkClick,
		reanalyzingCandidateId,
		onReanalyzeCandidate,
		runningTasksData,
		runningTasksError,
		queueCountsData,
		queueCountsError,
		jobPipeline,
		buildTaskDetailHref,
		directoryCache,
		rootDirectoryLoading,
		expandedDirectories,
		selectedFilePath,
		onToggleDirectory,
		onSelectFile,
		selectedFile,
		isLoadingSelectedFile,
	} = useScanJobDetail();

	return (
		<div className="pb-10">
			<BreadcrumbSidebar
				list={
					navigation
						? [
								...navigation.breadcrumbs.map((item) => ({
									name: item.label,
									href: item.href,
								})),
								{
									name: scanT(t, "scan.job.shortTitle", "Job {{id}}", {
										id: scanJobId.slice(0, 6),
									}),
								},
							]
						: [
								{
									name: scanT(t, "scan.breadcrumb.projects", "Projects"),
									href: "/dashboard/projects",
								},
								{ name: serviceData?.environment.project.name || "" },
								{
									name: serviceData?.environment.name || "",
									href: `/dashboard/project/${projectId}/environment/${environmentId}`,
								},
								{
									name: serviceData?.name || "",
									href: `/dashboard/project/${projectId}/environment/${environmentId}/${routeSegment}/${serviceType}/${serviceId}?tab=deployments`,
								},
								{
									name: scanT(t, "scan.jobs.title", "Jobs"),
									href: `/dashboard/project/${projectId}/environment/${environmentId}/${routeSegment}/${serviceType}/${serviceId}?tab=deployments`,
								},
								{
									name: scanT(t, "scan.job.shortTitle", "Job {{id}}", {
										id: scanJobId.slice(0, 6),
									}),
								},
							]
				}
			/>
			<Head>
				<title>
					{scanT(t, "scan.job.title", "Scan Job {{id}}", {
						id: scanJobId.slice(0, 6),
					})}{" "}
					| Vulseek
				</title>
			</Head>

			<DashboardPage>
				<DashboardPageHeader
					title={scanT(t, "scan.job.title", "Scan Job {{id}}", {
						id: scanJobId.slice(0, 6),
					})}
					description={
						<div className="flex min-w-0 items-center gap-2 break-all">
							<span>{scanJobId}</span>
							<CopyValueButton
								value={scanJobId}
								label={scanT(t, "scan.field.jobId", "Job ID")}
								className="size-7 shrink-0"
							/>
						</div>
					}
				/>
				<DashboardPageTabs
					fallback="overview"
					tabs={[
						{
							value: "overview",
							label: scanT(t, "scan.job.tabs.overview", "Overview"),
						},
						{
							value: "tasks",
							label: scanT(t, "scan.job.tabs.tasks", "阶段任务"),
						},
						...(scanJob?.scanType !== "research" &&
						scanJob?.scanType !== "tob-goal"
							? [
									{
										value: "candidates",
										label: scanT(t, "scan.job.tabs.candidates", "Candidates"),
									},
								]
							: []),
						...(scanJob?.scanType === "tob-goal"
							? [
									{
										value: "goal-candidates",
										label: scanT(
											t,
											"scan.job.tabs.goalCandidates",
											"Goal Candidates",
										),
									},
									{
										value: "goal-findings",
										label: scanT(
											t,
											"scan.job.tabs.goalFindings",
											"Goal Findings",
										),
									},
								]
							: []),
						...researchRegistryTabs.map((tab) => ({
							value: tab.value,
							label: tab.label,
						})),
						{
							value: "monitoring",
							label: scanT(t, "scan.monitoring.title", "Monitoring"),
						},
						{ value: "files", label: scanT(t, "scan.files.title", "Files") },
					]}
					hiddenValues={["evaluate"]}
					onTabChange={handleTabChange}
				/>
				<DashboardPageBody>
					<DashboardPageTabContent>
						<Tabs
							value={activeTab}
							onValueChange={handleTabChange}
							className="w-full"
						>
							<TabsContent value="overview" className="mt-0 pt-0">
								<ScanJobOverviewTab
									scanJobId={scanJobId}
									serviceType={serviceType}
									serviceId={serviceId}
									isLoadingJob={isLoadingJob}
									scanJob={scanJob}
									queuePendingCounts={queuePendingCounts}
									resultSummary={resultSummary}
									isLoadingResultSummary={isLoadingResultSummary}
									refreshScanJobViews={refreshScanJobViews}
								/>
							</TabsContent>

							<TabsContent value="evaluate" className="mt-0 pt-0">
								<ScanJobEvaluateTab
									scanJobId={scanJobId}
									serviceType={serviceType}
									isLoadingJob={isLoadingJob}
									scanJob={scanJob}
									canEvaluateScanJob={canEvaluateScanJob}
									latestEvaluation={latestEvaluation}
									isLoadingLatestEvaluation={isLoadingLatestEvaluation}
									serviceData={serviceData}
								/>
							</TabsContent>

							{scanJob?.scanType === "tob-goal" ? (
								<>
									<TabsContent value="goal-candidates" className="mt-0 pt-0">
										<TobGoalCandidatesPanel scanJobId={scanJobId} />
									</TabsContent>
									<TabsContent value="goal-findings" className="mt-0 pt-0">
										<TobGoalFindingsPanel scanJobId={scanJobId} />
									</TabsContent>
								</>
							) : null}

							{scanJob?.scanType !== "research" &&
							scanJob?.scanType !== "tob-goal" ? (
								<TabsContent value="candidates" className="mt-0 pt-0">
									<ScanJobCandidatesTab
										scanJobId={scanJobId}
										candidates={candidates}
										isLoadingCandidates={isLoadingCandidates}
										isFetchingCandidates={isFetchingCandidates}
										candidatePagination={candidatePagination}
										candidateQuery={candidateQuery}
										onSearchChange={onSearchChange}
										analysisFilters={analysisFilters}
										onAnalysisFilterToggle={onAnalysisFilterToggle}
										onClearAnalysisFilters={onClearAnalysisFilters}
										verifyFilters={verifyFilters}
										onVerifyFilterToggle={onVerifyFilterToggle}
										onClearVerifyFilters={onClearVerifyFilters}
										triageFilters={triageFilters}
										onTriageFilterToggle={onTriageFilterToggle}
										onClearTriageFilters={onClearTriageFilters}
										onToggleCandidateSort={onToggleCandidateSort}
										candidatePageSize={candidatePageSize}
										onPageSizeChange={onPageSizeChange}
										onPageChange={onPageChange}
										buildCandidateDetailHref={buildCandidateDetailHref}
										onCandidateLinkClick={onCandidateLinkClick}
										reanalyzingCandidateId={reanalyzingCandidateId}
										onReanalyzeCandidate={onReanalyzeCandidate}
									/>
								</TabsContent>
							) : null}

							{scanJob?.scanType === "research" ? (
								<ResearchRegistryPanels
									scanJobId={scanJobId}
									activeTab={activeTab}
									live={!isTerminalScanJobStatus(scanJob.status)}
								/>
							) : null}

							<TabsContent value="monitoring" className="mt-0 pt-0">
								<ScanMonitoring mode="job" scanJobId={scanJobId} />
							</TabsContent>

							<TabsContent value="files" className="mt-0 pt-0">
								<ScanJobFilesTab
									scanJobId={scanJobId}
									directoryCache={directoryCache}
									rootDirectoryLoading={rootDirectoryLoading}
									expandedDirectories={expandedDirectories}
									selectedFilePath={selectedFilePath}
									onToggleDirectory={onToggleDirectory}
									onSelectFile={onSelectFile}
									selectedFile={selectedFile}
									isLoadingSelectedFile={isLoadingSelectedFile}
								/>
							</TabsContent>

							<TabsContent value="tasks" className="mt-0 pt-0">
								<ScanJobTasksTab
									scanJobId={scanJobId}
									scanJob={scanJob}
									runningTasksData={runningTasksData}
									runningTasksError={runningTasksError}
									queueCountsData={queueCountsData}
									queueCountsError={queueCountsError}
									jobPipeline={jobPipeline}
									taskHref={buildTaskDetailHref}
								/>
							</TabsContent>
						</Tabs>
					</DashboardPageTabContent>
				</DashboardPageBody>
			</DashboardPage>
		</div>
	);
};
export const ShowScanJobDetail = (props: Props) => (
	<ScanJobDetailProvider {...props}>
		<ScanJobDetailShell />
	</ScanJobDetailProvider>
);
