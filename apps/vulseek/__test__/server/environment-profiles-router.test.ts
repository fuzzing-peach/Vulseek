import { createCallerFactory } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * tRPC router tests for environment.profiles.list (Phase 3b server-side
 * pagination). The db boundary and the @vulseek/server service layer are
 * mocked; tests assert on organization authorization, member access scoping
 * (accessedEnvironments/accessedServices), input normalization, and the
 * {items,total,page,pageSize} response contract.
 */

const mocks = vi.hoisted(() => {
	const queries: Array<{ operation: string; table?: unknown; where?: unknown }> =
		[];
	const seedQueue = new Map<string, Array<Record<string, unknown>[]>>();
	const claimed = new Map<string, number>();

	class FluentQuery {
		private operation: string;
		private table: unknown;
		private seedRows: Array<Record<string, unknown>> = [];

		constructor(operation: string) {
			this.operation = operation;
			queries.push({ operation });
		}

		from(table: unknown) {
			this.table = table;
			queries[queries.length - 1]!.table = table;
			const name = (table as Record<symbol, unknown>)[
				Symbol.for("drizzle:Name")
			];
			const key = `${this.operation}:${String(name)}`;
			const index = claimed.get(key) ?? 0;
			claimed.set(key, index + 1);
			this.seedRows = (seedQueue.get(key) ?? [])[index] ?? [];
			return this;
		}

		where(condition: unknown) {
			queries[queries.length - 1]!.where = condition;
			return this;
		}

		innerJoin(table: unknown) {
			return this;
		}

		leftJoin(table: unknown) {
			return this;
		}

		orderBy(...columns: unknown[]) {
			return this;
		}

		limit(value: number) {
			return this;
		}

		offset(value: number) {
			return this;
		}

		groupBy(...columns: unknown[]) {
			return this;
		}

		values(value: unknown) {
			return this;
		}

		set(value: unknown) {
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
		db: makeDb(),
		addNewEnvironment: vi.fn(),
		checkEnvironmentAccess: vi.fn(),
		checkEnvironmentCreationPermission: vi.fn(),
		checkEnvironmentDeletionPermission: vi.fn(),
		createEnvironment: vi.fn(),
		deleteEnvironment: vi.fn(),
		duplicateEnvironment: vi.fn(),
		findEnvironmentById: vi.fn(),
		findEnvironmentsByProjectId: vi.fn(),
		findMemberById: vi.fn(),
		listEnvironmentProfilesRepo: vi.fn(),
		updateEnvironmentById: vi.fn(),
		validateRequest: vi.fn(),
	};
});

vi.mock("@/server/db", () => ({ db: mocks.db }));

vi.mock("@vulseek/server/lib/auth", () => ({
	validateRequest: mocks.validateRequest,
}));

vi.mock("@vulseek/server", () => ({
	addNewEnvironment: mocks.addNewEnvironment,
	checkEnvironmentAccess: mocks.checkEnvironmentAccess,
	checkEnvironmentCreationPermission: mocks.checkEnvironmentCreationPermission,
	checkEnvironmentDeletionPermission: mocks.checkEnvironmentDeletionPermission,
	createEnvironment: mocks.createEnvironment,
	deleteEnvironment: mocks.deleteEnvironment,
	duplicateEnvironment: mocks.duplicateEnvironment,
	findEnvironmentById: mocks.findEnvironmentById,
	findEnvironmentsByProjectId: mocks.findEnvironmentsByProjectId,
	findMemberById: mocks.findMemberById,
	listEnvironmentProfilesRepo: mocks.listEnvironmentProfilesRepo,
	updateEnvironmentById: mocks.updateEnvironmentById,
}));

import { environmentRouter } from "@/server/api/routers/environment";

const createCaller = createCallerFactory()(environmentRouter);

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
	description: null,
	createdAt: "2026-01-01T00:00:00.000Z",
	env: "",
	project: { organizationId: "org-1" },
	applications: [],
	mariadb: [],
	mongo: [],
	mysql: [],
	postgres: [],
	redis: [],
	compose: [],
	...overrides,
});

const pageResult = {
	items: [
		{
			id: "app-1",
			type: "application",
			name: "api",
			description: null,
			createdAt: "2026-01-01T00:00:00.000Z",
			status: "running",
			serverId: null,
		},
	],
	total: 1,
	page: 1,
	pageSize: 12,
};

beforeEach(() => {
	mocks.queries.length = 0;
	mocks.findEnvironmentById.mockReset();
	mocks.checkEnvironmentAccess.mockReset();
	mocks.findMemberById.mockReset();
	mocks.listEnvironmentProfilesRepo.mockReset();
	mocks.listEnvironmentProfilesRepo.mockResolvedValue(pageResult);
});

describe("environment.profiles.list", () => {
	it("returns the paged contract for owners of the environment's org", async () => {
		mocks.findEnvironmentById.mockResolvedValue(environmentRow());

		const result = await callerFor({ orgId: "org-1", role: "owner" }).profiles.list(
			{ environmentId: "env-1", page: 1, pageSize: 12 },
		);

		expect(result).toEqual(pageResult);
		expect(mocks.listEnvironmentProfilesRepo).toHaveBeenCalledWith(
			expect.objectContaining({ environmentId: "env-1", page: 1, pageSize: 12 }),
			undefined,
		);
	});

	it("rejects when the environment belongs to another organization", async () => {
		mocks.findEnvironmentById.mockResolvedValue(
			environmentRow({
				project: { organizationId: "org-2" },
			}),
		);

		await expect(
			callerFor({ orgId: "org-1", role: "owner" }).profiles.list({
				environmentId: "env-1",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.listEnvironmentProfilesRepo).not.toHaveBeenCalled();
	});

	it("scopes member rows to the accessed services", async () => {
		mocks.findEnvironmentById.mockResolvedValue(environmentRow());
		mocks.findMemberById.mockResolvedValue({
			accessedEnvironments: ["env-1"],
			accessedServices: ["app-1", "db-1"],
		});

		const result = await callerFor({ orgId: "org-1", role: "member" }).profiles.list(
			{ environmentId: "env-1" },
		);

		expect(mocks.checkEnvironmentAccess).toHaveBeenCalledWith(
			"user-1",
			"env-1",
			"org-1",
			"access",
		);
		expect(mocks.listEnvironmentProfilesRepo).toHaveBeenCalledWith(
			expect.objectContaining({ environmentId: "env-1" }),
			["app-1", "db-1"],
		);
		expect(result.total).toBe(1);
	});

	it("rejects members without access to the environment", async () => {
		mocks.findEnvironmentById.mockResolvedValue(environmentRow());
		mocks.findMemberById.mockResolvedValue({
			accessedEnvironments: [],
			accessedServices: [],
		});

		await expect(
			callerFor({ orgId: "org-1", role: "member" }).profiles.list({
				environmentId: "env-1",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.listEnvironmentProfilesRepo).not.toHaveBeenCalled();
	});

	it("normalizes the search input before delegating to the repo", async () => {
		mocks.findEnvironmentById.mockResolvedValue(environmentRow());

		await callerFor({ orgId: "org-1", role: "owner" }).profiles.list({
			environmentId: "env-1",
			search: "   pay   ",
		});

		expect(mocks.listEnvironmentProfilesRepo).toHaveBeenCalledWith(
			expect.objectContaining({ search: "pay" }),
			undefined,
		);
	});
});
