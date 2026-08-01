import { open, stat } from "node:fs/promises";
import type {
	DriverStdoutEvent,
	DriverTaskEvent,
	ParsedDriverStdout,
} from "./driver-stdout-protocol";
import { parseDriverStdout } from "./driver-stdout-protocol";

type TailEntry = {
	identity: string;
	offset: number;
	mtimeMs: number;
	ctimeMs: number;
	size: number;
	remainder: string;
	parsed: ParsedDriverStdout;
	inFlight?: Promise<ParsedDriverStdout>;
};

const emptyParsed = (): ParsedDriverStdout => ({
	events: [],
	latestActivity: null,
	latestUsage: null,
	latestTask: null,
	latestLog: null,
	exitCode: null,
	invalidLineCount: 0,
});

const applyEvent = (parsed: ParsedDriverStdout, event: DriverStdoutEvent) => {
	switch (event.type) {
		case "activity":
			parsed.latestActivity = event.activity ?? null;
			break;
		case "usage":
			parsed.latestUsage = event.usage ?? null;
			break;
		case "task_start":
		case "task_done":
			parsed.latestTask = event as DriverTaskEvent;
			break;
		case "log":
			parsed.latestLog = event;
			break;
		case "exit":
			parsed.exitCode =
				typeof event.code === "number" && Number.isFinite(event.code)
					? event.code
					: null;
			break;
	}
};

const identityFor = (value: { dev: bigint | number; ino: bigint | number }) =>
	`${value.dev}:${value.ino}`;

export class DriverStdoutTailReader {
	private readonly entries = new Map<string, TailEntry>();

	async read(filePath: string): Promise<ParsedDriverStdout> {
		const existing = this.entries.get(filePath);
		if (existing?.inFlight) return existing.inFlight;
		const promise = this.readInternal(filePath, existing);
		if (existing) existing.inFlight = promise;
		else {
			const placeholder = {
				identity: "",
				offset: 0,
				mtimeMs: 0,
				ctimeMs: 0,
				size: 0,
				remainder: "",
				parsed: emptyParsed(),
				inFlight: promise,
			};
			this.entries.set(filePath, placeholder);
		}
		try {
			return await promise;
		} finally {
			const entry = this.entries.get(filePath);
			if (entry?.inFlight === promise) entry.inFlight = undefined;
		}
	}

	reset(filePath: string) {
		this.entries.delete(filePath);
	}

	delete(filePath: string) {
		this.entries.delete(filePath);
	}

	private async readInternal(
		filePath: string,
		existing?: TailEntry,
	): Promise<ParsedDriverStdout> {
		const fileStat = await stat(filePath).catch(() => null);
		if (!fileStat || !fileStat.isFile()) {
			this.entries.delete(filePath);
			return emptyParsed();
		}

		const identity = identityFor(fileStat);
		const rebuiltAtSameSize =
			existing !== undefined &&
			fileStat.ctimeMs !== existing.ctimeMs &&
			fileStat.size <= existing.offset;
		const needsReset =
			!existing ||
			existing.identity !== identity ||
			fileStat.size < existing.offset ||
			(fileStat.mtimeMs !== existing.mtimeMs && fileStat.size <= existing.offset) ||
			rebuiltAtSameSize;
		const entry: TailEntry = needsReset
			? {
					identity,
					offset: 0,
					mtimeMs: fileStat.mtimeMs,
					ctimeMs: fileStat.ctimeMs,
					size: 0,
					remainder: "",
					parsed: emptyParsed(),
				}
			: existing;

		if (!needsReset && fileStat.size === entry.size && fileStat.mtimeMs === entry.mtimeMs) {
			return entry.parsed;
		}

		const start = entry.offset;
		const length = Math.max(0, fileStat.size - start);
		if (length > 0) {
			const handle = await open(filePath, "r");
			try {
				const buffer = Buffer.alloc(length);
				const result = await handle.read(buffer, 0, length, start);
				const text = `${entry.remainder}${buffer.toString("utf8", 0, result.bytesRead)}`;
				const lines = text.split("\n");
				entry.remainder = lines.pop() ?? "";
				for (const line of lines) {
					const parsedLine = parseDriverStdout(line);
					entry.parsed.invalidLineCount += parsedLine.invalidLineCount;
					for (const event of parsedLine.events) applyEvent(entry.parsed, event);
				}
				entry.offset = start + result.bytesRead;
			} finally {
				await handle.close();
			}
		}
		entry.identity = identity;
		entry.mtimeMs = fileStat.mtimeMs;
		entry.ctimeMs = fileStat.ctimeMs;
		entry.size = fileStat.size;
		this.entries.set(filePath, entry);
		return entry.parsed;
	}
}

export const driverStdoutTailReader = new DriverStdoutTailReader();
