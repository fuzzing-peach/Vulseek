import { Loader2 } from "lucide-react";
import { useTheme } from "next-themes";
import { useTranslation } from "next-i18next";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { scanT } from "./scan-i18n";

interface Props {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description?: string;
	logs: string;
	isLoading?: boolean;
}

type XTermInstance = import("@xterm/xterm").Terminal;
type FitAddonInstance = import("xterm-addon-fit").FitAddon;

const buildTerminalTheme = (resolvedTheme?: string) => ({
	cursor: resolvedTheme === "light" ? "#0f172a" : "#e2e8f0",
	background: "rgba(0, 0, 0, 0)",
	foreground: resolvedTheme === "light" ? "#334155" : "#e2e8f0",
});

const isViewportNearBottom = (viewport: HTMLDivElement | null) => {
	if (!viewport) {
		return true;
	}

	return (
		viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 16
	);
};

const waitForFrame = () =>
	new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

const resetLogsInTerminal = (
	term: XTermInstance,
	content: string,
	callback?: () => void,
) => {
	term.reset();
	term.write(content || "", callback);
};

const writeLogUpdateToTerminal = (
	term: XTermInstance,
	previousContent: string,
	nextContent: string,
	callback?: () => void,
) => {
	if (nextContent.startsWith(previousContent)) {
		const appendedContent = nextContent.slice(previousContent.length);
		if (appendedContent) {
			term.write(appendedContent, callback);
			return;
		}

		callback?.();
		return;
	}

	resetLogsInTerminal(term, nextContent, callback);
};

const hasRenderableSize = (element: HTMLElement | null) => {
	if (!element?.isConnected) {
		return false;
	}

	const rect = element.getBoundingClientRect();
	return rect.width > 0 && rect.height > 0;
};

