import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Repository tests for listEnvironmentProfilesRepo (Phase 3b server-side
 * pagination). The db boundary is mocked with a fluent thenable query builder;
 * canned rows are seeded per (operation, table) key in FIFO order. Tests
 * assert on the per-table where wiring (environment scope, name/description
 * ilike search, member inArray on the id column) and on the
 * {items,total,page,pageSize} contract produced by mergeAndPageEnvironmentProfiles.
 */

type RecordedQuery = {
	operation: "select" | "insert" | "update" | "delete";
	table?: unknown;
	joins: Array<{ kind: string; table: unknown }>;
	where?: unknown;
	orderBy?: unknown[];
	groupBy?: unknown[];
	limit?: number;
	offset?: number;
	values?: unknown;
	set?: unknown;
};

const mocks = vi.hoisted(() => {
	const queries: RecordedQuery[] = [];
	const seedQueue = new Map<string, Array<Record<string, unknown>[]>>();
	const claimed = new Map<string, number>();

	const keyOf = (query: RecordedQuery) => {
		const table = query.table as Record<symbol, unknown> | undefined;
		const name = table?.[Symbol.for("drizzle:Name")] ?? "?";
		return `${query.operation}:${String(name)}`;
	};

	class FluentQuery {
		private query: RecordedQuery = { operation: "select", joins: [] };
		private seedRows: Array<Record<string, unknown>> = [];

		constructor(operation: RecordedQuery["operation"]) {
			this.query.operation = operation;
			queries.push(this.query);
		}

		from(table: unknown) {
			this.query.table = table;
			const key = keyOf(this.query);
			const index = claimed.get(key) ?? 0;
			claimed.set(key, index + 1);
			this.seedRows = (seedQueue.get(key) ?? [])[index] ?? [];
			return this;
		}

		innerJoin(table: unknown) {
			this.query.joins.push({ kind: "inner", table });
			return this;
		}

		leftJoin(table: unknown) {
			this.query.joins.push({ kind: "left", table });
			return this;
		}

		where(condition: unknown) {
			this.query.where = condition;
			return this;
		}

		orderBy(...columns: unknown[]) {
			this.query.orderBy = columns;
			return this;
		}

		limit(value: number) {
			this.query.limit = value;
			return this;
		}

		offset(value: number) {
			this.query.offset = value;
			return this;
		}

		groupBy(...columns: unknown[]) {
			this.query.groupBy = columns;
			return this;
		}

		values(value: unknown) {
			this.query.values = value;
			return this;
		}

		set(value: unknown) {
			this.query.set = value;
			return this;
		}

		returning() {
			return this;
		}

		// biome-ignore lint/suspicious/noThenProperty: thenable mock query builder; await resolves the seeded rows.
		then<TR>(
			onFulfilled?: (rows: Array<Record<string, unknown>>) => TR,
			onRejected?: (error: unknown) => TR,
		) {
			return Promise.resolve(this.seedRows).then(onFulfilled, onRejected);
		}
	}

	const makeDb = () => ({
		select: () => new FluentQuery("select"),
		insert: (table: unknown) => new FluentQuery("insert").from(table),
		update: (table: unknown) => new FluentQuery("update").from(table),
		delete: (table: unknown) => new FluentQuery("delete").from(table),
		transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
			callback(makeDb()),
	});

	return {
		queries,
		seedQueue,
		claimed,
		db: makeDb(),
		closeDbConnection: vi.fn(),
	};
});

vi.mock("@vulseek/server/db", () => ({
	db: mocks.db,
	dbConnection: undefined,
	closeDbConnection: mocks.closeDbConnection,
}));

import {
	listEnvironmentProfilesRepo,
	mergeAndPageEnvironmentProfiles,
} from "@vulseek/server/services/environment";
import type { EnvironmentProfile } from "@vulseek/server/services/environment";

const renderChunk = (chunk: unknown): string => {
	if (chunk == null) return "";
	if (typeof chunk === "string") return chunk;
	// inArray embeds a bare params array inside its operator chunk.
	if (Array.isArray(chunk)) return chunk.map(renderChunk).join("");
	const value = chunk as Record<string, unknown>;
	if (
		typeof value.name === "string" &&
		typeof value.columnType === "string" &&
		value.table
	) {
		const table = (value.table as Record<symbol, unknown>)[
			Symbol.for("drizzle:Name")
		];
		return `${String(table ?? "?")}.${value.name}`;
	}
	if (Array.isArray(value.queryChunks)) {
		return (value.queryChunks as unknown[]).map(renderChunk).join("");
	}
	if (Array.isArray(value.value)) {
		return (value.value as unknown[]).map(renderChunk).join("");
	}
	if ("value" in value) return JSON.stringify(value.value);
	return JSON.stringify(value);
};

const renderCondition = (condition: unknown): string =>
	condition == null
		? ""
		: Array.isArray((condition as { queryChunks?: unknown[] }).queryChunks)
			? (condition as { queryChunks: unknown[] }).queryChunks
					.map(renderChunk)
					.join("")
			: JSON.stringify(condition);

const queriesOf = (operation: RecordedQuery["operation"]) =>
	mocks.queries.filter((query) => query.operation === operation);

/** The recorded select on the given table. */
const queryOn = (table: string) =>
	queriesOf("select").find(
		(query) =>
			(query.table as Record<symbol, unknown> | undefined)?.[
				Symbol.for("drizzle:Name")
			] === table,
	);

const seedSelect = (
	table: string,
	...batches: Array<Record<string, unknown>[]>
) => {
	for (const batch of batches) {
		const key = `select:${table}`;
		const list = mocks.seedQueue.get(key) ?? [];
		list.push(batch);
		mocks.seedQueue.set(key, list);
	}
};

