import { createCallerFactory } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * tRPC router tests for the paginated project.list procedure (Phase 3b).
 *
 * The router's list path uses two db boundaries:
 *  1. the relational builder (`db.query.projects.findMany`) for the item rows
 *     — mocked as a vi.fn that claims seeded batches keyed `findMany:project`
 *     and records its args for assertions; and
 *  2. the SQL builder (`db.select().from(projects)`) for the count query —
 *     mocked with the same fluent thenable as the dataset router tests.
 *
 * findMemberById is mocked so the member branch (accessed projects /
 * environments / services scoping) can be exercised without a database.
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

type FindManyCall = {
	where?: unknown;
	orderBy?: unknown;
	limit?: number;
	offset?: number;
	with?: unknown;
};

const mocks = vi.hoisted(() => {
	const queries: RecordedQuery[] = [];
	const findManyCalls: FindManyCall[] = [];
	// key: `${operation}:${tableName}` -> batches of rows, claimed by a query
	// when it is constructed (construction order is deterministic even when
	// the router mixes chained `.then` and bare thenables in Promise.all).
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

		/** Sets the target table and claims the next seeded batch for it. */
		from(table: unknown) {
			this.query.table = table;
			const key = keyOf(this.query);
			const index = claimed.get(key) ?? 0;
			claimed.set(key, index + 1);
			this.seedRows = (seedQueue.get(key) ?? [])[index] ?? [];
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
		query: {
			projects: {
				findMany: vi.fn((args: unknown) => {
					const key = "findMany:project";
					const index = claimed.get(key) ?? 0;
					claimed.set(key, index + 1);
					const batch = (seedQueue.get(key) ?? [])[index] ?? [];
					findManyCalls.push((args ?? {}) as FindManyCall);
					return Promise.resolve(batch);
				}),
				findFirst: vi.fn(),
			},
		},
	});

	return {
		queries,
		findManyCalls,
		seedQueue,
		claimed,
		db: makeDb(),
		findMemberById: vi.fn(),
	};
});

vi.mock("@/server/db", () => ({ db: mocks.db }));

vi.mock("@vulseek/server", () => ({
	findMemberById: mocks.findMemberById,
}));

import { projectRouter } from "@/server/api/routers/project";

const renderChunk = (chunk: unknown): string => {
	if (chunk == null) return "";
	if (typeof chunk === "string") return chunk;
	// inArray embeds the raw values array as a chunk in some drizzle versions.
	if (Array.isArray(chunk)) return chunk.map(renderChunk).join(", ");
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
		return (value.value as unknown[])
			.map((item) => {
				if (typeof item === "string") return item;
				if (item && typeof item === "object") {
					const nested = (item as { value?: unknown }).value;
					return typeof nested === "string" ? nested : String(nested);
				}
				return String(item);
			})
			.join("");
	}
	if ("value" in value) return JSON.stringify(value.value);
	// Tables interpolated into sql templates (e.g. services-count subqueries)
	// appear as chunks; render their drizzle name instead of a circular JSON.
	const tableName = (value as Record<symbol, unknown>)[
		Symbol.for("drizzle:Name")
	];
	if (typeof tableName === "string") return String(tableName);
	try {
		return JSON.stringify(value);
	} catch {
		const ctor = (value as object).constructor?.name ?? typeof value;
		return `[unrenderable:${ctor}]`;
	}
};

const renderCondition = (condition: unknown): string =>
	condition == null
		? ""
		: Array.isArray((condition as { queryChunks?: unknown[] }).queryChunks)
			? (condition as { queryChunks: unknown[] }).queryChunks
					.map(renderChunk)
					.join("")
			: JSON.stringify(condition);

const renderOrderBy = (columns?: unknown[]) =>
	(columns ?? []).map((column) => renderCondition(column)).join(", ");

const queriesOf = (operation: RecordedQuery["operation"]) =>
	mocks.queries.filter((query) => query.operation === operation);

const firstQueryOn = (operation: RecordedQuery["operation"], table: string) => {
	const matches = queriesOf(operation).filter((query) => {
		const name = (query.table as Record<symbol, unknown> | undefined)?.[
			Symbol.for("drizzle:Name")
		];
		return name === table;
	});
	return matches[0];
};