export const CheckoutLogModal = ({
	open,
	onOpenChange,
	title,
	description,
	logs,
	isLoading,
}: Props) => {
	const { t } = useTranslation("scan");
	const hostRef = useRef<HTMLDivElement | null>(null);
	const xtermRef = useRef<XTermInstance | null>(null);
	const fitAddonRef = useRef<FitAddonInstance | null>(null);
	const autoScrollRef = useRef(true);
	const userScrollLockedRef = useRef(false);
	const ignoreScrollEventsRef = useRef(false);
	const viewportCleanupRef = useRef<(() => void) | null>(null);
	const resizeObserverRef = useRef<ResizeObserver | null>(null);
	const frameRef = useRef<number | null>(null);
	const restoreScrollFrameRef = useRef<number | null>(null);
	const renderedLogsRef = useRef("");
	const lastWrittenLogsRef = useRef("");
	const [hostElement, setHostElement] = useState<HTMLDivElement | null>(null);
	const { resolvedTheme } = useTheme();

	const renderedLogs = useMemo(
		() => logs.replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
		[logs],
	);
	renderedLogsRef.current = renderedLogs;

	const setHostNode = useCallback((node: HTMLDivElement | null) => {
		hostRef.current = node;
		setHostElement(node);
	}, []);

	const cancelPendingFrame = useCallback(() => {
		if (frameRef.current !== null) {
			window.cancelAnimationFrame(frameRef.current);
			frameRef.current = null;
		}
		if (restoreScrollFrameRef.current !== null) {
			window.cancelAnimationFrame(restoreScrollFrameRef.current);
			restoreScrollFrameRef.current = null;
		}
	}, []);

	const safeFit = useCallback(() => {
		const term = xtermRef.current;
		const fitAddon = fitAddonRef.current;
		const host = hostRef.current;
		if (!term || !fitAddon || !hasRenderableSize(host)) {
			return;
		}

		try {
			fitAddon.fit();
		} catch {
			// xterm can briefly lack renderer dimensions while a dialog is mounting.
		}
	}, []);

	const safeScrollToBottom = useCallback(() => {
		const term = xtermRef.current;
		if (!term) {
			return;
		}

		try {
			term.scrollToBottom();
		} catch {
			// Ignore stale viewport work after close or during renderer startup.
		}
	}, []);

	const beginIgnoringProgrammaticScroll = useCallback(() => {
		ignoreScrollEventsRef.current = true;
	}, []);

	const stopIgnoringProgrammaticScrollAfterFrames = useCallback(() => {
		window.requestAnimationFrame(() => {
			window.requestAnimationFrame(() => {
				ignoreScrollEventsRef.current = false;
			});
		});
	}, []);

	const lockAutoScrollForUser = useCallback(() => {
		userScrollLockedRef.current = true;
		autoScrollRef.current = false;
	}, []);

	const restoreViewportScrollTop = useCallback(
		(viewport: HTMLDivElement, scrollTop: number) => {
			if (restoreScrollFrameRef.current !== null) {
				window.cancelAnimationFrame(restoreScrollFrameRef.current);
			}

			const restore = () => {
				if (!viewport.isConnected || autoScrollRef.current) {
					return;
				}

				viewport.scrollTop = Math.min(
					scrollTop,
					Math.max(0, viewport.scrollHeight - viewport.clientHeight),
				);
			};

			restore();
			restoreScrollFrameRef.current = window.requestAnimationFrame(() => {
				restore();
				restoreScrollFrameRef.current = window.requestAnimationFrame(() => {
					restoreScrollFrameRef.current = null;
					restore();
				});
			});
		},
		[],
	);

	const scheduleTerminalLayout = useCallback(() => {
		cancelPendingFrame();
		frameRef.current = window.requestAnimationFrame(() => {
			frameRef.current = null;
			safeFit();
			if (autoScrollRef.current) {
				safeScrollToBottom();
			}
		});
	}, [cancelPendingFrame, safeFit, safeScrollToBottom]);

	const flushPendingLogsToTerminal = useCallback(() => {
		const term = xtermRef.current;
		if (!term) {
			return;
		}

		const previousLogs = lastWrittenLogsRef.current;
		const nextLogs = renderedLogsRef.current;
		if (previousLogs === nextLogs) {
			scheduleTerminalLayout();
			return;
		}

		beginIgnoringProgrammaticScroll();
		lastWrittenLogsRef.current = nextLogs;
		writeLogUpdateToTerminal(term, previousLogs, nextLogs, () => {
			if (xtermRef.current !== term) {
				return;
			}

			scheduleTerminalLayout();
			stopIgnoringProgrammaticScrollAfterFrames();
		});
	}, [
		beginIgnoringProgrammaticScroll,
		scheduleTerminalLayout,
		stopIgnoringProgrammaticScrollAfterFrames,
	]);

	const syncAutoScrollFromViewport = useCallback(
		(viewport: HTMLDivElement | null) => {
			if (ignoreScrollEventsRef.current) {
				return;
			}

			const isNearBottom = isViewportNearBottom(viewport);
			if (isNearBottom) {
				userScrollLockedRef.current = false;
				autoScrollRef.current = true;
				flushPendingLogsToTerminal();
				return;
			}

			userScrollLockedRef.current = true;
			autoScrollRef.current = false;
		},
		[flushPendingLogsToTerminal],
	);

	const disposeTerminal = useCallback(() => {
		cancelPendingFrame();
		viewportCleanupRef.current?.();
		viewportCleanupRef.current = null;
		resizeObserverRef.current?.disconnect();
		resizeObserverRef.current = null;

		const term = xtermRef.current;
		xtermRef.current = null;
		fitAddonRef.current = null;
		lastWrittenLogsRef.current = "";
		term?.dispose();
	}, [cancelPendingFrame]);

	useEffect(() => {
		if (!open || !hostElement) {
			return;
		}

		let cancelled = false;

		const mountTerminal = async () => {
			const [{ Terminal }, { FitAddon }] = await Promise.all([
				import("@xterm/xterm"),
				import("xterm-addon-fit"),
			]);
			if (cancelled || !hostElement) {
				return;
			}

			disposeTerminal();
			hostElement.innerHTML = "";

			const term = new Terminal({
				cursorBlink: false,
				disableStdin: true,
				lineHeight: 1.4,
				convertEol: true,
				scrollback: 10000,
				theme: buildTerminalTheme(resolvedTheme),
			});
			const fitAddon = new FitAddon();

			term.loadAddon(fitAddon);
			term.open(hostElement);
			xtermRef.current = term;
			fitAddonRef.current = fitAddon;

			await waitForFrame();
			await waitForFrame();
			if (cancelled || !xtermRef.current) {
				return;
			}

			const initialLogs = renderedLogsRef.current;
			resetLogsInTerminal(term, initialLogs);
			lastWrittenLogsRef.current = initialLogs;
			scheduleTerminalLayout();

			if (typeof ResizeObserver !== "undefined" && hostElement) {
				const observer = new ResizeObserver(() => {
					scheduleTerminalLayout();
				});
				observer.observe(hostElement);
				resizeObserverRef.current = observer;
			}

			const viewport = term.element?.querySelector(
				".xterm-viewport",
			) as HTMLDivElement | null;
			if (viewport) {
				const handleScroll = (event: Event) => {
					syncAutoScrollFromViewport(event.currentTarget as HTMLDivElement);
				};
				const handleWheel = (event: WheelEvent) => {
					if (event.deltaY < 0 || !isViewportNearBottom(viewport)) {
						lockAutoScrollForUser();
					}
				};
				const handleUserScrollStart = () => {
					if (!isViewportNearBottom(viewport)) {
						lockAutoScrollForUser();
					}
				};
				viewport.addEventListener("scroll", handleScroll);
				viewport.addEventListener("wheel", handleWheel, {
					passive: true,
				});
				viewport.addEventListener("touchstart", handleUserScrollStart, {
					passive: true,
				});
				viewport.addEventListener("pointerdown", handleUserScrollStart);
				viewportCleanupRef.current = () => {
					viewport.removeEventListener("scroll", handleScroll);
					viewport.removeEventListener("wheel", handleWheel);
					viewport.removeEventListener("touchstart", handleUserScrollStart);
					viewport.removeEventListener("pointerdown", handleUserScrollStart);
				};
			}
		};

		void mountTerminal();

		return () => {
			cancelled = true;
		};
	}, [
		open,
		hostElement,
		resolvedTheme,
		disposeTerminal,
		scheduleTerminalLayout,
		syncAutoScrollFromViewport,
		lockAutoScrollForUser,
	]);

	useEffect(() => {
		const term = xtermRef.current;
		if (!open || !term) {
			return;
		}

		const viewport = term.element?.querySelector(
			".xterm-viewport",
		) as HTMLDivElement | null;
		const shouldStickToBottom = autoScrollRef.current;

		term.options.theme = buildTerminalTheme(resolvedTheme);

		if (!shouldStickToBottom) {
			return;
		}

		flushPendingLogsToTerminal();
	}, [open, renderedLogs, resolvedTheme, flushPendingLogsToTerminal]);

	useEffect(() => {
		if (!open) {
			return;
		}

		const handleResize = async () => {
			await waitForFrame();
			scheduleTerminalLayout();
		};

		window.addEventListener("resize", handleResize);
		return () => window.removeEventListener("resize", handleResize);
	}, [open, scheduleTerminalLayout]);

	useEffect(() => {
		if (!open) {
			autoScrollRef.current = true;
			userScrollLockedRef.current = false;
			lastWrittenLogsRef.current = "";
			disposeTerminal();
		}
	}, [open, disposeTerminal]);

	useEffect(() => {
		return () => {
			disposeTerminal();
		};
	}, [disposeTerminal]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-5xl border-slate-200 bg-white">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>
						{description ||
							scanT(t, "scan.actions.dockerBuildLogs", "Docker build logs")}
					</DialogDescription>
				</DialogHeader>
				<div className="relative h-[60vh] overflow-hidden rounded-lg border border-slate-200 bg-slate-50 p-4 font-mono text-xs leading-5 text-slate-700 shadow-sm">
					{isLoading ? (
						<div className="pointer-events-none absolute right-4 top-4 z-10 flex items-center gap-2 rounded-md bg-white/85 px-2 py-1 text-slate-500 shadow-sm">
							<Loader2 className="size-4 animate-spin" />
							{scanT(
								t,
								"scan.actions.checkoutRunning",
								"Running checkout and image build...",
							)}
						</div>
					) : null}
					<div ref={setHostNode} className="h-full w-full" />
				</div>
			</DialogContent>
		</Dialog>
	);
};
