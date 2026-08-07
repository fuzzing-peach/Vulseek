import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// vitest globals are off, so RTL cannot self-register; clean between tests.
// This setup also runs for node-environment tests, so guard the DOM bits.
afterEach(() => {
	if (typeof document !== "undefined") {
		cleanup();
	}
});

// jsdom lacks these; Radix primitives call them defensively.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
	Element.prototype.scrollIntoView = () => {};
}

if (typeof window !== "undefined" && !window.matchMedia) {
	window.matchMedia = (query: string) =>
		({
			matches: false,
			media: query,
			onchange: null,
			addListener: () => {},
			removeListener: () => {},
			addEventListener: () => {},
			removeEventListener: () => {},
			dispatchEvent: () => false,
		}) as MediaQueryList;
}

// cmdk and other Radix-based components observe DOM size changes; jsdom
// does not implement ResizeObserver. Guard through globalThis so the file
// typechecks in both node and jsdom environments without DOM lib types.
const globalWindow = globalThis as unknown as { ResizeObserver?: unknown };
if (typeof globalWindow.ResizeObserver === "undefined") {
	class ResizeObserverStub {
		observe() {}
		unobserve() {}
		disconnect() {}
	}
	globalWindow.ResizeObserver = ResizeObserverStub;
}
