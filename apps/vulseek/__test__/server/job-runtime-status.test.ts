import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createJobRuntimeStatusStore,
	type JobRuntimeLoaders,
} from "@/server/scan/job-runtime-status";

const createLoaders = (): JobRuntimeLoaders => ({
	loadOverview: vi.fn(async () => ({ status: "running" })),
	loadRunningTasks: vi.fn(async () => ({ tasks: [] })),
	loadQueueCounts: vi.fn(async () => ({ queues: [] })),
	loadPipeline: vi.fn(async () => ({ stages: [] })),
});

describe("JobRuntimeStatus store", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("loads the first snapshot and serves subsequent reads from memory", async () => {
		vi.useFakeTimers();
		const loaders = createLoaders();
		const store = createJobRuntimeStatusStore({
			loaders,
			overviewIntervalMs: 10_000,
			runtimeIntervalMs: 5_000,
			idleStopMs: 30_000,
		});

		await expect(store.readOverview("job-1")).resolves.toEqual({
			status: "running",
		});
		await expect(store.readOverview("job-1")).resolves.toEqual({
			status: "running",
		});
		expect(loaders.loadOverview).toHaveBeenCalledTimes(1);

		store.dispose();
	});

	it("reloads a pipeline after its snapshot is invalidated", async () => {
		const loaders = createLoaders();
		const store = createJobRuntimeStatusStore({ loaders });

		await store.readPipeline("job-1");
		await store.readPipeline("job-1");
		expect(loaders.loadPipeline).toHaveBeenCalledTimes(1);

		store.invalidatePipeline("job-1");
		await store.readPipeline("job-1");

		expect(loaders.loadPipeline).toHaveBeenCalledTimes(2);
		store.dispose();
	});

	it("refreshes running tasks and queues on the shared runtime interval", async () => {
		vi.useFakeTimers();
		const loaders = createLoaders();
		const store = createJobRuntimeStatusStore({
			loaders,
			overviewIntervalMs: 10_000,
			runtimeIntervalMs: 5_000,
			idleStopMs: 30_000,
		});

		await store.readRunningTasks("job-1");
		await store.readQueueCounts("job-1");
		await vi.advanceTimersByTimeAsync(5_000);

		expect(loaders.loadRunningTasks).toHaveBeenCalledTimes(2);
		expect(loaders.loadQueueCounts).toHaveBeenCalledTimes(2);
		expect(loaders.loadOverview).not.toHaveBeenCalled();

		store.dispose();
	});

	it("does not overlap refreshes for the same slot", async () => {
		vi.useFakeTimers();
		let resolveLoader: ((value: { tasks: string[] }) => void) | undefined;
		const loaders = createLoaders();
		loaders.loadRunningTasks = vi.fn(
			() =>
				new Promise((resolve) => {
					resolveLoader = resolve;
				}),
		);
		const store = createJobRuntimeStatusStore({
			loaders,
			overviewIntervalMs: 10_000,
			runtimeIntervalMs: 5_000,
			idleStopMs: 30_000,
		});

		const firstRead = store.readRunningTasks("job-1");
		await vi.advanceTimersByTimeAsync(15_000);
		expect(loaders.loadRunningTasks).toHaveBeenCalledTimes(1);

		resolveLoader?.({ tasks: [] });
		await firstRead;
		store.dispose();
	});

	it("stops refreshing after the job becomes idle", async () => {
		vi.useFakeTimers();
		const loaders = createLoaders();
		const store = createJobRuntimeStatusStore({
			loaders,
			overviewIntervalMs: 10_000,
			runtimeIntervalMs: 5_000,
			idleStopMs: 30_000,
		});

		await store.readOverview("job-1");
		await vi.advanceTimersByTimeAsync(30_001);
		await vi.advanceTimersByTimeAsync(30_000);

		expect(loaders.loadOverview).toHaveBeenCalledTimes(3);
		store.dispose();
	});
});
