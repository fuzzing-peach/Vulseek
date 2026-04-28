import { Loader2 } from "lucide-react";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";

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

	return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 16;
};

const waitForFrame = () =>
	new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

const writeLogsToTerminal = (term: XTermInstance, content: string) => {
	term.reset();
	term.write(content || "");
};

export const CheckoutLogModal = ({
	open,
	onOpenChange,
	title,
	description,
	logs,
	isLoading,
}: Props) => {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const xtermRef = useRef<XTermInstance | null>(null);
	const fitAddonRef = useRef<FitAddonInstance | null>(null);
	const autoScrollRef = useRef(true);
	const viewportCleanupRef = useRef<(() => void) | null>(null);
	const resizeObserverRef = useRef<ResizeObserver | null>(null);
	const [hostElement, setHostElement] = useState<HTMLDivElement | null>(null);
	const { resolvedTheme } = useTheme();

	const renderedLogs = useMemo(
		() => logs.replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
		[logs],
	);

	const setHostNode = useCallback((node: HTMLDivElement | null) => {
		hostRef.current = node;
		setHostElement(node);
	}, []);

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

			hostElement.innerHTML = "";
			viewportCleanupRef.current?.();
			viewportCleanupRef.current = null;
			xtermRef.current?.dispose();
			xtermRef.current = null;
			fitAddonRef.current = null;

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

			fitAddon.fit();
			writeLogsToTerminal(term, renderedLogs);
			term.scrollToBottom();

			if (typeof ResizeObserver !== "undefined" && hostElement) {
				const observer = new ResizeObserver(() => {
					fitAddonRef.current?.fit();
					if (autoScrollRef.current) {
						xtermRef.current?.scrollToBottom();
					}
				});
				observer.observe(hostElement);
				resizeObserverRef.current = observer;
			}

			const viewport = term.element?.querySelector(
				".xterm-viewport",
			) as HTMLDivElement | null;
			if (viewport) {
				const handleScroll = (event: Event) => {
					autoScrollRef.current = isViewportNearBottom(
						event.currentTarget as HTMLDivElement,
					);
				};
				viewport.addEventListener("scroll", handleScroll);
				viewportCleanupRef.current = () =>
					viewport.removeEventListener("scroll", handleScroll);
			}
		};

		void mountTerminal();

		return () => {
			cancelled = true;
		};
	}, [open, hostElement, renderedLogs, resolvedTheme]);

	useEffect(() => {
		const term = xtermRef.current;
		if (!open || !term) {
			return;
		}

		const viewport = term.element?.querySelector(
			".xterm-viewport",
		) as HTMLDivElement | null;
		const previousScrollTop = viewport?.scrollTop ?? 0;
		const shouldStickToBottom = autoScrollRef.current;

		term.options.theme = buildTerminalTheme(resolvedTheme);
		writeLogsToTerminal(term, renderedLogs);
		fitAddonRef.current?.fit();

		if (shouldStickToBottom) {
			term.scrollToBottom();
		} else if (viewport) {
			viewport.scrollTop = previousScrollTop;
		}
	}, [open, renderedLogs, resolvedTheme]);

	useEffect(() => {
		if (!open) {
			return;
		}

		const handleResize = async () => {
			await waitForFrame();
			fitAddonRef.current?.fit();
			if (autoScrollRef.current) {
				xtermRef.current?.scrollToBottom();
			}
		};

		window.addEventListener("resize", handleResize);
		return () => window.removeEventListener("resize", handleResize);
	}, [open]);

	useEffect(() => {
		if (!open) {
			autoScrollRef.current = true;
			viewportCleanupRef.current?.();
			viewportCleanupRef.current = null;
			resizeObserverRef.current?.disconnect();
			resizeObserverRef.current = null;
			xtermRef.current?.dispose();
			xtermRef.current = null;
			fitAddonRef.current = null;
		}
	}, [open]);

	useEffect(() => {
		return () => {
			viewportCleanupRef.current?.();
			viewportCleanupRef.current = null;
			resizeObserverRef.current?.disconnect();
			resizeObserverRef.current = null;
			xtermRef.current?.dispose();
			xtermRef.current = null;
			fitAddonRef.current = null;
		};
	}, []);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-5xl border-slate-200 bg-white">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description || "Docker build logs"}</DialogDescription>
				</DialogHeader>
				<div className="relative h-[60vh] overflow-hidden rounded-lg border border-slate-200 bg-slate-50 p-4 font-mono text-xs leading-5 text-slate-700 shadow-sm">
					{isLoading ? (
						<div className="pointer-events-none absolute right-4 top-4 z-10 flex items-center gap-2 rounded-md bg-white/85 px-2 py-1 text-slate-500 shadow-sm">
							<Loader2 className="size-4 animate-spin" />
							Running checkout and image build...
						</div>
					) : null}
					<div ref={setHostNode} className="h-full w-full" />
				</div>
			</DialogContent>
		</Dialog>
	);
};
