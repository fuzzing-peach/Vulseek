import type { ParsedUrlQuery } from "querystring";

export type CandidateSortKey = "candidate" | "analysis" | "verify" | "score";
export type CandidateSortDirection = "asc" | "desc";

export const ANALYSIS_RESULT_OPTIONS = [
	"real_vulnerability",
	"likely_vulnerability",
	"plausible_but_unproven",
	"false_positive",
	"api_misuse",
] as const;

export const VERIFY_RESULT_OPTIONS = [
	"true",
	"likely",
	"false",
] as const;

export const TRIAGE_RESULT_OPTIONS = [
	"security_issue",
	"non_security",
	"hardening",
	"needs_review",
] as const;

export type CandidateListQueryState = {
	candidateQuery: string;
	analysisFilters: string[];
	verifyFilters: string[];
	triageFilters: string[];
	candidateSortKey: CandidateSortKey;
	candidateSortDirection: CandidateSortDirection;
	candidatePage: number;
	candidatePageSize: number;
};

const CANDIDATE_QUERY_PARAM = "candidateQuery";
const ANALYSIS_FILTERS_PARAM = "candidateAnalysis";
const VERIFY_FILTERS_PARAM = "candidateVerify";
const TRIAGE_FILTERS_PARAM = "candidateTriage";
const SORT_KEY_PARAM = "candidateSortKey";
const SORT_DIRECTION_PARAM = "candidateSortDirection";
const PAGE_PARAM = "candidatePage";
const PAGE_SIZE_PARAM = "candidatePageSize";

const CANDIDATE_SORT_KEYS: CandidateSortKey[] = [
	"candidate",
	"analysis",
	"verify",
	"score",
];

const CANDIDATE_SORT_DIRECTIONS: CandidateSortDirection[] = ["asc", "desc"];
const CANDIDATE_PAGE_SIZES = [10, 20, 50, 100] as const;

const getFirstQueryValue = (value: string | string[] | undefined) => {
	if (typeof value === "string") {
		return value;
	}

	if (Array.isArray(value)) {
		return value[0] || "";
	}

	return "";
};

const normalizeDelimitedValues = (
	value: string,
	allowedValues: readonly string[],
) => {
	const allowed = new Set(allowedValues);
	const selected = new Set(
		value
			.split(",")
			.map((item) => item.trim())
			.filter((item) => item && allowed.has(item)),
	);
	return allowedValues.filter((item) => selected.has(item));
};

