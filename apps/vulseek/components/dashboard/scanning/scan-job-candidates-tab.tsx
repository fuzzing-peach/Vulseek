import {
	ChevronsUpDown,
	Clipboard,
	Download,
	FileSearch,
	Loader2,
	RefreshCw,
	Search,
	SquareTerminal,
} from "lucide-react";
import Link from "next/link";
import { useTranslation } from "next-i18next";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	ANALYSIS_RESULT_OPTIONS,
	type CandidateSortKey,
	TRIAGE_RESULT_OPTIONS,
	VERIFY_RESULT_OPTIONS,
} from "@/components/dashboard/scanning/candidate-list-query-state";
import { DateTooltip } from "@/components/shared/date-tooltip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { api, type RouterOutputs } from "@/utils/api";
import {
	formatAnalysisResultLabel,
	formatTruthResultLabel,
	type ScanTranslation,
	scanT,
} from "./scan-i18n";
import {
	buildCandidateExportFilename,
	buildCandidateReanalysisKey,
	CANDIDATE_EXPORT_FIELDS,
	type CandidateExportField,
	copyTextToClipboard,
	DEFAULT_CANDIDATE_EXPORT_FIELDS,
	formatResultLabel,
	getAnalysisResultBadgeClassName,
	getCandidateExportFieldLabel,
	getShortResultLabel,
	getTriageResultBadgeClassName,
	getVerificationTruthBadge,
} from "./scan-job-detail-format";

type CandidateListItem = RouterOutputs["scan"]["candidates"]["items"][number];

type ScanJobCandidatesTabProps = {
	scanJobId: string;
	/** Last successfully fetched candidates (kept visible during refetch). */
	candidates: RouterOutputs["scan"]["candidates"] | undefined;
	isLoadingCandidates: boolean;
	isFetchingCandidates: boolean;
	candidatePagination: {
		page: number;
		pageSize: number;
		totalItems: number;
		totalPages: number;
		startIndex: number;
		endIndex: number;
		items: CandidateListItem[];
	};
	candidateQuery: string;
	onSearchChange: (value: string) => void;
	analysisFilters: string[];
	onAnalysisFilterToggle: (value: string) => void;
	onClearAnalysisFilters: () => void;
	verifyFilters: string[];
	onVerifyFilterToggle: (value: string) => void;
	onClearVerifyFilters: () => void;
	triageFilters: string[];
	onTriageFilterToggle: (value: string) => void;
	onClearTriageFilters: () => void;
	onToggleCandidateSort: (key: CandidateSortKey) => void;
	candidatePageSize: number;
	onPageSizeChange: (size: number) => void;
	onPageChange: (page: number) => void;
	buildCandidateDetailHref: (
		candidate: Pick<
			CandidateListItem,
			"vulnerabilityCandidateId" | "producerTaskId"
		>,
	) => string;
	onCandidateLinkClick: () => void;
	reanalyzingCandidateId: string | null;
	onReanalyzeCandidate: (candidate: CandidateListItem) => void;
};

/**
 * Candidates tab for the shared scan job detail (Phase 4 split from
 * show-scan-job-detail): search, analysis/verify/triage filters, pagination,
 * selection, re-run analysis, review container and JSON export. Owns the
 * tab-local selection/export state and the review-container mutation; the
 * URL-backed list query state and the candidates polling query live in the
 * page/context controller.
 */
