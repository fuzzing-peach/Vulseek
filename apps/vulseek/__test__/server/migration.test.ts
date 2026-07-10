import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	closeConnection: vi.fn(),
	ensureLegacyDrizzleBaseline: vi.fn(),
	migrate: vi.fn(),
}));

vi.mock("postgres", () => ({
	default: vi.fn(() => ({ end: mocks.closeConnection })),
}));

vi.mock("drizzle-orm/postgres-js", () => ({
	drizzle: vi.fn(() => ({})),
}));

vi.mock("drizzle-orm/postgres-js/migrator", () => ({
	migrate: mocks.migrate,
}));

vi.mock("@/server/db/legacy-drizzle-baseline", () => ({
	ensureLegacyDrizzleBaseline: mocks.ensureLegacyDrizzleBaseline,
}));

import { migration } from "@/server/db/migration";

describe("migration", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("rethrows the original migration error and closes the connection", async () => {
		const error = new Error("migration failed");
		mocks.ensureLegacyDrizzleBaseline.mockResolvedValue(undefined);
		mocks.migrate.mockRejectedValue(error);

		await expect(migration()).rejects.toBe(error);
		expect(mocks.closeConnection).toHaveBeenCalledTimes(1);
	});
});