const profileRow = (overrides: Record<string, unknown> = {}) => ({
	id: "svc-1",
	name: "api",
	description: "the api",
	createdAt: "2026-01-01T00:00:00.000Z",
	status: "running",
	serverId: "server-1",
	...overrides,
});

/** Seeds one row per service table so every query resolves. */
const seedAllTables = (overrides: Record<string, unknown> = {}) => {
	for (const table of [
		"application",
		"compose",
		"mariadb",
		"mongo",
		"mysql",
		"postgres",
		"redis",
	]) {
		seedSelect(table, [profileRow({ id: `${table}-1`, ...overrides })]);
	}
};

const listInput = (
	overrides: Partial<Parameters<typeof listEnvironmentProfilesRepo>[0]> = {},
): Parameters<typeof listEnvironmentProfilesRepo>[0] => ({
	environmentId: "env-1",
	sortKey: "createdAt",
	sortDirection: "desc",
	page: 1,
	pageSize: 12,
	...overrides,
});

beforeEach(() => {
	mocks.queries.length = 0;
	mocks.seedQueue.clear();
	mocks.claimed.clear();
});

describe("listEnvironmentProfilesRepo", () => {
	it("queries all seven tables scoped to the environment and merges them", async () => {
		seedAllTables();

		const result = await listEnvironmentProfilesRepo(listInput());

		expect(queriesOf("select")).toHaveLength(7);
		for (const table of [
			"application",
			"compose",
			"mariadb",
			"mongo",
			"mysql",
			"postgres",
			"redis",
		]) {
			expect(renderCondition(queryOn(table)?.where)).toContain(
				`${table}.environmentId = "env-1"`,
			);
		}
		expect(result.items).toHaveLength(7);
		expect(result.items[0]).toMatchObject({
			id: "application-1",
			type: "application",
			name: "api",
			status: "running",
			serverId: "server-1",
		});
		expect(result.items.find((item) => item.type === "compose")?.id).toBe(
			"compose-1",
		);
		expect(result.items.find((item) => item.type === "redis")?.id).toBe(
			"redis-1",
		);
		expect(result.total).toBe(7);
		expect(result.page).toBe(1);
		expect(result.pageSize).toBe(12);
	});

	it("searches name and description with ilike on every table", async () => {
		seedAllTables();

		await listEnvironmentProfilesRepo(listInput({ search: "pay" }));

		for (const table of [
			"application",
			"compose",
			"mariadb",
			"mongo",
			"mysql",
			"postgres",
			"redis",
		]) {
			const where = renderCondition(queryOn(table)?.where);
			expect(where).toContain(`${table}.name ilike %pay%`);
			expect(where).toContain(`${table}.description ilike %pay%`);
		}
	});

	it("scopes member rows by the per-table id column", async () => {
		seedAllTables();

		await listEnvironmentProfilesRepo(
			listInput(),
			["svc-1", "svc-2"],
		);

		// drizzle adds the wrapping parens/commas at SQL-generation time, so
		// assert the id column, the operator, and the values it received.
		for (const [table, idColumn] of [
			["application", "application.applicationId"],
			["compose", "compose.composeId"],
			["postgres", "postgres.postgresId"],
		] as const) {
			const where = renderCondition(queryOn(table)?.where);
			expect(where).toContain(`${idColumn} in `);
			expect(where).toContain('"svc-1"');
			expect(where).toContain('"svc-2"');
		}
	});

	it("filters by type, sorts, and slices the page after merging", async () => {
		seedSelect(
			"application",
			[
				profileRow({ id: "app-b", name: "billing", createdAt: "2026-01-02T00:00:00.000Z" }),
				profileRow({ id: "app-a", name: "api", createdAt: "2026-01-03T00:00:00.000Z" }),
				profileRow({ id: "app-c", name: "cache", createdAt: "2026-01-01T00:00:00.000Z" }),
				profileRow({ id: "app-d", name: "dashboard", createdAt: "2026-01-04T00:00:00.000Z" }),
			],
		);
		seedSelect("compose", [profileRow({ id: "comp-1" })]);

		const result = await listEnvironmentProfilesRepo(
			listInput({
				types: ["application"],
				sortKey: "name",
				sortDirection: "asc",
				page: 2,
				pageSize: 2,
			}),
		);

		expect(result.total).toBe(4);
		expect(result.items.map((item) => item.name)).toEqual(["cache", "dashboard"]);
	});

	it("keeps compose status mapping and null passthrough", async () => {
		seedSelect("compose", [
			profileRow({ id: "comp-1", status: "idle", serverId: null, description: null }),
		]);

		const result = await listEnvironmentProfilesRepo(
			listInput({ types: ["compose"] }),
		);

		expect(result.items[0]).toMatchObject({
			id: "comp-1",
			type: "compose",
			status: "idle",
			serverId: null,
			description: null,
		});
	});
});

describe("mergeAndPageEnvironmentProfiles", () => {
	it("sorts by createdAt desc by default and pages the merged set", () => {
		const profiles: EnvironmentProfile[] = [
			{ id: "a", type: "application", name: "api", description: null, createdAt: "2026-01-01T00:00:00.000Z", status: "running", serverId: null },
			{ id: "b", type: "compose", name: "billing", description: null, createdAt: "2026-01-03T00:00:00.000Z", status: "idle", serverId: null },
			{ id: "c", type: "redis", name: "cache", description: null, createdAt: "2026-01-02T00:00:00.000Z", status: "error", serverId: "server-1" },
		];

		const result = mergeAndPageEnvironmentProfiles(profiles, {
			sortKey: "createdAt",
			sortDirection: "desc",
			page: 1,
			pageSize: 2,
		});

		expect(result.items.map((item) => item.id)).toEqual(["b", "c"]);
		expect(result.total).toBe(3);
	});
});
