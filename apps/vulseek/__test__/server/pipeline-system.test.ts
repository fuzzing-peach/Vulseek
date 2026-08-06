import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * System pipeline seeding tests (Phase 4).
 *
 * The db boundary is mocked with the same fluent thenable query builder used
 * by the pipeline router tests. Rows are seeded per (operation, table) key in
 * FIFO order. The built-in templates are the real generated V3 files.
 */

type RecordedQuery = {
	operation: "select" | "insert" | "update";
	table?: unknown;
	values?: unknown;
	set?: unknown;
};

const mocks = vi.hoisted(() => {
	const queries: RecordedQuery[] = [];
	const seedQueue = new Map<string, Array<Array<Record<string, unknown>>>>();
	const claimed = new Map<string, number>();

	const keyOf = (query: RecordedQuery) => {
		const table = query.table as Record<symbol, unknown> | undefined;
		const name = table?.[Symbol.for("drizzle:Name")] ?? "?";
		return `${query.operation}:${String(name)}`;
	};

	class FluentQuery {
		private query: RecordedQuery = { operation: "select" };
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

		innerJoin() {
			return this;
		}
		where() {
			return this;
		}
		limit() {
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
		// biome-ignore lint/suspicious/noThenProperty: thenable mock query builder.
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
		transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
			callback(makeDb()),
	});

	return { queries, seedQueue, claimed, db: makeDb() };
});

vi.mock("@vulseek/server/db", () => ({ db: mocks.db }));

import {
	seedSystemPipelinesForOrganization,
	syncSystemPipelineTemplatesForOrganization,
} from "@vulseek/server/services/pipeline-system";
import { loadBuiltinPipelineTemplates } from "@vulseek/server/services/scan/pipeline/document-v3";

const seed = (
	operation: "select" | "insert" | "update",
	table: string,
	rows: Array<Record<string, unknown>>,
) => {
	const key = `${operation}:${table}`;
	const batch = mocks.seedQueue.get(key) ?? [];
	batch.push(rows);
	mocks.seedQueue.set(key, batch);
};

const pipelineRow = (overrides: Record<string, unknown> = {}) => ({
	pipelineId: "pipeline-full",
	organizationId: "org-1",
	slug: "full",
	name: "full-scan-programmatic",
	systemKey: "full",
	currentPublishedVersionId: null,
	draftRevision: 0,
	archivedAt: null,
	...overrides,
});

const versionRow = (overrides: Record<string, unknown> = {}) => ({
	pipelineVersionId: "version-full-1",
	pipelineId: "pipeline-full",
	versionNumber: 1,
	yaml: "version: 3\nname: x\n",
	contentHash: "template-hash",
	source: "system",
	...overrides,
});

beforeEach(() => {
	mocks.seedQueue.clear();
	mocks.claimed.clear();
	mocks.queries.length = 0;
});

describe("seedSystemPipelinesForOrganization", () => {
	it("creates the four system pipelines with v1 versions", async () => {
		// Per template: pipeline lookup miss, slug check miss, pipeline insert,
		// current-version miss, same-hash miss, max(v) null, version insert,
		// current switch update.
		for (let i = 0; i < 4; i += 1) {
			seed("select", "scan_pipelines", []);
			seed("select", "scan_pipelines", []);
			seed("insert", "scan_pipelines", [pipelineRow({ pipelineId: `p-${i}` })]);
			seed("select", "scan_pipeline_versions", []);
			seed("select", "scan_pipeline_versions", []);
			seed("select", "scan_pipeline_versions", [{ next: null }]);
			seed("insert", "scan_pipeline_versions", [versionRow()]);
			seed("update", "scan_pipelines", [{ pipelineId: `p-${i}` }]);
		}

		const results = await seedSystemPipelinesForOrganization("org-1");
		expect(results).toHaveLength(4);
		expect(results.map((r) => r.systemKey)).toEqual(
			expect.arrayContaining(["full", "delta", "research", "tob-goal"]),
		);
		// exactly four pipeline inserts, four version inserts
		const pipelineInserts = mocks.queries.filter(
			(q) => q.operation === "insert" && q.table !== undefined,
		);
		expect(pipelineInserts).toHaveLength(8);
	});

	it("is idempotent when the current version already matches the template", async () => {
		// Per template: pipeline found with current version whose hash matches
		// the real built-in template hash.
		const templates = loadBuiltinPipelineTemplates();
		for (let i = 0; i < templates.length; i += 1) {
			seed("select", "scan_pipelines", [
				pipelineRow({ pipelineId: `p-${i}`, currentPublishedVersionId: `v-${i}` }),
			]);
			seed("select", "scan_pipeline_versions", [
				versionRow({ contentHash: templates[i]!.contentHash }),
			]);
		}

		const results = await syncSystemPipelineTemplatesForOrganization("org-1");
		expect(results).toHaveLength(4);
		expect(results.every((r) => r.unchanged)).toBe(true);
		const inserts = mocks.queries.filter((q) => q.operation === "insert");
		expect(inserts).toHaveLength(0);
	});
});