const normalizePositiveInteger = (value: string, fallback: number) => {
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const parseCandidateListQueryState = (
	query: ParsedUrlQuery,
): CandidateListQueryState => {
	const rawSortKey = getFirstQueryValue(query[SORT_KEY_PARAM]);
	const rawSortDirection = getFirstQueryValue(query[SORT_DIRECTION_PARAM]);

	return {
		candidateQuery: getFirstQueryValue(query[CANDIDATE_QUERY_PARAM]),
		analysisFilters: normalizeDelimitedValues(
			getFirstQueryValue(query[ANALYSIS_FILTERS_PARAM]),
			ANALYSIS_RESULT_OPTIONS,
		),
		verifyFilters: normalizeDelimitedValues(
			getFirstQueryValue(query[VERIFY_FILTERS_PARAM]),
			VERIFY_RESULT_OPTIONS,
		),
		triageFilters: normalizeDelimitedValues(
			getFirstQueryValue(query[TRIAGE_FILTERS_PARAM]),
			TRIAGE_RESULT_OPTIONS,
		),
		candidateSortKey: CANDIDATE_SORT_KEYS.includes(
			rawSortKey as CandidateSortKey,
		)
			? (rawSortKey as CandidateSortKey)
			: "candidate",
		candidateSortDirection: CANDIDATE_SORT_DIRECTIONS.includes(
			rawSortDirection as CandidateSortDirection,
		)
			? (rawSortDirection as CandidateSortDirection)
			: "asc",
		candidatePage: normalizePositiveInteger(
			getFirstQueryValue(query[PAGE_PARAM]),
			1,
		),
		candidatePageSize: CANDIDATE_PAGE_SIZES.includes(
			normalizePositiveInteger(getFirstQueryValue(query[PAGE_SIZE_PARAM]), 20) as
				(typeof CANDIDATE_PAGE_SIZES)[number],
		)
			? normalizePositiveInteger(getFirstQueryValue(query[PAGE_SIZE_PARAM]), 20)
			: 20,
	};
};

export const serializeCandidateListQueryState = (
	state: CandidateListQueryState,
) =>
	JSON.stringify({
		candidateQuery: state.candidateQuery,
		analysisFilters: state.analysisFilters,
		verifyFilters: state.verifyFilters,
		triageFilters: state.triageFilters,
		candidateSortKey: state.candidateSortKey,
		candidateSortDirection: state.candidateSortDirection,
		candidatePage: state.candidatePage,
		candidatePageSize: state.candidatePageSize,
	});

export const applyCandidateListQueryState = (
	query: ParsedUrlQuery,
	state: CandidateListQueryState,
	tab?: string,
) => {
	const nextQuery: Record<string, string> = {};

	for (const [key, value] of Object.entries(query)) {
		if (
			key === CANDIDATE_QUERY_PARAM ||
			key === ANALYSIS_FILTERS_PARAM ||
			key === VERIFY_FILTERS_PARAM ||
			key === TRIAGE_FILTERS_PARAM ||
			key === SORT_KEY_PARAM ||
			key === SORT_DIRECTION_PARAM ||
			key === PAGE_PARAM ||
			key === PAGE_SIZE_PARAM ||
			key === "tab"
		) {
			continue;
		}

		const normalizedValue = getFirstQueryValue(value);
		if (normalizedValue) {
			nextQuery[key] = normalizedValue;
		}
	}

	if (tab) {
		nextQuery.tab = tab;
	}

	if (state.candidateQuery) {
		nextQuery[CANDIDATE_QUERY_PARAM] = state.candidateQuery;
	}

	if (state.analysisFilters.length > 0) {
		nextQuery[ANALYSIS_FILTERS_PARAM] = state.analysisFilters.join(",");
	}

	if (state.verifyFilters.length > 0) {
		nextQuery[VERIFY_FILTERS_PARAM] = state.verifyFilters.join(",");
	}

	if (state.triageFilters.length > 0) {
		nextQuery[TRIAGE_FILTERS_PARAM] = state.triageFilters.join(",");
	}

	if (state.candidateSortKey !== "candidate") {
		nextQuery[SORT_KEY_PARAM] = state.candidateSortKey;
	}

	if (state.candidateSortDirection !== "asc") {
		nextQuery[SORT_DIRECTION_PARAM] = state.candidateSortDirection;
	}

	if (state.candidatePage !== 1) {
		nextQuery[PAGE_PARAM] = String(state.candidatePage);
	}

	if (state.candidatePageSize !== 20) {
		nextQuery[PAGE_SIZE_PARAM] = String(state.candidatePageSize);
	}

	return nextQuery;
};

export const buildCandidateListStateHref = (
	basePath: string,
	state: CandidateListQueryState,
	tab?: string,
) => {
	const params = new URLSearchParams();

	if (tab) {
		params.set("tab", tab);
	}
	if (state.candidateQuery) {
		params.set(CANDIDATE_QUERY_PARAM, state.candidateQuery);
	}
	if (state.analysisFilters.length > 0) {
		params.set(ANALYSIS_FILTERS_PARAM, state.analysisFilters.join(","));
	}
	if (state.verifyFilters.length > 0) {
		params.set(VERIFY_FILTERS_PARAM, state.verifyFilters.join(","));
	}
	if (state.triageFilters.length > 0) {
		params.set(TRIAGE_FILTERS_PARAM, state.triageFilters.join(","));
	}
	if (state.candidateSortKey !== "candidate") {
		params.set(SORT_KEY_PARAM, state.candidateSortKey);
	}
	if (state.candidateSortDirection !== "asc") {
		params.set(SORT_DIRECTION_PARAM, state.candidateSortDirection);
	}
	if (state.candidatePage !== 1) {
		params.set(PAGE_PARAM, String(state.candidatePage));
	}
	if (state.candidatePageSize !== 20) {
		params.set(PAGE_SIZE_PARAM, String(state.candidatePageSize));
	}

	const queryString = params.toString();
	return queryString ? `${basePath}?${queryString}` : basePath;
};
