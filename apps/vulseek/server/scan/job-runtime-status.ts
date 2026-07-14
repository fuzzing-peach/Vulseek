type SnapshotSlot<T> = {
	data: T | null;
	updatedAt: string | null;
	lastError: string | null;
	inFlight: Promise<void> | null;
	version: number;
};

export type JobRuntimeLoaders<
	TOverview = unknown,
	TRunningTasks = unknown,
	TQueueCounts = unknown,
	TPipeline = unknown,
> = {
	loadOverview: () => Promise<TOverview>;
	loadRunningTasks: () => Promise<TRunningTasks>;
	loadQueueCounts: () => Promise<TQueueCounts>;
	loadPipeline: () => Promise<TPipeline>;
};

export type JobRuntimeStatusStoreOptions<
	TOverview,
	TRunningTasks,
	TQueueCounts,
	TPipeline,
> = {
	loaders?: JobRuntimeLoaders<
		TOverview,
		TRunningTasks,
		TQueueCounts,
		TPipeline
	>;
	createLoaders?: (
		jobId: string,
	) => JobRuntimeLoaders<TOverview, TRunningTasks, TQueueCounts, TPipeline>;
	overviewIntervalMs?: number;
	runtimeIntervalMs?: number;
	idleStopMs?: number;
	idleEvictionMs?: number;
	cleanupIntervalMs?: number;
	maxEntries?: number;
	isTerminal?: (data: TOverview | null) => boolean;
};

type JobRuntimeEntry<TOverview, TRunningTasks, TQueueCounts, TPipeline> = {
	jobId: string;
	overview: SnapshotSlot<TOverview>;
	runningTasks: SnapshotSlot<TRunningTasks>;
	queueCounts: SnapshotSlot<TQueueCounts>;
	pipeline: SnapshotSlot<TPipeline>;
	lastAccessAt: number;
	overviewTimer: ReturnType<typeof setInterval> | null;
	runtimeTimer: ReturnType<typeof setInterval> | null;
};

const createSlot = <T>(): SnapshotSlot<T> => ({
	data: null,
	updatedAt: null,
	lastError: null,
	inFlight: null,
	version: 0,
});

const createEntry = <TOverview, TRunningTasks, TQueueCounts, TPipeline>(
	jobId: string,
): JobRuntimeEntry<TOverview, TRunningTasks, TQueueCounts, TPipeline> => ({
	jobId,
	overview: createSlot(),
	runningTasks: createSlot(),
	queueCounts: createSlot(),
	pipeline: createSlot(),
	lastAccessAt: Date.now(),
	overviewTimer: null,
	runtimeTimer: null,
});

const errorMessage = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

export const createJobRuntimeStatusStore = <
	TOverview,
	TRunningTasks,
	TQueueCounts,
	TPipeline,