export const ScanJobCandidatesTab = ({
	scanJobId,
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
}: ScanJobCandidatesTabProps) => {
	const { t } = useTranslation("scan");
	const [selectedCandidateIds, setSelectedCandidateIds] = useState<Set<string>>(
		() => new Set(),
	);
	const [isCandidateExportDialogOpen, setIsCandidateExportDialogOpen] =
		useState(false);
	const [candidateExportFields, setCandidateExportFields] = useState<
		CandidateExportField[]
	>(() => [...DEFAULT_CANDIDATE_EXPORT_FIELDS]);
	const startCandidateReviewContainerMutation =
		api.scan.startCandidateReviewContainer.useMutation();

	const currentPageCandidateIds = useMemo(
		() =>
			candidatePagination.items.map(
				(candidate) => candidate.vulnerabilityCandidateId,
			),
		[candidatePagination.items],
	);
	const selectedCurrentPageCandidates = useMemo(
		() =>
			candidatePagination.items.filter((candidate) =>
				selectedCandidateIds.has(candidate.vulnerabilityCandidateId),
			),
		[candidatePagination.items, selectedCandidateIds],
	);
	const selectedCandidateCount = selectedCurrentPageCandidates.length;
	const hasCurrentPageCandidates = currentPageCandidateIds.length > 0;
	const areAllCurrentPageCandidatesSelected =
		hasCurrentPageCandidates &&
		currentPageCandidateIds.every((candidateId) =>
			selectedCandidateIds.has(candidateId),
		);
	const areSomeCurrentPageCandidatesSelected =
		selectedCandidateCount > 0 && !areAllCurrentPageCandidatesSelected;
	const selectedExportFieldSet = useMemo(
		() => new Set(candidateExportFields),
		[candidateExportFields],
	);
	const hasSelectedExportFields = candidateExportFields.length > 0;

	// Drop selections for candidates that are no longer on the current page.
	useEffect(() => {
		const currentPageIds = new Set(currentPageCandidateIds);
		setSelectedCandidateIds((current) => {
			let changed = false;
			const next = new Set<string>();
			for (const candidateId of current) {
				if (currentPageIds.has(candidateId)) {
					next.add(candidateId);
				} else {
					changed = true;
				}
			}
			return changed ? next : current;
		});
	}, [currentPageCandidateIds]);

	const hasCandidateFilters =
		candidateQuery.trim().length > 0 ||
		analysisFilters.length > 0 ||
		verifyFilters.length > 0 ||
		triageFilters.length > 0;
	const hasAnyCandidates = candidatePagination.totalItems > 0;

	const getCandidateLatestResultUpdate = (
		candidate: CandidateListItem,
	): {
		date: string;
		stageKey: string;
		stageLabel: string;
		timestamp: number;
	} | null => {
		const resultUpdates: Array<{
			date: string;
			stageKey: string;
			stageLabel: string;
			timestamp: number;
		}> = [];
		for (const item of [
			{
				date: candidate.latestAnalysisResult?.updatedAt,
				stageKey: "scan.stage.analyze-finding",
				stageLabel: "Analyze Finding",
			},
			{
				date: candidate.latestVerificationResult?.updatedAt,
				stageKey: "scan.stage.verify-finding",
				stageLabel: "Verify Finding",
			},
			{
				date: candidate.latestTriageResult?.updatedAt,
				stageKey: "scan.stage.triage-finding",
				stageLabel: "Triage Finding",
			},
		]) {
			if (!item.date) {
				continue;
			}
			const timestamp = Date.parse(item.date);
			if (!Number.isFinite(timestamp)) {
				continue;
			}
			resultUpdates.push({ ...item, date: item.date, timestamp });
		}
		resultUpdates.sort((left, right) => right.timestamp - left.timestamp);

		return resultUpdates[0] || null;
	};

	const toggleCandidateSelection = (candidateId: string) => {
		setSelectedCandidateIds((current) => {
			const next = new Set(current);
			if (next.has(candidateId)) {
				next.delete(candidateId);
			} else {
				next.add(candidateId);
			}
			return next;
		});
	};

	const toggleCurrentPageCandidateSelection = () => {
		setSelectedCandidateIds((current) => {
			if (areAllCurrentPageCandidatesSelected) {
				return new Set();
			}
			return new Set([...current, ...currentPageCandidateIds]);
		});
	};

	const toggleCandidateExportField = (field: CandidateExportField) => {
		setCandidateExportFields((current) =>
			current.includes(field)
				? current.filter((item) => item !== field)
				: [...current, field],
		);
	};

	const buildCandidateExportRecord = (candidate: CandidateListItem) => {
		const candidateWithHostPaths = candidate as CandidateListItem & {
			fileHostPath?: string | null;
			latestAnalysisResult?:
				| (CandidateListItem["latestAnalysisResult"] & {
						reportHostPath?: string | null;
				  })
				| null;
			latestVerificationResult?:
				| (CandidateListItem["latestVerificationResult"] & {
						reportHostPath?: string | null;
				  })
				| null;
			latestTriageResult?:
				| (CandidateListItem["latestTriageResult"] & {
						reportHostPath?: string | null;
				  })
				| null;
		};
		const latestAnalysisResult = candidateWithHostPaths.latestAnalysisResult;
		const latestVerificationResult =
			candidateWithHostPaths.latestVerificationResult;
		const latestTriageResult = candidateWithHostPaths.latestTriageResult;
		const exportableFields: Record<CandidateExportField, unknown> = {
			vulnerabilityCandidateId: candidate.vulnerabilityCandidateId,
			scanJobId: candidate.scanJobId,
			producerTaskId: candidate.producerTaskId,
			title: candidate.title,
			description: candidate.description,
			fileHostPath: candidateWithHostPaths.fileHostPath,
			line: candidate.line,
			vulnerabilityType: candidate.vulnerabilityType,
			confidence: candidate.confidence,
			score: candidate.score,
			createdAt: candidate.createdAt,
			updatedAt: candidate.updatedAt,
			analysisTaskId: latestAnalysisResult?.taskId ?? null,
			analysisResult: latestAnalysisResult?.result ?? null,
			analysisConfidence: latestAnalysisResult?.confidence ?? null,
			analysisScore: latestAnalysisResult?.score ?? null,
			analysisSummary: latestAnalysisResult?.summary ?? null,
			analysisReportHostPath: latestAnalysisResult?.reportHostPath ?? null,
			analysisRuntimeSeconds: latestAnalysisResult?.runtimeSeconds ?? null,
			analysisThreadId: latestAnalysisResult?.threadId ?? null,
			analysisCreatedAt: latestAnalysisResult?.createdAt ?? null,
			analysisUpdatedAt: latestAnalysisResult?.updatedAt ?? null,
			verificationTaskId: latestVerificationResult?.taskId ?? null,
			verificationResult: latestVerificationResult?.result ?? null,
			verificationConfidence: latestVerificationResult?.confidence ?? null,
			verificationScore: latestVerificationResult?.score ?? null,
			verificationSummary: latestVerificationResult?.summary ?? null,
			verificationReportHostPath:
				latestVerificationResult?.reportHostPath ?? null,
			verificationRuntimeSeconds:
				latestVerificationResult?.runtimeSeconds ?? null,
			verificationThreadId: latestVerificationResult?.threadId ?? null,
			verificationCreatedAt: latestVerificationResult?.createdAt ?? null,
			verificationUpdatedAt: latestVerificationResult?.updatedAt ?? null,
			triageTaskId: latestTriageResult?.taskId ?? null,
			triageResult: latestTriageResult?.result ?? null,
			triageDisqualifier: latestTriageResult?.disqualifier ?? null,
			triageDisqualifierReason: latestTriageResult?.disqualifierReason ?? null,
			triageSecurityClassification:
				latestTriageResult?.securityClassification ?? null,
			triageIsSecurityIssue: latestTriageResult?.isSecurityIssue ?? null,
			triageImpactType: latestTriageResult?.impactType ?? null,
			triageCvssVector: latestTriageResult?.cvssVector ?? null,
			triageCvssScore: latestTriageResult?.cvssScore ?? null,
			triageCvssSeverity: latestTriageResult?.cvssSeverity ?? null,
			triageExploitability: latestTriageResult?.exploitability ?? null,
			triageIsExploitable: latestTriageResult?.isExploitable ?? null,
			triageEpssProbability30d: latestTriageResult?.epssProbability30d ?? null,
			triageEpssSource: latestTriageResult?.epssSource ?? null,
			triageSummary: latestTriageResult?.summary ?? null,
			triageReportHostPath: latestTriageResult?.reportHostPath ?? null,
		};
		return Object.fromEntries(
			CANDIDATE_EXPORT_FIELDS.filter((field) =>
				selectedExportFieldSet.has(field.key),
			).map((field) => [field.key, exportableFields[field.key]]),
		);
	};

	const buildCandidateExportJson = () =>
		JSON.stringify(
			selectedCurrentPageCandidates.map((candidate) =>
				buildCandidateExportRecord(candidate),
			),
			null,
			2,
		);

	const downloadSelectedCandidatesJson = () => {
		const exportJson = buildCandidateExportJson();
		const blob = new Blob([exportJson], { type: "application/json" });
		const objectUrl = URL.createObjectURL(blob);
		const anchor = document.createElement("a");
		anchor.href = objectUrl;
		anchor.download = buildCandidateExportFilename(scanJobId);
		document.body.appendChild(anchor);
		anchor.click();
		anchor.remove();
		URL.revokeObjectURL(objectUrl);
		toast.success(
			scanT(t, "scan.candidates.downloaded", "Candidate JSON downloaded"),
		);
	};

	const copySelectedCandidatesJson = async () => {
		try {
			await copyTextToClipboard(buildCandidateExportJson());
			toast.success(scanT(t, "scan.candidates.copied", "Candidate JSON copied"));
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: scanT(
							t,
							"scan.candidates.copyFailed",
							"Failed to copy candidate JSON",
						),
			);
		}
	};

	const handleStartCandidateReviewContainer = async () => {
		const candidateIds = selectedCurrentPageCandidates.map(
			(candidate) => candidate.vulnerabilityCandidateId,
		);
		if (candidateIds.length === 0) {
			return;
		}

		try {
			const result = await startCandidateReviewContainerMutation.mutateAsync({
				scanJobId,
				candidateIds,
			});
			window.open(result.terminalUrl, "_blank", "noopener,noreferrer");
			toast.success(
				scanT(
					t,
					"scan.candidates.mountAndStartContainerOpened",
					"Review container started",
				),
			);
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: scanT(
							t,
							"scan.candidates.mountAndStartContainerError",
							"Failed to start review container",
						),
			);
		}
	};

	return (
		<>
			{isLoadingCandidates && !candidates ? (
				<div className="flex items-center gap-2 text-muted-foreground">
					<Loader2 className="size-4 animate-spin" />
					{scanT(t, "scan.candidates.loading", "Loading candidates...")}
				</div>
			) : !candidates ||
				(candidatePagination.totalItems === 0 && !hasCandidateFilters) ? (
				<div className="flex items-center gap-2 text-muted-foreground">
					<FileSearch className="size-4" />
					{scanT(t, "scan.candidates.empty", "No candidates yet")}
				</div>
			) : (
				<div
					className={`flex flex-col gap-3 transition-opacity duration-150 ${isFetchingCandidates ? "opacity-50 pointer-events-none" : ""}`}
				>
					<div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_220px_220px_220px]">
						<div className="relative">
							<Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
							<input
								type="text"
								value={candidateQuery}
								onChange={(event) => onSearchChange(event.target.value)}
								placeholder={scanT(
									t,
									"scan.candidates.search",
									"Search candidates",
								)}
								className="flex h-10 w-full rounded-md border border-input bg-background pl-9 pr-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
							/>
						</div>
						<PopoverFilter
							label={scanT(t, "scan.filters.analysisResult", "Analysis Result")}
							count={analysisFilters.length}
							onClear={onClearAnalysisFilters}
							options={ANALYSIS_RESULT_OPTIONS.map((value) => ({
								value,
								label: formatAnalysisResultLabel(t, value),
								checked: analysisFilters.includes(value),
								onToggle: () => onAnalysisFilterToggle(value),
							}))}
							t={t}
						/>
						<PopoverFilter
							label={scanT(t, "scan.filters.verifyResult", "Verify Result")}
							count={verifyFilters.length}
							onClear={onClearVerifyFilters}
							options={VERIFY_RESULT_OPTIONS.map((value) => ({
								value,
								label: formatTruthResultLabel(t, value),
								checked: verifyFilters.includes(value),
								onToggle: () => onVerifyFilterToggle(value),
							}))}
							t={t}
						/>
						<PopoverFilter
							label={scanT(t, "scan.filters.triageResult", "Triage Result")}
							count={triageFilters.length}
							onClear={onClearTriageFilters}
							options={TRIAGE_RESULT_OPTIONS.map((value) => ({
								value,
								label: scanT(
									t,
									`scan.triageResult.${value}`,
									formatResultLabel(value),
								),
								checked: triageFilters.includes(value),
								onToggle: () => onTriageFilterToggle(value),
							}))}
							t={t}
						/>
					</div>
					{candidatePagination.totalItems === 0 ? (
						<div className="flex items-center gap-2 text-muted-foreground">
							<FileSearch className="size-4" />
							{scanT(t, "scan.candidates.noMatching", "No matching candidates")}
						</div>
					) : (
						<>
							<div className="rounded-lg border">
								<div className="flex flex-col gap-3 border-b px-4 py-3 text-sm md:flex-row md:items-center md:justify-between">
									<div className="text-muted-foreground">
										{scanT(
											t,
											"scan.pagination.showing",
											"Showing {{start}}-{{end}} of {{total}}",
											{
												start: candidatePagination.startIndex + 1,
												end: candidatePagination.endIndex,
												total: candidatePagination.totalItems,
											},
										)}
										{selectedCandidateCount > 0
											? ` ${scanT(
													t,
													"scan.pagination.selected",
													"({{count}} selected)",
													{ count: selectedCandidateCount },
												)}`
											: ""}
									</div>
									<div className="flex flex-wrap items-center gap-2">
										<Button
											type="button"
											variant="outline"
											size="sm"
											disabled={
												selectedCandidateCount === 0 ||
												startCandidateReviewContainerMutation.isLoading
											}
											onClick={handleStartCandidateReviewContainer}
										>
											{startCandidateReviewContainerMutation.isLoading ? (
												<Loader2 className="mr-2 size-4 animate-spin" />
											) : (
												<SquareTerminal className="mr-2 size-4" />
											)}
											{scanT(
												t,
												startCandidateReviewContainerMutation.isLoading
													? "scan.candidates.mountAndStartContainerStarting"
													: "scan.candidates.mountAndStartContainer",
												startCandidateReviewContainerMutation.isLoading
													? "Starting..."
													: "Mount and Start Container",
											)}
										</Button>
										<Button
											type="button"
											variant="outline"
											size="sm"
											disabled={selectedCandidateCount === 0}
											onClick={() => setIsCandidateExportDialogOpen(true)}
										>
											<Download className="mr-2 size-4" />
											{scanT(t, "scan.candidates.export", "Export")}
										</Button>
										<label
											className="text-muted-foreground"
											htmlFor="scan-candidate-page-size"
										>
											{scanT(t, "scan.pagination.pageSize", "Page size")}
										</label>
										<select
											id="scan-candidate-page-size"
											value={candidatePageSize}
											onChange={(event) => {
												onPageSizeChange(
													Number.parseInt(event.target.value, 10) || 20,
												);
											}}
											className="h-9 rounded-md border border-input bg-background px-2 text-sm"
										>
											{[10, 20, 50, 100].map((size) => (
												<option key={size} value={size}>
													{size}
												</option>
											))}
										</select>
										<Button
											type="button"
											variant="outline"
											size="sm"
											onClick={() =>
												onPageChange(Math.max(1, candidatePagination.page - 1))
											}
											disabled={candidatePagination.page <= 1}
										>
											{scanT(t, "scan.pagination.previous", "Previous")}
										</Button>
										<div className="min-w-[96px] text-center text-muted-foreground">
											{scanT(
												t,
												"scan.pagination.page",
												"Page {{page}} / {{total}}",
												{
													page: candidatePagination.page,
													total: candidatePagination.totalPages,
												},
											)}
										</div>
										<Button
											type="button"
											variant="outline"
											size="sm"
											onClick={() =>
												onPageChange(
													Math.min(
														candidatePagination.totalPages,
														candidatePagination.page + 1,
													),
												)
											}
											disabled={
												candidatePagination.page >= candidatePagination.totalPages
											}
										>
											{scanT(t, "scan.pagination.next", "Next")}
										</Button>
									</div>
								</div>
								<div className="overflow-x-auto">
									<table className="w-full text-sm">
										<thead className="border-b bg-muted/30 text-left">
											<tr>
												<th className="w-12 px-4 py-3 font-medium">
													<Checkbox
														aria-label={scanT(
															t,
															"scan.candidates.selectAllAria",
															"Select all candidates on this page",
														)}
														checked={
															areAllCurrentPageCandidatesSelected
																? true
																: areSomeCurrentPageCandidatesSelected
																	? "indeterminate"
																	: false
														}
														onClick={(event) => event.stopPropagation()}
														onCheckedChange={
															toggleCurrentPageCandidateSelection
														}
													/>
												</th>
												<th className="w-[32%] px-4 py-3 font-medium">
													<SortableHeader
														label={scanT(
															t,
															"scan.field.candidate",
															"Candidate",
														)}
														onSort={() => onToggleCandidateSort("candidate")}
													/>
												</th>
												<th className="w-[16%] px-4 py-3 font-medium">
													<SortableHeader
														label={scanT(
															t,
															"scan.filters.analysisResult",
															"Analysis Result",
														)}
														onSort={() => onToggleCandidateSort("analysis")}
													/>
												</th>
												<th className="w-[14%] px-4 py-3 font-medium">
													<SortableHeader
														label={scanT(
															t,
															"scan.filters.verifyResult",
															"Verify Result",
														)}
														onSort={() => onToggleCandidateSort("verify")}
													/>
												</th>
												<th className="w-[16%] px-4 py-3 font-medium">
													{scanT(
														t,
														"scan.filters.triageResult",
														"Triage Result",
													)}
												</th>
												<th className="w-[13%] px-4 py-3 font-medium">
													<SortableHeader
														label={scanT(
															t,
															"scan.field.latestResultUpdatedAt",
															"Latest Update",
														)}
														onSort={() =>
															onToggleCandidateSort("latestResultUpdatedAt")
														}
													/>
												</th>
												<th className="w-[14%] px-4 py-3 font-medium">
													<SortableHeader
														label={scanT(t, "scan.field.score", "Score")}
														onSort={() => onToggleCandidateSort("score")}
													/>
												</th>
												<th className="w-[8%] px-4 py-3 font-medium">
													{scanT(t, "scan.tasks.actions", "Actions")}
												</th>
											</tr>
										</thead>
										<tbody>
											{candidatePagination.items.map(
												(candidate, candidateIndex) => {
													const verificationTruthBadge =
														getVerificationTruthBadge(
															t,
															candidate.latestVerificationResult?.result,
														);
													const isReanalyzingCandidate =
														reanalyzingCandidateId ===
														buildCandidateReanalysisKey(candidate);
													const isSelectedCandidate =
														selectedCandidateIds.has(
															candidate.vulnerabilityCandidateId,
														);
													const latestResultUpdate =
														getCandidateLatestResultUpdate(candidate);
													return (
														<tr
															key={`${candidate.vulnerabilityCandidateId}-${candidateIndex}`}
															className={`border-b last:border-b-0 transition-colors hover:bg-muted/40 ${
																isSelectedCandidate
																	? "bg-muted/40"
																	: ""
															}`}
														>
															<td className="px-4 py-3 align-top">
																<Checkbox
																	aria-label={scanT(
																		t,
																		"scan.candidates.selectAria",
																		"Select candidate {{title}}",
																		{ title: candidate.title },
																	)}
																	checked={isSelectedCandidate}
																	onClick={(event) => event.stopPropagation()}
																	onCheckedChange={() =>
																		toggleCandidateSelection(
																			candidate.vulnerabilityCandidateId,
																		)
																	}
																/>
															</td>
															<td className="px-4 py-3 align-top">
																<Link
																	href={buildCandidateDetailHref(candidate)}
																	onClick={onCandidateLinkClick}
																	className="block"
																>
																	<div className="font-medium">
																		{candidate.title}
																	</div>
																	<div className="mt-1 text-xs text-muted-foreground break-all">
																		{candidate.filePath || "-"}
																		{candidate.line ? `:${candidate.line}` : ""}
																	</div>
																</Link>
															</td>
															<td className="px-4 py-3 align-top">
																<Link
																	href={buildCandidateDetailHref(candidate)}
																	onClick={onCandidateLinkClick}
																	className="block"
																>
																	{candidate.latestAnalysisResult?.result ? (
																		<Badge
																			variant="outline"
																			className={getAnalysisResultBadgeClassName(
																				candidate.latestAnalysisResult.result,
																			)}
																		>
																			{getShortResultLabel(
																				t,
																				candidate.latestAnalysisResult.result,
																			)}
																		</Badge>
																	) : (
																		<span className="text-xs text-muted-foreground">
																			-
																		</span>
																	)}
																</Link>
															</td>
															<td className="px-4 py-3 align-top">
																<Link
																	href={buildCandidateDetailHref(candidate)}
																	onClick={onCandidateLinkClick}
																	className="block"
																>
																	{verificationTruthBadge ? (
																		<Badge
																			variant="outline"
																			className={verificationTruthBadge.className}
																		>
																			{verificationTruthBadge.label}
																		</Badge>
																	) : (
																		<span className="text-xs text-muted-foreground">
																			-
																		</span>
																	)}
																</Link>
															</td>
															<td className="px-4 py-3 align-top">
																<Link
																	href={buildCandidateDetailHref(candidate)}
																	onClick={onCandidateLinkClick}
																	className="block"
																>
																	{candidate.latestTriageResult ? (
																		<Badge
																			variant="outline"
																			className={getTriageResultBadgeClassName(
																				candidate.latestTriageResult.result,
																			)}
																		>
																			{getShortResultLabel(
																				t,
																				candidate.latestTriageResult.result,
																			)}
																		</Badge>
																	) : (
																		<span className="text-xs text-muted-foreground">
																			-
																		</span>
																	)}
																</Link>
															</td>
															<td className="px-4 py-3 align-top text-xs">
																<Link
																	href={buildCandidateDetailHref(candidate)}
																	onClick={onCandidateLinkClick}
																	className="block"
																>
																	{latestResultUpdate ? (
																		<>
																			<DateTooltip
																				date={latestResultUpdate.date}
																				className="text-xs"
																			/>
																			<div className="mt-1 text-muted-foreground">
																				{scanT(
																					t,
																					latestResultUpdate.stageKey,
																					latestResultUpdate.stageLabel,
																				)}
																			</div>
																		</>
																	) : (
																		<span className="text-muted-foreground">
																			-
																		</span>
																	)}
																</Link>
															</td>
															<td className="px-4 py-3 align-top text-xs text-muted-foreground">
																<Link
																	href={buildCandidateDetailHref(candidate)}
																	onClick={onCandidateLinkClick}
																	className="block"
																>
																	{typeof candidate.score === "number"
																		? candidate.score.toFixed(1)
																		: "-"}
																</Link>
															</td>
															<td className="px-4 py-3 align-top">
																<Button
																	type="button"
																	variant="outline"
																	size="icon"
																	title={scanT(
																		t,
																		"scan.candidates.rerunAnalysis",
																		"Re-run analysis",
																	)}
																	aria-label={scanT(
																		t,
																		"scan.candidates.rerunAnalysis",
																		"Re-run analysis",
																	)}
																	disabled={isReanalyzingCandidate}
																	onClick={() => onReanalyzeCandidate(candidate)}
																>
																	{isReanalyzingCandidate ? (
																		<Loader2 className="size-4 animate-spin" />
																	) : (
																		<RefreshCw className="size-4" />
																	)}
																</Button>
															</td>
														</tr>
													);
												},
											)}
										</tbody>
									</table>
								</div>
							</div>
							<Dialog
								open={isCandidateExportDialogOpen}
								onOpenChange={setIsCandidateExportDialogOpen}
							>
								<DialogContent className="sm:max-w-xl">
									<DialogHeader>
										<DialogTitle>
											{scanT(
												t,
												"scan.candidates.exportTitle",
												"Export Candidates",
											)}
										</DialogTitle>
										<DialogDescription>
											{scanT(
												t,
												"scan.candidates.exportDescription",
												"Export {{count}} selected candidates from the current page.",
												{ count: selectedCandidateCount },
											)}
										</DialogDescription>
									</DialogHeader>
									<div className="space-y-4">
										<div className="flex items-center justify-between gap-3">
											<div>
												<div className="text-sm font-medium">
													{scanT(t, "scan.candidates.exportFields", "Fields")}
												</div>
												<div className="text-xs text-muted-foreground">
													{scanT(
														t,
														"scan.candidates.exportFieldsDescription",
														"Choose the fields included in the generated JSON.",
													)}
												</div>
											</div>
											<Button
												type="button"
												variant="ghost"
												size="sm"
												className="h-auto px-2 py-1 text-xs"
												onClick={() =>
													setCandidateExportFields(
														candidateExportFields.length ===
															CANDIDATE_EXPORT_FIELDS.length
															? []
															: [...DEFAULT_CANDIDATE_EXPORT_FIELDS],
													)
												}
											>
												{candidateExportFields.length ===
												CANDIDATE_EXPORT_FIELDS.length
													? scanT(t, "scan.filters.clear", "Clear")
													: scanT(
															t,
															"scan.candidates.selectAll",
															"Select all",
														)}
											</Button>
										</div>
										<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
											{CANDIDATE_EXPORT_FIELDS.map((field) => (
												<div
													key={field.key}
													className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
												>
													<Checkbox
														checked={selectedExportFieldSet.has(field.key)}
														onCheckedChange={() =>
															toggleCandidateExportField(field.key)
														}
													/>
													<span>
														{getCandidateExportFieldLabel(t, field)}
													</span>
												</div>
											))}
										</div>
										{!hasSelectedExportFields ? (
											<div className="text-xs text-destructive">
												{scanT(
													t,
													"scan.candidates.exportNoFields",
													"Select at least one field to export.",
												)}
											</div>
										) : null}
									</div>
									<DialogFooter>
										<Button
											type="button"
											variant="outline"
											onClick={copySelectedCandidatesJson}
											disabled={
												selectedCandidateCount === 0 || !hasSelectedExportFields
											}
										>
											<Clipboard className="mr-2 size-4" />
											{scanT(
												t,
												"scan.candidates.copyJson",
												"Copy JSON",
											)}
										</Button>
										<Button
											type="button"
											onClick={downloadSelectedCandidatesJson}
											disabled={
												selectedCandidateCount === 0 || !hasSelectedExportFields
											}
										>
											<Download className="mr-2 size-4" />
											{scanT(
												t,
												"scan.candidates.downloadJson",
												"Download JSON",
											)}
										</Button>
									</DialogFooter>
								</DialogContent>
							</Dialog>
						</>
					)}
				</div>
			)}
		</>
	);
};

