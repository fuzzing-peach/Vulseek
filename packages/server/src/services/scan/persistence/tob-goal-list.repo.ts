import { listTobGoalCandidatesByScanJobIdRepo } from "./tob-goal-candidate.repo";
import { listTobGoalFindingsByScanJobIdRepo } from "./tob-goal-finding.repo";

const parseFilter = (value?: string) =>
	new Set(
		(value ?? "")
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean),
	);

const listFilterOptions = (values: string[]) =>
	[...new Set(values.filter(Boolean))].sort((left, right) =>
		left.localeCompare(right),
	);

export const listTobGoalCandidatesPageRepo = async (input: {
	scanJobId: string;
	page?: number;
	pageSize?: number;
	status?: string;
	huntGoalId?: string;
	query?: string;
}) => {
	const page = Math.max(1, input.page ?? 1);
	const pageSize = Math.max(1, Math.min(100, input.pageSize ?? 20));
	const query = input.query?.trim().toLowerCase() ?? "";
	const statuses = parseFilter(input.status);
	const huntGoalIds = parseFilter(input.huntGoalId);
	const all = await listTobGoalCandidatesByScanJobIdRepo(input.scanJobId);
	const filtered = all.filter((row) => {
		if (statuses.size > 0 && !statuses.has(row.status)) return false;
		if (huntGoalIds.size > 0 && !huntGoalIds.has(row.huntGoalId)) return false;
		if (!query) return true;
		const haystack =
			`${row.title} ${row.summary} ${row.candidateId} ${row.huntGoalId}`.toLowerCase();
		return haystack.includes(query);
	});
	const total = filtered.length;
	const totalPages = Math.max(1, Math.ceil(total / pageSize));
	const safePage = Math.min(page, totalPages);
	const start = (safePage - 1) * pageSize;
	return {
		items: filtered.slice(start, start + pageSize),
		total,
		page: safePage,
		pageSize,
		totalPages,
		filterOptions: {
			statuses: listFilterOptions(all.map((row) => row.status)),
			huntGoalIds: listFilterOptions(all.map((row) => row.huntGoalId)),
		},
	};
};

export const listTobGoalFindingsPageRepo = async (input: {
	scanJobId: string;
	page?: number;
	pageSize?: number;
	status?: string;
	huntGoalId?: string;
	query?: string;
}) => {
	const page = Math.max(1, input.page ?? 1);
	const pageSize = Math.max(1, Math.min(100, input.pageSize ?? 20));
	const query = input.query?.trim().toLowerCase() ?? "";
	const statuses = parseFilter(input.status);
	const huntGoalIds = parseFilter(input.huntGoalId);
	const all = await listTobGoalFindingsByScanJobIdRepo(input.scanJobId);
	const filtered = all.filter((row) => {
		if (statuses.size > 0 && !statuses.has(row.status)) return false;
		if (huntGoalIds.size > 0 && !huntGoalIds.has(row.huntGoalId)) return false;
		if (!query) return true;
		const haystack =
			`${row.title} ${row.summary} ${row.findingId} ${row.sourceCandidateId}`.toLowerCase();
		return haystack.includes(query);
	});
	const total = filtered.length;
	const totalPages = Math.max(1, Math.ceil(total / pageSize));
	const safePage = Math.min(page, totalPages);
	const start = (safePage - 1) * pageSize;
	return {
		items: filtered.slice(start, start + pageSize),
		total,
		page: safePage,
		pageSize,
		totalPages,
		filterOptions: {
			statuses: listFilterOptions(all.map((row) => row.status)),
			huntGoalIds: listFilterOptions(all.map((row) => row.huntGoalId)),
		},
	};
};
