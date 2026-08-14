import assert from "node:assert/strict";
import test from "node:test";
import {
	createPipelineDefinition,
	selectDownstreamEdgesForRoute,
	validatePipelineRouteConfiguration,
} from "./pipeline-definition";
import type { PipelineDefinition } from "./pipeline-definition";
import { createStageDefinition } from "./stage-definition";
import {
	loadScanPipelineDefinitions,
	type ScanPipelineDefinitions,
	type ScanPipelineEdgeConfig,
} from "./scan-pipeline-definitions";
import {
	createJsonSchemaContract,
	validateJsonSchemaContractArtifacts,
	validateStructuredOutputSchemaSource,
} from "./scan-pipeline-schema-contracts";
import {
	renderPipelineTemplate,
	transformPipelineEdgeInput,
} from "./scan-pipeline-edge-transform";
import type { PipelineContext } from "../stages/full-scan-stage.runtime";

const IDS = {
	scanJobId: "research-deterministic-fixture-job",
	trackKey: "track-preauth-boundary",
	findingId: "track-preauth-boundary:root-cause-command-execution",
	primitiveId: "primitive-command-execution",
	chainId: "chain-preauth-command-execution",
} as const;

const EXPECTED_STAGE_IDS = [
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
] as const;

const EXPECTED_ROUTES = [
	"continue",
	"finding-found",
	"blocked",
	"primitive-gap",
	"accepted",
	"runtime-retry",
	"confirmed",
] as const;

type FixtureArtifactStore = Map<string, unknown>;

const fixtureArtifacts = (...entries: Array<[string, unknown]>): FixtureArtifactStore =>
	new Map<string, unknown>(entries);

