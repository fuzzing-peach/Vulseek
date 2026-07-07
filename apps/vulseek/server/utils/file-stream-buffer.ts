import { promises as fs } from "node:fs";

export type FileStreamBufferEvent =
	| {
			type: "snapshot";
			content: string;
			offset: number;
			reason: "init" | "reset" | "missing";
	  }
	| {
			type: "append";
			content: string;
			offset: number;
	  };

type FileStreamBufferSubscriber = (event: FileStreamBufferEvent) => void;

type FileStreamBufferSnapshot = {
	content: string;
	offset: number;
};

class FileStreamBuffer {
	private readonly filePath: string;
	private readonly pollIntervalMs: number;
	private content = "";
	private offset = 0;
	private initialized = false;
	private initializing: Promise<void> | null = null;
	private syncing = false;
	private pollTimer: NodeJS.Timeout | null = null;
	private readonly subscribers = new Set<FileStreamBufferSubscriber>();

	constructor(filePath: string, pollIntervalMs: number) {
		this.filePath = filePath;
		this.pollIntervalMs = pollIntervalMs;
	}

	private notify(event: FileStreamBufferEvent) {
		for (const subscriber of this.subscribers) {
			try {
				subscriber(event);
			} catch {}
		}
	}

	private async loadEntireFile(reason: "init" | "reset" | "missing") {
		const content = await fs.readFile(this.filePath, "utf-8").catch(() => "");
		this.content = content;
		this.offset = Buffer.byteLength(content, "utf-8");
		this.initialized = true;
		if (reason !== "init") {
			this.notify({
				type: "snapshot",
				content: this.content,
				offset: this.offset,
				reason,
			});
		}
	}

	async ensureInitialized() {
		if (this.initialized) {
			return;
		}

		if (this.initializing) {
			await this.initializing;
			return;
		}

		// On first access after process start, rebuild in-memory state
		// from the current on-disk file contents before switching to tail mode.
		this.initializing = this.loadEntireFile("init").finally(() => {
			this.initializing = null;
		});
		await this.initializing;
	}

	async getSnapshot(): Promise<FileStreamBufferSnapshot> {
		await this.ensureInitialized();
		return {
			content: this.content,
			offset: this.offset,
		};
	}

	private startPolling() {
		if (this.pollTimer) {
			return;
		}
		this.pollTimer = setInterval(() => {
			void this.sync();
		}, this.pollIntervalMs);
	}

	private stopPollingIfIdle() {
		if (this.subscribers.size > 0 || !this.pollTimer) {
			return;
		}
		clearInterval(this.pollTimer);
		this.pollTimer = null;
	}

	getSubscriberCount() {
		return this.subscribers.size;
	}

	dispose() {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
		this.subscribers.clear();
		this.content = "";
		this.offset = 0;
		this.initialized = false;
		this.initializing = null;
		this.syncing = false;
	}

	subscribe(subscriber: FileStreamBufferSubscriber) {
		this.subscribers.add(subscriber);
		this.startPolling();
		return () => {
			this.subscribers.delete(subscriber);
			this.stopPollingIfIdle();
		};
	}

	async sync() {
		if (this.syncing) {
			return;
		}

		this.syncing = true;
		try {
			await this.ensureInitialized();
			const stat = await fs.stat(this.filePath).catch(() => null);
			if (!stat) {
				if (this.content !== "" || this.offset !== 0) {
					this.content = "";
					this.offset = 0;
					this.notify({
						type: "snapshot",
						content: "",
						offset: 0,
						reason: "missing",
					});
				}
				return;
			}

			// Treat shrink as truncate/overwrite/log rotation and rebuild from disk.
			if (stat.size < this.offset) {
				await this.loadEntireFile("reset");
				return;
			}

			if (stat.size === this.offset) {
				return;
			}

			const handle = await fs.open(this.filePath, "r");
			try {
				const length = stat.size - this.offset;
				const buffer = Buffer.alloc(length);
				await handle.read(buffer, 0, length, this.offset);
				const delta = buffer.toString("utf-8");
				this.content += delta;
				this.offset = stat.size;
				this.notify({
					type: "append",
					content: delta,
					offset: this.offset,
				});
			} finally {
				await handle.close();
			}
		} finally {
			this.syncing = false;
		}
	}
}

const fileStreamBuffers = new Map<string, FileStreamBuffer>();

export const getFileStreamBuffer = (
	filePath: string,
	options?: {
		pollIntervalMs?: number;
	},
) => {
	const existing = fileStreamBuffers.get(filePath);
	if (existing) {
		return existing;
	}

	const created = new FileStreamBuffer(filePath, options?.pollIntervalMs ?? 1000);
	fileStreamBuffers.set(filePath, created);
	return created;
};

export const clearFileStreamBuffer = (
	filePath: string,
	options?: {
		onlyIfIdle?: boolean;
	},
) => {
	const existing = fileStreamBuffers.get(filePath);
	if (!existing) {
		return false;
	}
	const onlyIfIdle = options?.onlyIfIdle ?? true;
	if (onlyIfIdle && existing.getSubscriberCount() > 0) {
		return false;
	}
	existing.dispose();
	fileStreamBuffers.delete(filePath);
	return true;
};