>(
	options: JobRuntimeStatusStoreOptions<
		TOverview,
		TRunningTasks,
		TQueueCounts,
		TPipeline
	>,
) => {
	const overviewIntervalMs = options.overviewIntervalMs ?? 10_000;
	const runtimeIntervalMs = options.runtimeIntervalMs ?? 5_000;
	const idleStopMs = options.idleStopMs ?? 30_000;
	const idleEvictionMs = options.idleEvictionMs ?? 10 * 60_000;
	const cleanupIntervalMs = options.cleanupIntervalMs ?? 60_000;
	const maxEntries = options.maxEntries ?? 500;
	const getLoaders = (jobId: string) => {
		const loaders = options.createLoaders?.(jobId) ?? options.loaders;
		if (!loaders) throw new Error("Job runtime loaders are not configured");
		return loaders;
	};
	type RuntimeEntry = JobRuntimeEntry<
		TOverview,
		TRunningTasks,
		TQueueCounts,
		TPipeline
	>;
	const entries = new Map<string, RuntimeEntry>();

	const stopTimers = (entry: RuntimeEntry) => {
		if (entry.overviewTimer) clearInterval(entry.overviewTimer);
		if (entry.runtimeTimer) clearInterval(entry.runtimeTimer);
		entry.overviewTimer = null;
		entry.runtimeTimer = null;
	};

	const isIdle = (entry: RuntimeEntry) =>
		Date.now() - entry.lastAccessAt >= idleStopMs;

	const refresh = async <T>(
		slot: SnapshotSlot<T>,
		loader: () => Promise<T>,
	) => {
		if (slot.inFlight) return slot.inFlight;

		const version = slot.version;
		const inFlight = loader()
			.then((data) => {
				if (slot.version !== version) return;
				slot.data = data;
				slot.updatedAt = new Date().toISOString();
				slot.lastError = null;
			})
			.catch((error) => {
				if (slot.version !== version) return;
				slot.lastError = errorMessage(error);
				if (!slot.data) throw error;
			})
			.finally(() => {
				if (slot.inFlight === inFlight) slot.inFlight = null;
			});
		slot.inFlight = inFlight;
		return inFlight;
	};

	const refreshIfLoaded = async <T>(
		entry: RuntimeEntry,
		slot: SnapshotSlot<T>,
		loader: () => Promise<T>,
	) => {
		if (!slot.data || isIdle(entry)) return;
		await refresh(slot, loader).catch(() => {});
	};

	const startOverviewTimer = (entry: RuntimeEntry) => {
		if (entry.overviewTimer) return;
		entry.overviewTimer = setInterval(() => {
			if (isIdle(entry)) {
				stopTimers(entry);
				return;
			}
			const loaders = getLoaders(entry.jobId);
			void (async () => {
				await refreshIfLoaded(entry, entry.overview, loaders.loadOverview);
				if (!options.isTerminal?.(entry.overview.data)) return;
				await Promise.all([
					refreshIfLoaded(entry, entry.runningTasks, loaders.loadRunningTasks),
					refreshIfLoaded(entry, entry.queueCounts, loaders.loadQueueCounts),
				]);
				stopTimers(entry);
			})();
		}, overviewIntervalMs);
	};

	const startRuntimeTimer = (entry: RuntimeEntry) => {
		if (entry.runtimeTimer) return;
		entry.runtimeTimer = setInterval(() => {
			if (isIdle(entry)) {
				stopTimers(entry);
				return;
			}
			const loaders = getLoaders(entry.jobId);
			void Promise.all([
				refreshIfLoaded(entry, entry.runningTasks, loaders.loadRunningTasks),
				refreshIfLoaded(entry, entry.queueCounts, loaders.loadQueueCounts),
			]);
		}, runtimeIntervalMs);
	};

	const evictIfNeeded = () => {
		const now = Date.now();
		for (const [jobId, entry] of entries) {
			if (now - entry.lastAccessAt >= idleEvictionMs) {
				stopTimers(entry);
				entries.delete(jobId);
			}
		}
		while (entries.size > maxEntries) {
			const oldest = [...entries.entries()].sort(
				([, left], [, right]) => left.lastAccessAt - right.lastAccessAt,
			)[0];
			if (!oldest) break;
			stopTimers(oldest[1]);
			entries.delete(oldest[0]);
		}
	};

	const cleanupTimer = setInterval(evictIfNeeded, cleanupIntervalMs);
	if (typeof cleanupTimer === "object" && "unref" in cleanupTimer) {
		cleanupTimer.unref();
	}

	const getEntry = (jobId: string) => {
		let entry = entries.get(jobId);
		if (!entry) {
			entry = createEntry<TOverview, TRunningTasks, TQueueCounts, TPipeline>(
				jobId,
			);
			entries.set(jobId, entry);
			evictIfNeeded();
		}
		entry.lastAccessAt = Date.now();
		return entry;
	};

	const readSlot = async <T>(
		jobId: string,
		slot: SnapshotSlot<T>,
		loader: () => Promise<T>,
		startTimer?: (entry: RuntimeEntry) => void,
	) => {
		const entry = getEntry(jobId);
		startTimer?.(entry);
		if (!slot.data) {
			await refresh(slot, loader);
		}
		return slot.data as T;
	};

	const invalidateSlot = (
		jobId: string,
		slotName: "overview" | "runningTasks" | "queueCounts" | "pipeline",
	) => {
		const entry = entries.get(jobId);
		if (!entry) return;
		const slot = entry[slotName];
		slot.version += 1;
		slot.data = null;
		slot.updatedAt = null;
		slot.lastError = null;
		slot.inFlight = null;
	};

	return {
		readOverview: (jobId: string) => {
			const entry = getEntry(jobId);
			return readSlot(
				jobId,
				entry.overview,
				getLoaders(jobId).loadOverview,
				startOverviewTimer,
			);
		},
		readRunningTasks: (jobId: string) => {
			const entry = getEntry(jobId);
			return readSlot(
				jobId,
				entry.runningTasks,
				getLoaders(jobId).loadRunningTasks,
				startRuntimeTimer,
			);
		},
		readQueueCounts: (jobId: string) => {
			const entry = getEntry(jobId);
			return readSlot(
				jobId,
				entry.queueCounts,
				getLoaders(jobId).loadQueueCounts,
				startRuntimeTimer,
			);
		},
		readPipeline: (jobId: string) => {
			const entry = getEntry(jobId);
			return readSlot(
				jobId,
				entry.pipeline,
				getLoaders(jobId).loadPipeline,
			);
		},
		invalidateOverview: (jobId: string) => invalidateSlot(jobId, "overview"),
		invalidatePipeline: (jobId: string) => invalidateSlot(jobId, "pipeline"),
		dispose: () => {
			clearInterval(cleanupTimer);
			for (const entry of entries.values()) stopTimers(entry);
			entries.clear();
		},
	};
};
