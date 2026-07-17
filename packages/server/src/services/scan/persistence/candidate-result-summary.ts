export type CandidateResultSummaryGroup = {
	analysisResult: string | null;
	verificationResult: string | null;
	triageResult: string | null;
	count: number;
};

const ANALYSIS_NODE_IDS = [
	"analysis_real_vulnerability",
	"analysis_likely_vulnerability",
	"analysis_plausible_but_unproven",
	"analysis_false_positive",
] as const;
const VERIFICATION_NODE_IDS = [
	"verify_true",
	"verify_likely",
	"verify_false",
] as const;
const TRIAGE_NODE_IDS = [
	"triage_security_issue",
	"triage_non_security",
	"triage_hardening",
	"triage_needs_review",
] as const;

type AnalysisNodeId = (typeof ANALYSIS_NODE_IDS)[number];
type VerificationNodeId = (typeof VERIFICATION_NODE_IDS)[number];
type TriageNodeId = (typeof TRIAGE_NODE_IDS)[number];
type ResultNodeId = AnalysisNodeId | VerificationNodeId | TriageNodeId;
type ResultLink = {
	source: ResultNodeId;
	target: ResultNodeId;
	count: number;
};

const RESULT_NODE_IDS = [
	...ANALYSIS_NODE_IDS,
	...VERIFICATION_NODE_IDS,
	...TRIAGE_NODE_IDS,
] as const;
const resultNodeOrder = new Map<ResultNodeId, number>(
	RESULT_NODE_IDS.map((id, index) => [id, index]),
);

const analysisNodeIds = new Set<string>(ANALYSIS_NODE_IDS);
const verificationNodeIds = new Set<string>(VERIFICATION_NODE_IDS);
const triageNodeIds = new Set<string>(TRIAGE_NODE_IDS);

const resolveNodeId = <T extends ResultNodeId>(
	prefix: "analysis" | "verify" | "triage",
	result: string | null,
	knownIds: Set<string>,
) => {
	if (!result) {
		return null;
	}
	const nodeId = `${prefix}_${result}`;
	return knownIds.has(nodeId) ? (nodeId as T) : null;
};

const titleCase = (value: string) =>
	value
		.replace(/_/g, " ")
		.replace(/\b\w/g, (character) => character.toUpperCase());

export const buildCandidateResultSummary = (
	groups: CandidateResultSummaryGroup[],
) => {
	const nodeCounts = new Map<ResultNodeId, number>();
	const links: ResultLink[] = [];
	let candidatesTotal = 0;

	const incrementNode = (nodeId: ResultNodeId | null, count: number) => {
		if (nodeId) {
			nodeCounts.set(nodeId, (nodeCounts.get(nodeId) ?? 0) + count);
		}
	};
	const incrementLink = (
		source: ResultNodeId | null,
		target: ResultNodeId | null,
		count: number,
	) => {
		if (!source || !target) {
			return;
		}
		const existing = links.find(
			(link) => link.source === source && link.target === target,
		);
		if (existing) {
			existing.count += count;
			return;
		}
		links.push({ source, target, count });
	};

	for (const group of groups) {
		const count = Number(group.count);
		if (!Number.isFinite(count) || count <= 0) {
			continue;
		}
		candidatesTotal += count;

		const analysisId = resolveNodeId<AnalysisNodeId>(
			"analysis",
			group.analysisResult,
			analysisNodeIds,
		);
		const verificationId = resolveNodeId<VerificationNodeId>(
			"verify",
			group.verificationResult,
			verificationNodeIds,
		);
		const triageId = resolveNodeId<TriageNodeId>(
			"triage",
			group.triageResult,
			triageNodeIds,
		);

		incrementNode(analysisId, count);
		incrementNode(verificationId, count);
		if (verificationId) {
			incrementNode(triageId, count);
		}
		incrementLink(analysisId, verificationId, count);
		incrementLink(verificationId, triageId, count);
	}

	const nodeCount = (id: ResultNodeId) => nodeCounts.get(id) ?? 0;
	links.sort(
		(left, right) =>
			(resultNodeOrder.get(left.source) ?? 0) -
				(resultNodeOrder.get(right.source) ?? 0) ||
			(resultNodeOrder.get(left.target) ?? 0) -
				(resultNodeOrder.get(right.target) ?? 0),
	);
	const makeNode = (
		id: ResultNodeId,
		stage: "analysis" | "verify" | "triage",
	) => ({
		id,
		stage,
		label: titleCase(id.replace(`${stage}_`, "")),
		count: nodeCount(id),
	});
	return {
		counts: {
			candidatesTotal,
			analysisPositive:
				nodeCount("analysis_real_vulnerability") +
				nodeCount("analysis_likely_vulnerability"),
			analysisReal: nodeCount("analysis_real_vulnerability"),
			analysisLikely: nodeCount("analysis_likely_vulnerability"),
			verificationTrue: nodeCount("verify_true"),
			verificationLikely: nodeCount("verify_likely"),
			verificationPositive:
				nodeCount("verify_true") + nodeCount("verify_likely"),
			triageSecurityIssue: nodeCount("triage_security_issue"),
		},
		flow: {
			nodes: [
				...ANALYSIS_NODE_IDS.map((id) => makeNode(id, "analysis")),
				...VERIFICATION_NODE_IDS.map((id) => makeNode(id, "verify")),
				...TRIAGE_NODE_IDS.map((id) => makeNode(id, "triage")),
			],
			links,
		},
	};
};