type PopoverFilterOption = {
	value: string;
	label: string;
	checked: boolean;
	onToggle: () => void;
};

const PopoverFilter = ({
	t,
	label,
	count,
	onClear,
	options,
}: {
	t: ScanTranslation;
	label: string;
	count: number;
	onClear: () => void;
	options: PopoverFilterOption[];
}) => {
	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button variant="outline" className="justify-between">
					<span>
						{label}
						{count > 0 ? ` (${count})` : ""}
					</span>
					<ChevronsUpDown className="size-4 text-muted-foreground" />
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-72 p-3">
				<div className="mb-3 flex items-center justify-between">
					<div className="text-sm font-medium">{label}</div>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="h-auto px-2 py-1 text-xs"
						onClick={onClear}
					>
						{scanT(t, "scan.filters.clear", "Clear")}
					</Button>
				</div>
				<div className="space-y-2">
					{options.map((option) => (
						<div
							key={option.value}
							className="flex items-center gap-2 text-sm"
						>
							<Checkbox
								checked={option.checked}
								onCheckedChange={option.onToggle}
							/>
							<span>{option.label}</span>
						</div>
					))}
				</div>
			</PopoverContent>
		</Popover>
	);
};

const SortableHeader = ({
	label,
	onSort,
}: {
	label: string;
	onSort: () => void;
}) => (
	<button
		type="button"
		onClick={onSort}
		className="inline-flex items-center gap-1 hover:text-foreground"
	>
		<span>{label}</span>
		<ChevronsUpDown className="size-3.5" />
	</button>
);

