export type HomeHeatmapDayInput = {
	date: string;
	totalTokens: number;
	scanJobCount: number;
	taskCount: number;
	candidateCount: number;
	securityIssueCount: number;
};

export type HomeHeatmapDay = HomeHeatmapDayInput & {
	level: 0 | 1 | 2 | 3 | 4;
	weekIndex: number;
	dayIndex: number;
};

export const heatmapLevelForTokens = (
	totalTokens: number,
	maxTokens: number,
): 0 | 1 | 2 | 3 | 4 => {
	if (totalTokens <= 0 || maxTokens <= 0) {
		return 0;
	}
	const ratio = totalTokens / maxTokens;
	if (ratio <= 0.25) return 1;
	if (ratio <= 0.5) return 2;
	if (ratio <= 0.75) return 3;
	return 4;
};

const dateKey = (date: Date) => date.toISOString().slice(0, 10);

const mondayFirstDayIndex = (date: Date) => (date.getUTCDay() + 6) % 7;

export const buildHomeHeatmapDays = (input: {
	days: HomeHeatmapDayInput[];
	dayCount?: number;
	now?: Date;
}): HomeHeatmapDay[] => {
	const dayCount = Math.max(1, Math.trunc(input.dayCount || 365));
	const now = input.now || new Date();
	const end = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
	);
	const start = new Date(end);
	start.setUTCDate(end.getUTCDate() - (dayCount - 1));
	start.setUTCDate(start.getUTCDate() - mondayFirstDayIndex(start));
	const sourceByDate = new Map(input.days.map((day) => [day.date, day]));
	const normalized: HomeHeatmapDayInput[] = [];
	const calendarDayCount =
		Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
	for (let offset = 0; offset < calendarDayCount; offset += 1) {
		const date = new Date(start);
		date.setUTCDate(start.getUTCDate() + offset);
		const key = dateKey(date);
		normalized.push(
			sourceByDate.get(key) || {
				date: key,
				totalTokens: 0,
				scanJobCount: 0,
				taskCount: 0,
				candidateCount: 0,
				securityIssueCount: 0,
			},
		);
	}
	const maxTokens = normalized.reduce(
		(max, day) => Math.max(max, day.totalTokens),
		0,
	);
	return normalized.map((day, index) => ({
		...day,
		level: heatmapLevelForTokens(day.totalTokens, maxTokens),
		weekIndex: Math.floor(index / 7),
		dayIndex: mondayFirstDayIndex(new Date(`${day.date}T00:00:00.000Z`)),
	}));
};

export const groupHomeHeatmapWeeks = (days: HomeHeatmapDay[]) => {
	const weeks: HomeHeatmapDay[][] = [];
	for (const day of days) {
		if (!weeks[day.weekIndex]) {
			weeks[day.weekIndex] = [];
		}
		weeks[day.weekIndex]?.push(day);
	}
	return weeks;
};
