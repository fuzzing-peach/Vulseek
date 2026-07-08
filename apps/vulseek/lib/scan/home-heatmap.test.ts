import assert from "node:assert/strict";
import test from "node:test";
import {
	buildHomeHeatmapDays,
	groupHomeHeatmapWeeks,
	heatmapLevelForTokens,
} from "./home-heatmap";

test("heatmapLevelForTokens buckets token pressure into five levels", () => {
	assert.equal(heatmapLevelForTokens(0, 100), 0);
	assert.equal(heatmapLevelForTokens(10, 100), 1);
	assert.equal(heatmapLevelForTokens(50, 100), 2);
	assert.equal(heatmapLevelForTokens(75, 100), 3);
	assert.equal(heatmapLevelForTokens(76, 100), 4);
});

test("buildHomeHeatmapDays fills calendar weeks from Monday to Sunday", () => {
	const days = buildHomeHeatmapDays({
		dayCount: 8,
		now: new Date("2026-07-08T12:00:00.000Z"),
		days: [
			{
				date: "2026-07-07",
				totalTokens: 100,
				scanJobCount: 2,
				taskCount: 4,
				candidateCount: 3,
				securityIssueCount: 1,
			},
		],
	});

	assert.equal(days.length, 10);
	assert.equal(days[0]?.date, "2026-06-29");
	assert.equal(days[0]?.dayIndex, 0);
	assert.equal(days[6]?.date, "2026-07-05");
	assert.equal(days[6]?.dayIndex, 6);
	assert.equal(days[8]?.date, "2026-07-07");
	assert.equal(days[8]?.level, 4);
	assert.equal(days[9]?.date, "2026-07-08");
	assert.deepEqual(
		days.slice(0, 7).map((day) => [day.weekIndex, day.dayIndex]),
		[
			[0, 0],
			[0, 1],
			[0, 2],
			[0, 3],
			[0, 4],
			[0, 5],
			[0, 6],
		],
	);
	assert.equal(days[1]?.scanJobCount, 0);
});

test("groupHomeHeatmapWeeks returns seven-day columns", () => {
	const weeks = groupHomeHeatmapWeeks(
		buildHomeHeatmapDays({
			dayCount: 8,
			now: new Date("2026-07-08T12:00:00.000Z"),
			days: [],
		}),
	);

	assert.equal(weeks.length, 2);
	assert.equal(weeks[0]?.length, 7);
	assert.equal(weeks[1]?.length, 3);
	assert.equal(weeks[0]?.[0]?.date, "2026-06-29");
	assert.equal(weeks[1]?.[0]?.date, "2026-07-06");
	assert.equal(weeks[1]?.[2]?.date, "2026-07-08");
});