const firstFindManyCall = () => mocks.findManyCalls[0];

type WithShape = {
	environments?: {
		where?: unknown;
		with?: Record<string, { where?: unknown }>;
	};
};

const renderEnvWhere = (withArg: unknown) =>
	renderCondition((withArg as WithShape).environments?.where);

const renderServiceWhere = (withArg: unknown, key: string) =>
	renderCondition((withArg as WithShape).environments?.with?.[key]?.where);

const pushBatch = (key: string, batch: Array<Record<string, unknown>>) => {
	const list = mocks.seedQueue.get(key) ?? [];
	list.push(batch);
	mocks.seedQueue.set(key, list);
};

const seedQuery = (
	operation: RecordedQuery["operation"],
	table: string,
	...batches: Array<Record<string, unknown>[]>
) => {
	for (const batch of batches) pushBatch(`${operation}:${table}`, batch);
};

const seedSelect = (
	table: string,
	...batches: Array<Record<string, unknown>[]>
) => seedQuery("select", table, ...batches);

const seedFindMany = (
	...batches: Array<Record<string, unknown>[]>
) => {
	for (const batch of batches) pushBatch("findMany:project", batch);
};

const createCaller = createCallerFactory()(projectRouter);

const callerFor = (options: {
	orgId: string;
	role: "owner" | "admin" | "member";
}) =>
	createCaller({
		session: { activeOrganizationId: options.orgId },
		user: {
			id: "user-1",
			role: options.role,
			ownerId: "user-1",
			email: "user@test.local",
		},
		req: undefined,
		res: undefined,
		db: mocks.db,
	} as never);

const environmentRow = (overrides: Record<string, unknown> = {}) => ({
	environmentId: "env-1",
	projectId: "proj-1",
	name: "production",
	applications: [],
	compose: [],
	mariadb: [],
	mongo: [],
	mysql: [],
	postgres: [],
	redis: [],
	...overrides,
});

const projectRow = (overrides: Record<string, unknown> = {}) => ({
	projectId: "proj-1",
	organizationId: "org-1",
	name: "payments",
	description: "payment service",
	createdAt: "2026-01-01T00:00:00.000Z",
	env: "",
	scanContextVolumeName: "",
	environments: [environmentRow()],
	...overrides,
});

beforeEach(() => {
	mocks.queries.length = 0;
	mocks.findManyCalls.length = 0;
	mocks.seedQueue.clear();
	mocks.claimed.clear();
	mocks.findMemberById.mockReset();
	mocks.findMemberById.mockResolvedValue({
		accessedProjects: [],
		accessedEnvironments: [],
		accessedServices: [],
	});
});

