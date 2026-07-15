import { afterEach, describe, expect, it } from "vitest";
import { SseAgentStreamTransport } from "../components/dashboard/scanning/agent-stream-transport";

class FakeEventSource {
	static instances: FakeEventSource[] = [];
	readonly listeners = new Map<
		string,
		Set<(event: MessageEvent<string>) => void>
	>();
	closed = false;
	onerror: (() => void) | null = null;

	constructor(readonly url: string) {
		FakeEventSource.instances.push(this);
	}

	addEventListener(
		type: string,
		listener: (event: MessageEvent<string>) => void,
	) {
		const listeners = this.listeners.get(type) || new Set();
		listeners.add(listener);
		this.listeners.set(type, listeners);
	}

	removeEventListener(
		type: string,
		listener: (event: MessageEvent<string>) => void,
	) {
		this.listeners.get(type)?.delete(listener);
	}

	close() {
		this.closed = true;
	}

	emit(type: string, payload: unknown) {
		for (const listener of this.listeners.get(type) || []) {
			listener({ data: JSON.stringify(payload) } as MessageEvent<string>);
		}
	}
}

const originalEventSource = globalThis.EventSource;

afterEach(() => {
	FakeEventSource.instances = [];
	globalThis.EventSource = originalEventSource;
});

describe("SseAgentStreamTransport", () => {
	it("closes the EventSource after a terminal done event", () => {
		globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
		const events: string[] = [];
		new SseAgentStreamTransport("/stream").subscribe((event) =>
			events.push(event.type),
		);
		const source = FakeEventSource.instances[0]!;

		source.emit("done", { status: "completed", taskId: "task-1" });

		expect(events).toEqual(["done"]);
		expect(source.closed).toBe(true);
	});

	it("closes and detaches listeners on unsubscribe", () => {
		globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
		const unsubscribe = new SseAgentStreamTransport("/stream").subscribe(
			() => {},
		);
		const source = FakeEventSource.instances[0]!;

		unsubscribe();

		expect(source.closed).toBe(true);
		expect(
			[...source.listeners.values()].every((listeners) => listeners.size === 0),
		).toBe(true);
	});
});
