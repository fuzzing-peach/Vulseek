type SnapshotSlot<T> = {
	data: T | null;
	updatedAt: string | null;
	lastError: string | null;
	inFlight: Promise<void> | null;
};

export type JobRuntimeLoaders = {
	loadOverview: () => Promise<unknown>;
	loadRunningTasks: () => Promise<unknown>;
	loadQueueCounts: () => Promise<unknown>;
	loadPipeline: () => Promise<unknown>;
};

export type JobRuntimeStatusStoreOptions = {
	loaders?: JobRuntimeLoaders;
	createLoaders?: (jobId: string) => JobRuntimeLoaders;
	overviewIntervalMs?: number;
	runtimeIntervalMs?: number;
	idleStopMs?: number;
	idleEvictionMs?: number;
	cleanupIntervalMs?: number;
	maxEntries?: number;
	isTerminal?: (data: unknown) => boolean;
};

type JobRuntimeEntry = {
	jobId: string;
	overview: SnapshotSlot<unknown>;
	runningTasks: SnapshotSlot<unknown>;
	queueCounts: SnapshotSlot<unknown>;
	pipeline: SnapshotSlot<unknown>;
	lastAccessAt: number;
	overviewTimer: ReturnType<typeof setInterval> | null;
	runtimeTimer: ReturnType<typeof setInterval> | null;
};

const createSlot = (): SnapshotSlot<unknown> => ({
	data: null,
	updatedAt: null,
	lastError: null,
	inFlight: null,
});

const createEntry = (jobId: string): JobRuntimeEntry => ({
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

export const createJobRuntimeStatusStore = (
	options: JobRuntimeStatusStoreOptions,
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
	const entries = new Map<string, JobRuntimeEntry>();

	const stopTimers = (entry: JobRuntimeEntry) => {
		if (entry.overviewTimer) clearInterval(entry.overviewTimer);
		if (entry.runtimeTimer) clearInterval(entry.runtimeTimer);
		entry.overviewTimer = null;
		entry.runtimeTimer = null;
	};

	const isIdle = (entry: JobRuntimeEntry) =>
		Date.now() - entry.lastAccessAt >= idleStopMs;

	const refresh = async <T>(
		slot: SnapshotSlot<T>,
		loader: () => Promise<T>,
	) => {
		if (slot.inFlight) return slot.inFlight;

		const inFlight = loader()
			.then((data) => {
				slot.data = data;
				slot.updatedAt = new Date().toISOString();
				slot.lastError = null;
			})
			.catch((error) => {
				slot.lastError = errorMessage(error);
				if (!slot.data) throw error;
			})
			.finally(() => {
				slot.inFlight = null;
			});
		slot.inFlight = inFlight;
		return inFlight;
	};

	const refreshIfLoaded = async (
		entry: JobRuntimeEntry,
		slot: SnapshotSlot<unknown>,
		loader: () => Promise<unknown>,
	) => {
		if (!slot.data || isIdle(entry)) return;
		await refresh(slot, loader).catch(() => {});
	};

	const startOverviewTimer = (entry: JobRuntimeEntry) => {
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
					refreshIfLoaded(
						entry,
						entry.runningTasks,
						loaders.loadRunningTasks,
					),
					refreshIfLoaded(
						entry,
						entry.queueCounts,
						loaders.loadQueueCounts,
					),
				]);
				stopTimers(entry);
			})();
		}, overviewIntervalMs);
	};

	const startRuntimeTimer = (entry: JobRuntimeEntry) => {
		if (entry.runtimeTimer) return;
		entry.runtimeTimer = setInterval(() => {
			if (isIdle(entry)) {
				stopTimers(entry);
				return;
			}
			const loaders = getLoaders(entry.jobId);
			void Promise.all([
				refreshIfLoaded(
					entry,
					entry.runningTasks,
					loaders.loadRunningTasks,
				),
				refreshIfLoaded(
					entry,
					entry.queueCounts,
					loaders.loadQueueCounts,
				),
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
			entry = createEntry(jobId);
			entries.set(jobId, entry);
			evictIfNeeded();
		}
		entry.lastAccessAt = Date.now();
		return entry;
	};

	const readSlot = async <T>(
		jobId: string,
		slotName: "overview" | "runningTasks" | "queueCounts" | "pipeline",
		loader: () => Promise<T>,
		startTimer?: (entry: JobRuntimeEntry) => void,
	) => {
		const entry = getEntry(jobId);
		startTimer?.(entry);
		const slot = entry[slotName] as SnapshotSlot<T>;
		const loaderKey = `load${slotName[0]?.toUpperCase()}${slotName.slice(1)}` as keyof JobRuntimeLoaders;
		const resolvedLoader = loader ?? (getLoaders(jobId)[loaderKey] as () => Promise<T>);
		if (!slot.data) {
			await refresh(slot, resolvedLoader);
		}
		return slot.data as T;
	};

	return {
		readOverview: <T>(jobId: string, loader?: () => Promise<T>) =>
			readSlot(jobId, "overview", loader, startOverviewTimer),
		readRunningTasks: <T>(jobId: string, loader?: () => Promise<T>) =>
			readSlot(jobId, "runningTasks", loader, startRuntimeTimer),
		readQueueCounts: <T>(jobId: string, loader?: () => Promise<T>) =>
			readSlot(jobId, "queueCounts", loader, startRuntimeTimer),
		readPipeline: <T>(jobId: string, loader?: () => Promise<T>) =>
			readSlot(jobId, "pipeline", loader),
		dispose: () => {
			clearInterval(cleanupTimer);
			for (const entry of entries.values()) stopTimers(entry);
			entries.clear();
		},
	};
};
