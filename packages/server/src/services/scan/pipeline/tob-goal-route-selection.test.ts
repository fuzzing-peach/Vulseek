import assert from "node:assert/strict";
import test from "node:test";
import {
	createPipelineDefinition,
	selectDownstreamEdgesForRoute,
} from "./pipeline-definition";

const stage = (id: string) => ({
	id,
	name: id,
	run: async () =>
		({
			completion: "immediate" as const,
			rawOutput: "{}",
		}),
});

test("selectDownstreamEdgesForRoute returns all edges sharing a route key", () => {
	const hunt = stage("goal-hunt");
	const judge = stage("goal-judge");
	const surface = stage("goal-surface");
	const pipeline = createPipelineDefinition({
		name: "tob-goal-route",
		stages: [hunt, judge, surface],
		edges: [
			{
				name: "hunt-judge",
				from: hunt,
				to: judge,
				route: { key: "candidate", default: true },
			},
			{
				name: "hunt-surface",
				from: hunt,
				to: surface,
				route: { key: "candidate" },
			},
			{
				name: "hunt-exhausted",
				from: hunt,
				to: surface,
				route: { key: "exhausted" },
			},
		],
	});

	const candidate = selectDownstreamEdgesForRoute(pipeline, "goal-hunt", "candidate");
	assert.deepEqual(
		candidate.edges.map((edge) => edge.name).sort(),
		["hunt-judge", "hunt-surface"],
	);

	const exhausted = selectDownstreamEdgesForRoute(pipeline, "goal-hunt", "exhausted");
	assert.deepEqual(
		exhausted.edges.map((edge) => edge.name),
		["hunt-exhausted"],
	);
});