type FixtureTask = {
	stageId: string;
	input: Record<string, unknown>;
	output: Record<string, unknown>;
	artifacts: FixtureArtifactStore;
	routeKey: string | null;
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const artifactPath = (name: string) => `/task/artifacts/${name}.json`;

const taskInputArtifactPath = (name: string) => `/task/inputs/${name}.json`;

const reportPath = "/task/reports/final-report.md";

const scope = {
	attackerModel: {access: "pre-authentication"},
	trustedDomain: {name: "application request handling"},
	protectedAssets: ["command execution boundary"],
	deploymentAssumptions: ["typical production deployment"],
	rulesOfEngagement: ["source-only analysis"],
	minimumResearchDeadlineAt: "2099-01-01T00:00:00.000Z",
	successCriteria: {target: "demonstrate a complete source-to-sink chain"},
};

const surfaceMap = {
	entrypoints: [{id: "entrypoint-http", exposure: "pre-authentication"}],
	trustBoundaries: [{id: "boundary-request-to-command", from: "request", to: "command"}],
	sources: [{id: "source-request-path", kind: "attacker-input"}],
	sinks: [{id: "sink-command", kind: "command-execution"}],
	components: [{id: "component-request-router"}],
	dependencyFlows: [{from: "source-request-path", to: "sink-command"}],
	coverage: {entrypoints: 1, sinks: 1},
	openQuestions: [],
};

const track = {
	trackKey: IDS.trackKey,
	approachFamily: "input-parsing",
	researchIdea: "Trace an attacker-controlled request value across the request boundary into command execution.",
	scope: {entrypoints: ["entrypoint-http"], sinks: ["sink-command"]},
	mechanisms: ["request parsing", "authorization boundary", "sink reachability"],
	coverage: {surfaceIds: ["entrypoint-http", "sink-command"]},
	evidenceRefs: ["surface-map:entrypoint-http"],
	findingIds: [],
	nextStep: "Inspect the request-to-command data flow.",
};

const primitive = {
	primitiveId: IDS.primitiveId,
	name: "Attacker-controlled command argument",
	capability: "control a value consumed by the command sink",
	requiredInput: {source: "pre-authentication request"},
	producedCapability: {capability: "command argument control"},
	trustLevel: "attacker-controlled",
	evidenceRefs: ["evidence-command-flow"],
};

const finding = {
	findingId: IDS.findingId,
	trackKey: IDS.trackKey,
	title: "Request value reaches command execution without a boundary guard",
	description: "A request-controlled value reaches a command execution sink without the required validation boundary.",
	vulnerabilityClass: "command-injection",
	location: {
		filePath: "src/request-handler.ts",
		line: 120,
		symbol: "handleRequest",
	},
	claim: "A pre-authentication request can control an argument consumed by command execution.",
	rootCauseKey: "root-cause-command-execution",
	source: {id: "source-request-path", kind: "request parameter"},
	sink: {id: "sink-command", kind: "command execution"},
	attackerControl: "The request sender controls the source value.",
	trustBoundaryCrossings: [
		{from: "request", to: "application", guard: "missing"},
	],
	preconditions: ["The request handler is reachable before authentication."],
	evidence: [
		{
			id: "evidence-command-flow",
			kind: "code",
			summary: "The request value is passed to the command sink.",
			filePath: "src/request-handler.ts",
			line: 120,
			symbol: "handleRequest",
			observation: "The sink receives the request-derived value without a boundary validation step.",
			supports: ["root-cause-command-execution"],
			contradicts: [],
		},
	],
	quickDisproofAttempt: "Check whether an upstream guard constrains the value before the sink.",
	confidence: 0.95,
};

const chain = {
	chainId: IDS.chainId,
	chainKey: IDS.chainId,
	status: "candidate",
	steps: [
		{
			primitiveId: IDS.primitiveId,
			findingId: IDS.findingId,
			entrypoint: {id: "entrypoint-http"},
			requiredCapabilities: ["request reachability"],
			producedCapabilities: ["command argument control"],
			trustBoundaryCrossings: [{from: "request", to: "application"}],
			deploymentConditions: ["typical production deployment"],
		},
	],
	entrypoint: {id: "entrypoint-http", access: "pre-authentication"},
	requiredCapabilities: ["request reachability"],
	producedCapabilities: ["command argument control"],
	trustBoundaryCrossings: [{from: "request", to: "application"}],
	deploymentConditions: ["typical production deployment"],
	primitiveGaps: [],
	successTarget: {kind: "command-execution", target: "protected asset"},
};

const makeTrackPlanOutput = (iteration: number) => ({
	tracks: [clone(track)],
	iteration,
});

const makeTrackReviewOutput = (decision: "continue" | "finding-found" | "blocked") => ({
	trackKey: IDS.trackKey,
	decision,
	summary: decision === "continue"
		? "Continue tracing the current track."
		: "Findings owned by this track are ready for validation.",
	findingIds: decision === "finding-found" ? [IDS.findingId] : [],
	coverageGaps: [],
	nextStep: decision === "continue" ? "Inspect the next sink." : null,
	blockReason: decision === "blocked" ? "No additional source is currently reachable." : null,
	reopenCondition: null,
});

const makeDiscoveryReport = () => ({
	trackId: IDS.trackKey,
	source: {id: "source-request-path", description: "Request-controlled value"},
	transformations: [{from: "request", to: "command argument"}],
	guards: [{location: "boundary", present: false}],
	sink: {id: "sink-command", description: "Command execution"},
	reachability: {reachable: true, path: ["handleRequest", "executeCommand"]},
	attackerControl: {controlled: true, source: "request"},
	preconditions: ["The handler is reachable before authentication."],
	findingPaths: ["/task/findings/fixed-command-execution.json"],
	quickDisproofAttempt: {attempt: "search for a validation guard", result: "no effective guard found"},
	newTrackSuggestions: [],
});

const makeFindingValidationOutput = () => ({
	findingId: IDS.findingId,
	reachability: {reachable: true, path: ["request", "handleRequest", "executeCommand"]},
	controllability: {controlled: true, source: "request"},
	trustBoundaryCrossings: [{from: "request", to: "application", guard: "missing"}],
	guardAnalysis: {effective: false, rationale: "No input boundary guard was found."},
	deploymentConditions: ["typical production deployment"],
	primitive: clone(primitive),
	evidenceRefs: ["evidence-command-flow"],
	disproofResult: {attempted: true, result: "not-disproved"},
	verdict: "supported",
});

const makeFindingReviewOutput = () => ({
	findingId: IDS.findingId,
	decision: "confirmed",
	summary: "The source-to-sink path remains reachable and controllable.",
	challenges: [],
	requiredEvidence: [],
	confirmedPrimitive: clone(primitive),
});

const makeChainSynthesisOutput = () => ({
	chains: [clone(chain)],
});

const makeChainReviewOutput = (decision: "primitive-gap" | "accepted") => ({
	chainId: IDS.chainId,
	decision,
	brokenTransitions: decision === "primitive-gap" ? [{from: "request", to: "command", reason: "missing capability confirmation"}] : [],
	invalidatedFindings: [],
	invalidFindingId: null,
	requiredRevisions: decision === "primitive-gap" ? ["Confirm the command argument primitive."] : [],
});

const makeExploitValidationOutput = () => ({
	chainId: IDS.chainId,
	steps: [
		{
			primitiveId: IDS.primitiveId,
			findingId: IDS.findingId,
			result: "supported",
		},
	],
	evidenceRefs: ["evidence-command-flow"],
	executionContext: {mode: "source-only", deployment: "typical production"},
	failurePoint: null,
	successCriteriaResult: "satisfied",
	verdict: "confirmed",
});

const makeExploitReviewOutput = (decision: "runtime-retry" | "confirmed") => ({
	chainId: IDS.chainId,
	decision,
	reproducibility: {reproducible: decision === "confirmed", attempts: decision === "runtime-retry" ? 1 : 2},
	environmentAssumptions: ["typical production deployment"],
	invalidatedSteps: [],
	invalidFindingId: null,
});

const makeResearchReportOutput = () => ({
	chainId: IDS.chainId,
	reportPath,
	verdict: "confirmed",
});

const getResearchDefinitions = () => {
	const definitions = loadScanPipelineDefinitions();
	const research = definitions.pipelines.research;
	assert.ok(research, "Research pipeline must be defined");
	return {definitions, research};
};

const buildFixturePipeline = (
	definitions: ScanPipelineDefinitions,
): PipelineDefinition<PipelineContext> => {
	const research = definitions.pipelines.research;
	const stages = research.stageIds.map((stageId) => {
		const config = definitions.stages.find((stage) => stage.id === stageId);
		assert.ok(config, `Research stage ${stageId} must have a stage definition`);
		const outputSchema = config.outputSchema
			? createJsonSchemaContract({
					schemas: definitions.schemas,
					schema: config.outputSchema,
				})
			: undefined;
		return createStageDefinition<PipelineContext, unknown, unknown>({
			id: config.id,
			name: config.name,
			outputSchema,
			run: async () => ({completion: "immediate", rawOutput: "{}"}),
		});
	});
	const stagesById = new Map(stages.map((stage) => [stage.id, stage]));
	const edges = research.edges.map((edge) => {
		const from = stagesById.get(edge.from);
		const to = stagesById.get(edge.to);
		assert.ok(from, `Missing fixture source stage ${edge.from}`);
		assert.ok(to, `Missing fixture target stage ${edge.to}`);
		return {
			name: edge.name,
			from,
			to,
			route: edge.route ?? undefined,
		};
	});
	return createPipelineDefinition({
		name: research.name,
		stages,
		edges,
	}) as PipelineDefinition<PipelineContext>;
};

const getStageConfig = (
	definitions: ScanPipelineDefinitions,
	stageId: string,
) => {
	const stage = definitions.stages.find((item) => item.id === stageId);
	assert.ok(stage, `Missing stage config ${stageId}`);
	return stage;
};

const validateStageOutput = async (
	definitions: ScanPipelineDefinitions,
	stageId: string,
	output: Record<string, unknown>,
	artifacts: FixtureArtifactStore,
) => {
	const stage = getStageConfig(definitions, stageId);
	assert.ok(stage.outputSchema, `Stage ${stageId} must define an output schema`);
	const contract = createJsonSchemaContract({
		schemas: definitions.schemas,
		schema: stage.outputSchema,
	});
	validateStructuredOutputSchemaSource(contract, output);
	await validateJsonSchemaContractArtifacts(
		contract,
		output,
		async (path) => {
			assert.ok(artifacts.has(path), `Missing artifact ${path} for ${stageId}`);
			return artifacts.get(path);
		},
	);
};

const sourceArtifactValue = (
	value: unknown,
	artifacts: FixtureArtifactStore,
) => {
	assert.notEqual(value, undefined, "Required edge artifact source resolved to undefined");
	if (typeof value !== "string" || !value.startsWith("/task/")) {
		return value;
	}
	assert.ok(artifacts.has(value), `Missing source artifact ${value}`);
	return artifacts.get(value);
};

const setInputField = (
	input: Record<string, unknown>,
	field: string | undefined,
	value: string,
) => {
	if (field) {
		input[field] = value;
	}
};

const getFanOutItems = (
	edge: ScanPipelineEdgeConfig,
	stageOutput: Record<string, unknown>,
) => {
	if (edge.mode !== "fanOut") return [undefined];
	if (edge.foreach === "$.tracks[*]") {
		return stageOutput.tracks as unknown[];
	}
	if (edge.foreach === "$.chains[*]") {
		return stageOutput.chains as unknown[];
	}
	if (edge.foreach === "$.findingIds[*]") {
		return stageOutput.findingIds as unknown[];
	}
	throw new Error(`Fixture does not understand fan-out expression ${edge.foreach}`);
};

const dispatchFixtureEdge = async (input: {
	pipeline: PipelineDefinition<PipelineContext>;
	edge: ScanPipelineEdgeConfig;
	stageInput: Record<string, unknown>;
	stageOutput: Record<string, unknown>;
	artifacts: FixtureArtifactStore;
}) => {
	const selected = selectDownstreamEdgesForRoute(
		input.pipeline,
		input.edge.from,
		input.edge.route?.key ?? null,
	);
	assert.equal(selected.edges.length, 1, `Expected one edge for ${input.edge.name}`);
	assert.equal(selected.edges[0]?.name, input.edge.name);

	const nextInputs = await transformPipelineEdgeInput(
		{
			mode: input.edge.mode,
			foreach: input.edge.foreach,
			input: input.edge.input,
		},
		{
			ctx: {scanJobId: IDS.scanJobId},
			stageInput: input.stageInput,
			stageOutput: input.stageOutput,
		},
	);
	const items = getFanOutItems(input.edge, input.stageOutput);
	assert.equal(nextInputs.length, items.length, input.edge.name);

	return Promise.all(
		nextInputs.map(async (nextInput, index): Promise<FixtureTask> => {
			const childInput = clone(nextInput) as Record<string, unknown>;
			const childArtifacts: FixtureArtifactStore = new Map();
			const item = items[index];
			for (const artifact of input.edge.artifacts) {
				const rendered = await renderPipelineTemplate(artifact.from, {
					ctx: {scanJobId: IDS.scanJobId},
					stageInput: input.stageInput,
					stageOutput: input.stageOutput,
					item,
				});
				const destination = artifact.to.startsWith("/")
					? artifact.to
					: `/task/${artifact.to}`;
				if (rendered === undefined) {
					throw new Error(
						`${input.edge.name}: required edge artifact ${artifact.from} resolved to undefined`,
					);
				}
				const content = sourceArtifactValue(rendered, input.artifacts);
				if (artifact.inputField === "reviewPath") {
					assert.equal(artifact.from, "$output");
					assert.deepEqual(
						content,
						input.stageOutput,
						`${input.edge.name}: review artifact must preserve the complete stage output`,
					);
					assert.match(
						destination,
						/^\/task\/inputs\/(track|finding|chain|exploit)-review\.json$/,
						`${input.edge.name}: unexpected review artifact destination`,
					);
				}
				if (artifact.inputField === "validationPath") {
					assert.equal(artifact.from, "$output");
					assert.deepEqual(
						content,
						input.stageOutput,
						`${input.edge.name}: validation artifact must preserve the complete stage output`,
					);
					assert.match(
						destination,
						/^\/task\/inputs\/(finding|exploit)-validation\.json$/,
						`${input.edge.name}: unexpected validation artifact destination`,
					);
				}
				childArtifacts.set(destination, clone(content));
				setInputField(childInput, artifact.inputField, destination);
			}
			return {
				stageId: input.edge.to,
				input: childInput,
				output: {},
				artifacts: childArtifacts,
				routeKey: null,
			};
		}),
	);
};

test("research fixture traverses every stage and route to the final report without an LLM", async () => {
	const {definitions, research} = getResearchDefinitions();
	const pipeline = buildFixturePipeline(definitions);
	validatePipelineRouteConfiguration(pipeline);

	assert.deepEqual(research.stageIds, EXPECTED_STAGE_IDS);
	const configuredRouteKeys = new Set(
		research.edges
			.filter((edge) => edge.route)
			.map((edge) => edge.route!.key),
	);
	for (const routeKey of EXPECTED_ROUTES) {
		assert.ok(
			configuredRouteKeys.has(routeKey),
			`Research YAML must configure the fixture route ${routeKey}`,
		);
	}

	const visitedStages = new Set<string>();
	const visitedRoutes = new Set<string>();
	const tasks: FixtureTask[] = [];
	const effectMetadata: Array<{ stageId: string; routeKey: string | null }> = [];
	const llmCalls = 0;

	const run = async (input: {
		stageId: string;
		stageInput: Record<string, unknown>;
		stageOutput: Record<string, unknown>;
		inputArtifacts?: FixtureArtifactStore;
		producedArtifacts?: FixtureArtifactStore;
		routeKey?: string | null;
	}) => {
		const artifacts = new Map(input.inputArtifacts ?? []);
		for (const [path, value] of input.producedArtifacts ?? []) {
			artifacts.set(path, clone(value));
		}
		await validateStageOutput(definitions, input.stageId, input.stageOutput, artifacts);
		visitedStages.add(input.stageId);
		const routeKey = input.routeKey ?? null;
		if (routeKey) visitedRoutes.add(routeKey);
		// Model the terminal lifecycle callback receiving the parsed route metadata.
		effectMetadata.push({ stageId: input.stageId, routeKey });
		const task: FixtureTask = {
			stageId: input.stageId,
			input: input.stageInput,
			output: input.stageOutput,
			artifacts,
			routeKey,
		};
		tasks.push(task);
		return task;
	};

	const dispatch = async (task: FixtureTask, edgeName: string, routeKey: string | null = null) => {
		const edge = research.edges.find(
			(item) => item.name === edgeName && item.from === task.stageId,
		);
		assert.ok(edge, `Missing edge ${edgeName}`);
		if (routeKey) {
			assert.equal(edge.route?.key, routeKey);
			visitedRoutes.add(routeKey);
		}
		return dispatchFixtureEdge({
			pipeline,
			edge,
			stageInput: task.input,
			stageOutput: task.output,
			artifacts: task.artifacts,
		});
	};

	const scopeTask = await run({
		stageId: "research-scope",
		stageInput: {},
		stageOutput: {scopePath: artifactPath("scope")},
		producedArtifacts: fixtureArtifacts([artifactPath("scope"), scope]),
	});
	const [surfaceInput] = await dispatch(scopeTask, "research-scope-to-surface-map");
	assert.ok(surfaceInput);

	const surfaceTask = await run({
		stageId: "surface-map",
		stageInput: surfaceInput.input,
		stageOutput: {surfaceMapPath: artifactPath("surface-map")},
		inputArtifacts: surfaceInput.artifacts,
		producedArtifacts: fixtureArtifacts([artifactPath("surface-map"), surfaceMap]),
	});
	const [firstPlanInput] = await dispatch(surfaceTask, "surface-map-to-track-plan");
	assert.ok(firstPlanInput);

	const firstPlanTask = await run({
		stageId: "track-plan",
		stageInput: firstPlanInput.input,
		stageOutput: makeTrackPlanOutput(1),
		inputArtifacts: firstPlanInput.artifacts,
	});
	const [firstDiscoveryInput] = await dispatch(firstPlanTask, "track-plan-to-vulnerability-discovery");
	assert.ok(firstDiscoveryInput);

	const firstDiscoveryTask = await run({
		stageId: "vulnerability-discovery",
		stageInput: firstDiscoveryInput.input,
		stageOutput: {
			trackId: IDS.trackKey,
			discoveryReportPath: artifactPath("discovery-report-1"),
		},
		inputArtifacts: firstDiscoveryInput.artifacts,
		producedArtifacts: fixtureArtifacts(
			[artifactPath("discovery-report-1"), makeDiscoveryReport()],
			["/task/findings/fixed-command-execution.json", finding],
		),
	});
	const [continueInput] = await dispatch(firstDiscoveryTask, "vulnerability-discovery-to-track-review");
	assert.ok(continueInput);

	const continueReviewTask = await run({
		stageId: "track-review",
		stageInput: continueInput.input,
		stageOutput: makeTrackReviewOutput("continue"),
		inputArtifacts: continueInput.artifacts,
		routeKey: "continue",
	});
	const [continuedPlanInput] = await dispatch(continueReviewTask, "track-review-to-track-plan", "continue");
	assert.ok(continuedPlanInput);
	assert.equal(continuedPlanInput.input.reviewPath, taskInputArtifactPath("track-review"));

	const blockedReviewTask = await run({
		stageId: "track-review",
		stageInput: continueInput.input,
		stageOutput: makeTrackReviewOutput("blocked"),
		inputArtifacts: continueInput.artifacts,
		routeKey: "blocked",
	});
	const [blockedPlanInput] = await dispatch(blockedReviewTask, "track-review-blocked-to-track-plan", "blocked");
	assert.ok(blockedPlanInput);

	const continuedPlanTask = await run({
		stageId: "track-plan",
		stageInput: continuedPlanInput.input,
		stageOutput: makeTrackPlanOutput(2),
		inputArtifacts: continuedPlanInput.artifacts,
	});
	const [continuedDiscoveryInput] = await dispatch(continuedPlanTask, "track-plan-to-vulnerability-discovery");
	assert.ok(continuedDiscoveryInput);

	const continuedDiscoveryTask = await run({
		stageId: "vulnerability-discovery",
		stageInput: continuedDiscoveryInput.input,
		stageOutput: {
			trackId: IDS.trackKey,
			discoveryReportPath: artifactPath("discovery-report-2"),
		},
		inputArtifacts: continuedDiscoveryInput.artifacts,
		producedArtifacts: fixtureArtifacts(
				[artifactPath("discovery-report-2"), makeDiscoveryReport()],
				["/task/findings/fixed-command-execution.json", finding],
			),
	});
	const [findingInput] = await dispatch(continuedDiscoveryTask, "vulnerability-discovery-to-track-review");
	assert.ok(findingInput);

	const findingReviewTask = await run({
		stageId: "track-review",
		stageInput: findingInput.input,
		stageOutput: makeTrackReviewOutput("finding-found"),
		inputArtifacts: findingInput.artifacts,
		routeKey: "finding-found",
	});
	assert.deepEqual(
		effectMetadata.find(
			({ stageId, routeKey }) =>
				stageId === "track-review" && routeKey === "finding-found",
		),
		{ stageId: "track-review", routeKey: "finding-found" },
	);
	const [validationInput] = await dispatch(findingReviewTask, "track-review-to-finding-validation", "finding-found");
	assert.ok(validationInput);
	assert.equal(validationInput.input.findingId, IDS.findingId);

	const findingValidationTask = await run({
		stageId: "finding-validation",
		stageInput: validationInput.input,
		stageOutput: makeFindingValidationOutput(),
		inputArtifacts: validationInput.artifacts,
	});
	const [reviewInput] = await dispatch(findingValidationTask, "finding-validation-to-finding-review");
	assert.ok(reviewInput);

	const findingReviewResultTask = await run({
		stageId: "finding-review",
		stageInput: reviewInput.input,
		stageOutput: makeFindingReviewOutput(),
		inputArtifacts: reviewInput.artifacts,
	});
	const [chainSynthesisInput] = await dispatch(findingReviewResultTask, "finding-review-to-chain-synthesis", "confirmed");
	assert.ok(chainSynthesisInput);

	const firstChainSynthesisTask = await run({
		stageId: "chain-synthesis",
		stageInput: chainSynthesisInput.input,
		stageOutput: makeChainSynthesisOutput(),
		inputArtifacts: chainSynthesisInput.artifacts,
	});
	const [primitiveGapInput] = await dispatch(firstChainSynthesisTask, "chain-synthesis-to-chain-review");
	assert.ok(primitiveGapInput);

	const primitiveGapReviewTask = await run({
		stageId: "chain-review",
		stageInput: primitiveGapInput.input,
		stageOutput: makeChainReviewOutput("primitive-gap"),
		inputArtifacts: primitiveGapInput.artifacts,
		routeKey: "primitive-gap",
	});
	const [gapPlanInput] = await dispatch(primitiveGapReviewTask, "chain-review-to-track-plan", "primitive-gap");
	assert.ok(gapPlanInput);

	const gapPlanTask = await run({
		stageId: "track-plan",
		stageInput: gapPlanInput.input,
		stageOutput: makeTrackPlanOutput(3),
		inputArtifacts: gapPlanInput.artifacts,
	});
	const [gapDiscoveryInput] = await dispatch(gapPlanTask, "track-plan-to-vulnerability-discovery");
	assert.ok(gapDiscoveryInput);

	const gapDiscoveryTask = await run({
		stageId: "vulnerability-discovery",
		stageInput: gapDiscoveryInput.input,
		stageOutput: {
			trackId: IDS.trackKey,
			discoveryReportPath: artifactPath("discovery-report-3"),
		},
		inputArtifacts: gapDiscoveryInput.artifacts,
		producedArtifacts: fixtureArtifacts(
				[artifactPath("discovery-report-3"), makeDiscoveryReport()],
				["/task/findings/fixed-command-execution.json", finding],
			),
	});
	const [secondFindingInput] = await dispatch(gapDiscoveryTask, "vulnerability-discovery-to-track-review");
	assert.ok(secondFindingInput);

	const secondFindingReviewTask = await run({
		stageId: "track-review",
		stageInput: secondFindingInput.input,
		stageOutput: makeTrackReviewOutput("finding-found"),
		inputArtifacts: secondFindingInput.artifacts,
		routeKey: "finding-found",
	});
	const [secondValidationInput] = await dispatch(secondFindingReviewTask, "track-review-to-finding-validation", "finding-found");
	assert.ok(secondValidationInput);

	const secondFindingValidationTask = await run({
		stageId: "finding-validation",
		stageInput: secondValidationInput.input,
		stageOutput: makeFindingValidationOutput(),
		inputArtifacts: secondValidationInput.artifacts,
	});
	const [secondReviewInput] = await dispatch(secondFindingValidationTask, "finding-validation-to-finding-review");
	assert.ok(secondReviewInput);

	const secondFindingReviewResultTask = await run({
		stageId: "finding-review",
		stageInput: secondReviewInput.input,
		stageOutput: makeFindingReviewOutput(),
		inputArtifacts: secondReviewInput.artifacts,
	});
	const [secondChainSynthesisInput] = await dispatch(secondFindingReviewResultTask, "finding-review-to-chain-synthesis", "confirmed");
	assert.ok(secondChainSynthesisInput);

	const secondChainSynthesisTask = await run({
		stageId: "chain-synthesis",
		stageInput: secondChainSynthesisInput.input,
		stageOutput: makeChainSynthesisOutput(),
		inputArtifacts: secondChainSynthesisInput.artifacts,
	});
	const [acceptedChainReviewInput] = await dispatch(secondChainSynthesisTask, "chain-synthesis-to-chain-review");
	assert.ok(acceptedChainReviewInput);

	const acceptedChainReviewTask = await run({
		stageId: "chain-review",
		stageInput: acceptedChainReviewInput.input,
		stageOutput: makeChainReviewOutput("accepted"),
		inputArtifacts: acceptedChainReviewInput.artifacts,
		routeKey: "accepted",
	});
	const [firstExploitValidationInput] = await dispatch(acceptedChainReviewTask, "chain-review-to-exploit-validation", "accepted");
	assert.ok(firstExploitValidationInput);

	const firstExploitValidationTask = await run({
		stageId: "exploit-validation",
		stageInput: firstExploitValidationInput.input,
		stageOutput: makeExploitValidationOutput(),
		inputArtifacts: firstExploitValidationInput.artifacts,
	});
	const [runtimeRetryInput] = await dispatch(firstExploitValidationTask, "exploit-validation-to-exploit-review");
	assert.ok(runtimeRetryInput);

	const runtimeRetryReviewTask = await run({
		stageId: "exploit-review",
		stageInput: runtimeRetryInput.input,
		stageOutput: makeExploitReviewOutput("runtime-retry"),
		inputArtifacts: runtimeRetryInput.artifacts,
		routeKey: "runtime-retry",
	});
	const [retryValidationInput] = await dispatch(runtimeRetryReviewTask, "exploit-review-to-exploit-validation", "runtime-retry");
	assert.ok(retryValidationInput);

	const retryValidationTask = await run({
		stageId: "exploit-validation",
		stageInput: retryValidationInput.input,
		stageOutput: makeExploitValidationOutput(),
		inputArtifacts: retryValidationInput.artifacts,
	});
	const [confirmedReviewInput] = await dispatch(retryValidationTask, "exploit-validation-to-exploit-review");
	assert.ok(confirmedReviewInput);

	const confirmedReviewTask = await run({
		stageId: "exploit-review",
		stageInput: confirmedReviewInput.input,
		stageOutput: makeExploitReviewOutput("confirmed"),
		inputArtifacts: confirmedReviewInput.artifacts,
		routeKey: "confirmed",
	});
	const [reportInput] = await dispatch(confirmedReviewTask, "exploit-review-to-research-report", "confirmed");
	assert.ok(reportInput);

	const reportTask = await run({
		stageId: "research-report",
		stageInput: reportInput.input,
		stageOutput: makeResearchReportOutput(),
		inputArtifacts: reportInput.artifacts,
		producedArtifacts: fixtureArtifacts([reportPath, "deterministic final report"]),
	});

	assert.equal(reportTask.stageId, "research-report");
	assert.equal(reportTask.output.chainId, IDS.chainId);
	assert.equal(reportTask.output.verdict, "confirmed");
	assert.deepEqual([...visitedStages].sort(), [...EXPECTED_STAGE_IDS].sort());
	assert.deepEqual([...visitedRoutes].sort(), [...EXPECTED_ROUTES].sort());
	assert.equal(tasks.some((task) => task.output.findingId === IDS.findingId), true);
	assert.equal(
		tasks.some(
			(task) =>
				(task.output.primitive as { primitiveId?: unknown } | undefined)
					?.primitiveId === IDS.primitiveId,
		),
		true,
	);
	assert.equal(
		tasks.some(
			(task) =>
				(
					(task.output.chains as Array<{ chainId?: unknown }> | undefined)?.[0]
				)?.chainId === IDS.chainId,
		),
		true,
	);
	assert.equal(llmCalls, 0);
});