describe("project.list", () => {
	it("scopes items and count to the caller organization", async () => {
		seedFindMany([projectRow()]);
		seedSelect("project", [{ count: 1 }]);

		const result = await callerFor({ orgId: "org-1", role: "owner" }).list({});

		const where = renderCondition(firstFindManyCall()?.where);
		expect(where).toContain('project.organizationId = "org-1"');
		expect(result.items).toHaveLength(1);
		expect(result.items[0]?.projectId).toBe("proj-1");
		expect(result.items[0]?.name).toBe("payments");
		expect(result.total).toBe(1);
		expect(result.page).toBe(1);
		expect(result.pageSize).toBe(12);
	});

	it("returns the {items,total,page,pageSize} contract with defaults", async () => {
		seedFindMany([]);
		seedSelect("project", [{ count: 0 }]);

		const result = await callerFor({ orgId: "org-1", role: "owner" }).list({});

		expect(result).toEqual({
			items: [],
			total: 0,
			page: 1,
			pageSize: 12,
		});
	});

	it("searches name and description with ilike", async () => {
		seedFindMany([]);
		seedSelect("project", [{ count: 0 }]);

		await callerFor({ orgId: "org-1", role: "owner" }).list({
			search: "pay",
		});

		const where = renderCondition(firstFindManyCall()?.where);
		expect(where).toContain('project.name ilike %pay%');
		expect(where).toContain('project.description ilike %pay%');
	});

	it("applies sortKey/sortDirection to the orderBy clause", async () => {
		seedFindMany([]);
		seedSelect("project", [{ count: 0 }]);

		await callerFor({ orgId: "org-1", role: "owner" }).list({
			sortKey: "name",
			sortDirection: "asc",
		});

		expect(renderCondition(firstFindManyCall()?.orderBy)).toContain(
			'project.name asc',
		);
	});

	it("sorts by the services count SQL when sortKey is services", async () => {
		seedFindMany([]);
		seedSelect("project", [{ count: 0 }]);

		await callerFor({ orgId: "org-1", role: "owner" }).list({
			sortKey: "services",
			sortDirection: "desc",
		});

		const orderBy = renderCondition(firstFindManyCall()?.orderBy);
		expect(orderBy).toContain("count(*)");
		expect(orderBy).toContain("desc");
	});

	it("paginates with limit and offset and returns the page contract", async () => {
		seedFindMany([projectRow()]);
		seedSelect("project", [{ count: 7 }]);

		const result = await callerFor({ orgId: "org-1", role: "owner" }).list({
			page: 3,
			pageSize: 20,
		});

		const call = firstFindManyCall();
		expect(call?.limit).toBe(20);
		expect(call?.offset).toBe(40);
		expect(result.total).toBe(7);
		expect(result.page).toBe(3);
		expect(result.pageSize).toBe(20);
	});

	it("counts with the SQL builder from the same where", async () => {
		seedFindMany([]);
		seedSelect("project", [{ count: 4 }]);

		const result = await callerFor({ orgId: "org-1", role: "owner" }).list({
			search: "pay",
		});

		const countQuery = firstQueryOn("select", "project");
		const countWhere = renderCondition(countQuery?.where);
		expect(countWhere).toContain('project.organizationId = "org-1"');
		expect(countWhere).toContain('project.name ilike %pay%');
		expect(result.total).toBe(4);
	});

	it("returns an empty contract without querying for members without project access", async () => {
		mocks.findMemberById.mockResolvedValue({
			accessedProjects: [],
			accessedEnvironments: [],
			accessedServices: [],
		});

		const result = await callerFor({ orgId: "org-1", role: "member" }).list({});

		expect(result).toEqual({ items: [], total: 0, page: 1, pageSize: 12 });
		expect(mocks.findManyCalls).toHaveLength(0);
		expect(queriesOf("select")).toHaveLength(0);
	});

	it("scopes member items to accessed projects, environments and services", async () => {
		mocks.findMemberById.mockResolvedValue({
			accessedProjects: ["proj-1", "proj-2"],
			accessedEnvironments: ["env-1"],
			accessedServices: ["app-1"],
		});
		seedFindMany([projectRow()]);
		seedSelect("project", [{ count: 1 }]);

		const result = await callerFor({ orgId: "org-1", role: "member" }).list({});

		const call = firstFindManyCall();
		const where = renderCondition(call?.where);
		expect(where).toContain('project.projectId in "proj-1", "proj-2"');
		const envWhere = renderEnvWhere(call?.with);
		expect(envWhere).toContain('environment.environmentId IN (env-1)');
		const appWhere = renderServiceWhere(call?.with, "applications");
		expect(appWhere).toContain('application.applicationId IN (app-1)');
		expect(result.items).toHaveLength(1);
	});

	it("scopes members without environment access with a false filter", async () => {
		mocks.findMemberById.mockResolvedValue({
			accessedProjects: ["proj-1"],
			accessedEnvironments: [],
			accessedServices: [],
		});
		seedFindMany([]);
		seedSelect("project", [{ count: 0 }]);

		await callerFor({ orgId: "org-1", role: "member" }).list({});

		const call = firstFindManyCall();
		expect(renderCondition(call?.where)).toContain('project.projectId in "proj-1"');
		expect(renderEnvWhere(call?.with)).toBe("false");
		expect(renderServiceWhere(call?.with, "mariadb")).toBe("false");
	});
});
