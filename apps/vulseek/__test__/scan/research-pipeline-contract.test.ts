import { describe, expect, it } from "vitest";
import { loadScanPipelineDefinitions } from "../../../../packages/server/src/services/scan/pipeline/scan-pipeline-definitions";
import {
	createJsonSchemaContract,
	validateJsonSchemaContract,
	validateJsonSchemaContractArtifacts,
} from "../../../../packages/server/src/services/scan/pipeline/scan-pipeline-schema-contracts";

const definitions = loadScanPipelineDefinitions();
const research = definitions.pipelines.research;

const expectedStages = [
	"research-scope",
	"surface-map",
	"track-plan",
	"vulnerability-discovery",
	"track-review",
	"finding-validation",
	"finding-review",
	"chain-synthesis",
	"chain-review",
	"exploit-validation",
	"exploit-review",
	"research-report",
];

const expectedRoutes = {
	"track-review-to-track-plan": "continue",
	"track-review-to-surface-map": "new-surface",
	"track-review-to-finding-validation": "finding-found",
	"track-review-exhausted-to-track-plan": "exhausted",
	"track-review-blocked-to-track-plan": "blocked",
	"finding-review-to-finding-validation": "needs-more-evidence",
	"finding-review-to-track-plan": "false-positive",
	"finding-review-to-chain-synthesis": "confirmed",
	"chain-review-to-chain-synthesis": "revise-chain",
	"chain-review-to-track-plan": "primitive-gap",
	"chain-review-to-finding-validation": "invalid-finding",
	"chain-review-to-exploit-validation": "accepted",
	"exploit-review-to-exploit-validation": "runtime-retry",
	"exploit-review-to-chain-synthesis": "chain-revision",
	"exploit-review-to-finding-validation": "finding-revalidation",
	"exploit-review-to-research-report": "confirmed",
};

const stageOutputFixtures: Record<string, unknown> = {
	"research-scope": { scopePath: "/task/scope.json" },
	"surface-map": { surfaceMapPath: "/task/surface-map.json" },
	"track-plan": {
		tracks: [
			{
				trackKey: "track-a",
				approachFamily: "input-parsing",
				researchIdea:
					"Trace attacker-controlled parser input to a security boundary.",
				scope: { entrypoints: ["public-route"] },
				mechanisms: ["parser-to-dispatch"],
			},
		],
		iteration: 0,
	},
	"vulnerability-discovery": {
		trackId: "track-a",
		discoveryReportPath: "/task/discovery.json",
	},
	"track-review": {
		trackKey: "track-a",
		decision: "continue",
		summary: "Continue tracing the current track.",
		findingIds: [],
		coverageGaps: [],
		nextStep: "Inspect the next sink.",
		blockReason: null,
		reopenCondition: null,
	},
	"finding-validation": {
		findingId: "track-a:root-cause-a",
		reachability: {},
		controllability: {},
		trustBoundaryCrossings: [],
		guardAnalysis: {},
		deploymentConditions: [],
		primitive: {
			primitiveId: "primitive-a",
			name: "controlled parser output",
			capability: "controlled-dispatch",
			requiredInput: { kind: "attacker-input" },
			producedCapability: { kind: "route-selection" },
			trustLevel: "untrusted-to-internal",
			evidenceRefs: ["evidence-a"],
		},
		evidenceRefs: [],
		disproofResult: {},
		verdict: "confirmed",
	},
	"finding-review": {
		findingId: "track-a:root-cause-a",
		decision: "confirmed",
		summary: "Independent review confirmed the source-to-sink path.",
		challenges: [],
		requiredEvidence: [],
		confirmedPrimitive: {
			primitiveId: "primitive-a",
			name: "controlled parser output",
			capability: "controlled-dispatch",
			requiredInput: { kind: "attacker-input" },
			producedCapability: { kind: "route-selection" },
			trustLevel: "untrusted-to-internal",
			evidenceRefs: ["evidence-a"],
		},
	},
	"chain-synthesis": {
		chains: [
			{
				chainId: "chain-a",
				chainKey: "chain-a",
				status: "candidate",
				steps: [{ primitiveId: "primitive-a" }],
				entrypoint: { kind: "public-route" },
				requiredCapabilities: ["controlled-parser-input"],
				producedCapabilities: ["controlled-dispatch"],
				trustBoundaryCrossings: [],
				deploymentConditions: [],
				primitiveGaps: [],
				successTarget: { kind: "protected-operation" },
			},
		],
	},
	"chain-review": {
		chainId: "chain-a",
		decision: "accepted",
		brokenTransitions: [],
		invalidatedFindings: [],
		invalidFindingId: null,
		requiredRevisions: [],
	},
	"exploit-validation": {
		chainId: "chain-a",
		steps: [],
		evidenceRefs: [],
		executionContext: {},
		failurePoint: null,
		successCriteriaResult: "not_attempted",
		verdict: "inconclusive",
	},
	"exploit-review": {
		chainId: "chain-a",
		decision: "confirmed",
		reproducibility: {},
		environmentAssumptions: [],
		invalidatedSteps: [],
		invalidFindingId: null,
	},
	"research-report": {
		chainId: "chain-a",
		reportPath: "/task/reports/final-report.md",
		verdict: "inconclusive",
	},
};

