export type ResearchRegistryPageInput = {
	scanJobId: string;
	page: number;
	pageSize: number;
	query?: string;
	status?: string;
	statuses?: string[];
	trustLevels?: string[];
	sortKey?: string;
	sortDirection?: string;
};

const RESEARCH_REGISTRY_SORT_KEYS = new Set([
	"updatedAt",
	"findingId",
	"title",
	"trackKey",
	"vulnerabilityClass",
	"location",
	"confidence",
	"status",
	"approachFamily",
	"researchIdea",
	"iteration",
	"primitiveId",
	"findingId",
	"name",
	"capability",
	"trustLevel",
	"chainId",
	"chainKey",
]);

const normalizeValues = (values: string[] | undefined) => [
	...new Set(
		(values ?? [])
			.map((value) => value.trim())
			.filter(Boolean),
	),
];

export const normalizeResearchRegistryPageInput = (
	input: ResearchRegistryPageInput,
) => ({
	scanJobId: input.scanJobId,
	page: Math.max(1, input.page),
	pageSize: Math.max(1, Math.min(100, input.pageSize)),
	query: input.query?.trim() ?? "",
	status: input.status?.trim() ?? "",
	statuses: normalizeValues(input.statuses),
	trustLevels: normalizeValues(input.trustLevels),
	sortKey: RESEARCH_REGISTRY_SORT_KEYS.has(input.sortKey ?? "")
		? input.sortKey
		: "updatedAt",
	sortDirection: input.sortDirection === "asc" ? "asc" : "desc",
});

export const buildResearchRegistryPage = <T>(input: {
	items: T[];
	total: number;
	requestedPage: number;
	pageSize: number;
}) => {
	const totalPages = Math.max(1, Math.ceil(input.total / input.pageSize));
	return {
		items: input.items,
		total: input.total,
		page: Math.min(Math.max(1, input.requestedPage), totalPages),
		pageSize: input.pageSize,
		totalPages,
	};
};