const reviewOutputFixtures: Record<string, unknown> = {
	"track-review": {
		trackKey: "track-a",
		decision: "continue",
		summary: "Continue tracing the current track.",
		findingIds: [],
		coverageGaps: [],
		nextStep: "Inspect the next sink.",
		blockReason: null,
		reopenCondition: null,
	},
	"chain-review": {
		chainId: "chain-a",
		decision: "accepted",
		brokenTransitions: [],
		invalidatedFindings: [],
		invalidFindingId: null,
		requiredRevisions: [],
	},
	"exploit-review": {
		chainId: "chain-a",
		decision: "confirmed",
		reproducibility: {},
		environmentAssumptions: [],
		invalidatedSteps: [],
		invalidFindingId: null,
	},
};

describe("research pipeline contract", () => {
	it("accepts the canonical Finding and rejects Candidate-shaped objects", () => {
		const contract = createJsonSchemaContract({
			schemas: definitions.schemas,
			schema: { $ref: "#/schemas/Finding" },
		});
		const finding = {
			findingId: "track-a:root-cause-a",
			trackKey: "track-a",
			title: "Unvalidated route interpretation",
			description: "A source-backed finding.",
			vulnerabilityClass: "request-routing-confusion",
			location: { filePath: "src/server.ts", line: 42, symbol: "dispatch" },
			claim: "The attacker controls the route interpretation.",
			rootCauseKey: "route-path-only",
			source: { kind: "request" },
			sink: { kind: "dispatch" },
			attackerControl: "The request path is attacker controlled.",
			trustBoundaryCrossings: [],
			preconditions: ["The endpoint is reachable."],
			evidence: [
				{
					id: "evidence-1",
					kind: "code",
					summary: "Route is rebuilt from path.",
					filePath: "src/server.ts",
					line: 42,
					symbol: "dispatch",
					observation: "The route is reconstructed before dispatch.",
					supports: ["route-path-only"],
					contradicts: [],
				},
			],
			quickDisproofAttempt: "Core dispatch behavior was checked.",
			confidence: 0.7,
		};
		validateJsonSchemaContract(contract, finding);
		expect(() =>
			validateJsonSchemaContract(contract, {
				...finding,
				candidateId: "old-id",
			}),
		).toThrow(/JSON Schema validation failed/);
	});

	it("requires Discovery Reports to reference strict Finding artifacts", async () => {
		const contract = createJsonSchemaContract({
			schemas: definitions.schemas,
			schema: { $ref: "#/schemas/DiscoveryManifest" },
		});
		const output = {
			trackId: "track-a",
			discoveryReportPath: "/task/discovery-report.json",
		};
		const finding = {
			findingId: "track-a:root-cause-a",
			trackKey: "track-a",
			title: "Unvalidated route interpretation",
			description: "A source-backed finding.",
			vulnerabilityClass: "request-routing-confusion",
			location: { filePath: "src/server.ts", line: 42, symbol: "dispatch" },
			claim: "The attacker controls the route interpretation.",
			rootCauseKey: "root-cause-a",
			source: { kind: "request" },
			sink: { kind: "dispatch" },
			attackerControl: "The request path is attacker controlled.",
			trustBoundaryCrossings: [],
			preconditions: ["The endpoint is reachable."],
			evidence: [
				{
					id: "evidence-1",
					kind: "code",
					summary: "Route is rebuilt from path.",
					filePath: "src/server.ts",
					line: 42,
					symbol: "dispatch",
					observation: "The route is reconstructed before dispatch.",
					supports: ["root-cause-a"],
					contradicts: [],
				},
			],
			quickDisproofAttempt: "Core dispatch behavior was checked.",
			confidence: 0.7,
		};
		const artifacts = new Map<string, unknown>([
			[
				"/task/discovery-report.json",
				{
					trackId: "track-a",
					source: {},
					transformations: [],
					guards: [],
					sink: {},
					reachability: {},
					attackerControl: {},
					preconditions: [],
					findingPaths: ["/task/findings/root-cause-a.json"],
					quickDisproofAttempt: {},
					newTrackSuggestions: [],
				},
			],
			["/task/findings/root-cause-a.json", finding],
		]);

		validateJsonSchemaContract(contract, output);
		await validateJsonSchemaContractArtifacts(contract, output, async (path) =>
			artifacts.get(path),
		);

		artifacts.set("/task/discovery-report.json", {
			trackId: "track-a",
			source: {},
			transformations: [],
			guards: [],
			sink: {},
			reachability: {},
			attackerControl: {},
			preconditions: [],
			findings: [finding],
			quickDisproofAttempt: {},
			newTrackSuggestions: [],
		});
		await expect(
			validateJsonSchemaContractArtifacts(contract, output, async (path) =>
				artifacts.get(path),
			),
		).rejects.toThrow(/JSON Schema validation failed/);
	});

	it("requires Discovery Finding IDs to use one stable colon separator", () => {
		const discovery = definitions.stages.find(
			(stage) => stage.id === "vulnerability-discovery",
		);
		const prompt = discovery?.runtimeConfig?.prompt ?? "";
		expect(prompt).toContain("exactly `trackKey:rootCauseKey`");
		expect(prompt).toContain("no `::`");
	});

	it("defines the complete ordered twelve-stage pipeline", () => {
		expect(research?.rootStageId).toBe("research-scope");
		expect(research?.stageIds).toEqual(expectedStages);
	});

	it("keeps every research stage non-persistent and container-reusable", () => {
		for (const stageId of expectedStages) {
			const stage = definitions.stages.find((item) => item.id === stageId);
			expect(stage, stageId).toBeDefined();
			expect(stage?.runtimeConfig?.persistent, stageId).toBe(false);
			expect(stage?.runtimeConfig?.reuseContainer, stageId).toBe(true);
		}
	});

	it("moves Research Registry writes into the Agent skill", () => {
		const writeStages = new Set([
			"research-scope",
			"track-plan",
			"vulnerability-discovery",
			"track-review",
			"finding-validation",
			"finding-review",
			"chain-synthesis",
			"chain-review",
			"exploit-validation",
			"exploit-review",
			"research-report",
		]);
		for (const stageId of expectedStages) {
			const stage = definitions.stages.find((item) => item.id === stageId);
			expect(stage?.effects ?? [], stageId).not.toContainEqual(
				expect.objectContaining({ type: "research-registry" }),
			);
			const prompt = stage?.runtimeConfig?.prompt ?? "";
			if (writeStages.has(stageId)) {
				expect(stage?.runtimeConfig?.skills ?? [], stageId).toContain(
					"research-db",
				);
				expect(prompt, stageId).toMatch(/research-db|research database/i);
				expect(prompt, stageId).toMatch(/revision|conflict/i);
			}
			expect(prompt).not.toMatch(/apply-batch|idempotencyKey|append-.*event/i);
		}
	});

	it("preserves every adaptive review route", () => {
		const routes = Object.fromEntries(
			(research?.edges ?? [])
				.filter((edge) => edge.route)
				.map((edge) => [edge.name, edge.route?.key]),
		);
		expect(routes).toMatchObject(expectedRoutes);
	});

	it("walks a deterministic finding-to-report path through all twelve stages", () => {
		const choose = (stageId: string, routeKey: string | null = null) => {
			const edges = research.edges.filter((edge) => edge.from === stageId);
			const routed = edges.filter((edge) => edge.route);
			if (routed.length === 0) return edges.map((edge) => edge.to);
			const edge =
				routed.find((candidate) => candidate.route?.key === routeKey) ??
				routed.find((candidate) => candidate.route?.default);
			expect(edge, `${stageId}:${routeKey}`).toBeDefined();
			return edge ? [edge.to] : [];
		};
		const path = [
			"research-scope",
			...choose("research-scope"),
			...choose("surface-map"),
			...choose("track-plan"),
			...choose("vulnerability-discovery"),
			...choose("track-review", "finding-found"),
			...choose("finding-validation"),
			...choose("finding-review", "confirmed"),
			...choose("chain-synthesis"),
			...choose("chain-review", "accepted"),
			...choose("exploit-validation"),
			...choose("exploit-review", "confirmed"),
		];

		expect(new Set(path)).toEqual(new Set(expectedStages));
		expect(path.at(-1)).toBe("research-report");
	});

	it("keeps review output structured and pipeline-owned", () => {
		for (const [stageId, output] of Object.entries(reviewOutputFixtures)) {
			const stage = definitions.stages.find((item) => item.id === stageId);
			const contract = createJsonSchemaContract({
				schemas: definitions.schemas,
				schema: stage?.outputSchema ?? {},
			});
			validateJsonSchemaContract(contract, output);
			expect(() =>
				validateJsonSchemaContract(contract, {
					...(output as Record<string, unknown>),
					reviewPath: "Continue planning in natural language",
				}),
			).toThrow(/JSON Schema validation failed/);
		}

		const reviewEdges = (research?.edges ?? []).filter(
			(edge) =>
				["track-review", "chain-review", "exploit-review"].includes(
					edge.from,
				) &&
				edge.artifacts.some((artifact) => artifact.inputField === "reviewPath"),
		);
		const allReviewEdges = (research?.edges ?? []).filter((edge) =>
			["track-review", "chain-review", "exploit-review"].includes(edge.from),
		);
		expect(allReviewEdges.length).toBeGreaterThan(0);
		for (const edge of allReviewEdges) {
			expect(edge.artifacts, edge.name).toContainEqual(
				expect.objectContaining({
					from: "$output",
					inputField: "reviewPath",
				}),
			);
			const expectedArtifact =
				edge.from === "track-review"
					? "inputs/track-review.json"
					: edge.from === "chain-review"
						? "inputs/chain-review.json"
						: "inputs/exploit-review.json";
			expect(edge.artifacts, edge.name).toContainEqual(
				expect.objectContaining({
					from: "$output",
					to: expectedArtifact,
					inputField: "reviewPath",
				}),
			);
		}
		for (const edge of reviewEdges) {
			expect(edge.input).not.toHaveProperty("reviewPath");
			expect(edge.artifacts).toContainEqual(
				expect.objectContaining({
					from: "$output",
					inputField: "reviewPath",
				}),
			);
		}
	});

	it("requires artifact-backed outputs for every report-producing stage", async () => {
		for (const [stageId, output] of Object.entries(stageOutputFixtures)) {
			const stage = definitions.stages.find((item) => item.id === stageId);
			const outputSchema = stage?.outputSchema;
			expect(outputSchema, stageId).toBeDefined();
			const contract = createJsonSchemaContract({
				schemas: definitions.schemas,
				schema: outputSchema ?? {},
			});
			validateJsonSchemaContract(contract, output);
			await validateJsonSchemaContractArtifacts(
				contract,
				output,
				async (path: string) => {
					expect(path).toMatch(/^\/task\//);
					if (stageId === "vulnerability-discovery") {
						return {
							trackId: "track-a",
							source: {},
							transformations: [],
							guards: [],
							sink: {},
							reachability: {},
							attackerControl: {},
							preconditions: [],
							findingPaths: [],
							quickDisproofAttempt: {},
							newTrackSuggestions: [],
						};
					}
					return {};
				},
			);
		}
	});

	it("marks the final report as required", () => {
		const report = definitions.stages.find(
			(stage) => stage.id === "research-report",
		);
		expect(report?.report).toEqual({
			path: "reports/final-report.md",
			required: true,
		});
	});

	it("requires stable nested Registry entities and one Chain ID across deep stages", () => {
		const track = {
			trackKey: "track-a",
			approachFamily: "input-parsing",
			researchIdea:
				"Trace attacker-controlled parser input to a security boundary.",
			scope: { entrypoints: ["public-route"] },
			mechanisms: ["parser-to-dispatch"],
		};
		const primitive = {
			primitiveId: "primitive-a",
			name: "controlled parser output",
			capability: "controlled-dispatch",
			requiredInput: { kind: "attacker-input" },
			producedCapability: { kind: "route-selection" },
			trustLevel: "untrusted-to-internal",
			evidenceRefs: ["evidence-a"],
		};
		const chain = {
			chainId: "chain-a",
			chainKey: "chain-a",
			status: "candidate",
			steps: [{ primitiveId: primitive.primitiveId }],
			entrypoint: { kind: "public-route" },
			requiredCapabilities: ["controlled-parser-input"],
			producedCapabilities: ["controlled-dispatch"],
			trustBoundaryCrossings: [],
			deploymentConditions: [],
			primitiveGaps: [],
			successTarget: { kind: "protected-operation" },
		};

		const contractFor = (stageId: string) => {
			const stage = definitions.stages.find((item) => item.id === stageId);
			return createJsonSchemaContract({
				schemas: definitions.schemas,
				schema: stage?.outputSchema ?? {},
			});
		};

		validateJsonSchemaContract(contractFor("track-plan"), {
			tracks: [track],
			iteration: 0,
		});
		expect(() =>
			validateJsonSchemaContract(contractFor("track-plan"), {
				tracks: [{ ...track, trackKey: undefined }],
				iteration: 0,
			}),
		).toThrow(/JSON Schema validation failed/);

		validateJsonSchemaContract(contractFor("finding-validation"), {
			...(stageOutputFixtures["finding-validation"] as Record<string, unknown>),
			primitive,
		});
		validateJsonSchemaContract(contractFor("finding-review"), {
			...(stageOutputFixtures["finding-review"] as Record<string, unknown>),
			confirmedPrimitive: primitive,
		});
		validateJsonSchemaContract(contractFor("chain-synthesis"), {
			chains: [chain],
		});
		expect(() =>
			validateJsonSchemaContract(contractFor("chain-synthesis"), {
				chains: [{ ...chain, steps: [{}] }],
			}),
		).toThrow(/JSON Schema validation failed/);
		expect(() =>
			validateJsonSchemaContract(contractFor("chain-synthesis"), {
				chains: [{ ...chain, chainId: undefined, id: "chain-a" }],
			}),
		).toThrow(/JSON Schema validation failed/);

		for (const stageId of [
			"chain-review",
			"exploit-validation",
			"exploit-review",
			"research-report",
		]) {
			const output = {
				...(stageOutputFixtures[stageId] as Record<string, unknown>),
				chainId: chain.chainId,
			};
			validateJsonSchemaContract(contractFor(stageId), output);
		}
	});
});
