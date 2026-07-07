import { AttachAddon } from "@xterm/addon-attach";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import React, { useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { FitAddon } from "xterm-addon-fit";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

type TerminalMode = "codex" | "bash" | "sh";

interface Props {
	id: string;
	containerId?: string;
	serverId?: string;
	allowAttach?: boolean;
	defaultTerminalMode?: TerminalMode;
}

type TerminalPaneProps = {
	containerId?: string;
	serverId?: string;
	isActive: boolean;
	isLightTheme: boolean;
	mode: TerminalMode;
	paneId: string;
};

const buildTerminalTheme = (isLightTheme: boolean) => ({
	cursor: isLightTheme ? "#4338ca" : "#f8fafc",
	cursorAccent: isLightTheme ? "#f8fafc" : "#020617",
	selectionBackground: isLightTheme
		? "rgba(99, 102, 241, 0.18)"
		: "rgba(148, 163, 184, 0.24)",
	background: isLightTheme ? "#f8f5ef" : "#111827",
	foreground: isLightTheme ? "#1f2937" : "#e5e7eb",
	black: isLightTheme ? "#1f2937" : "#111827",
	red: "#dc2626",
	green: isLightTheme ? "#15803d" : "#22c55e",
	yellow: isLightTheme ? "#b45309" : "#f59e0b",
	blue: isLightTheme ? "#1d4ed8" : "#60a5fa",
	magenta: isLightTheme ? "#9333ea" : "#c084fc",
	cyan: isLightTheme ? "#0f766e" : "#22d3ee",
	white: isLightTheme ? "#f9fafb" : "#f3f4f6",
	brightBlack: isLightTheme ? "#6b7280" : "#6b7280",
	brightRed: "#ef4444",
	brightGreen: isLightTheme ? "#16a34a" : "#4ade80",
	brightYellow: isLightTheme ? "#ca8a04" : "#facc15",
	brightBlue: isLightTheme ? "#2563eb" : "#93c5fd",
	brightMagenta: isLightTheme ? "#a855f7" : "#d8b4fe",
	brightCyan: isLightTheme ? "#0891b2" : "#67e8f9",
	brightWhite: "#ffffff",
});

const TerminalPane = ({
	containerId,
	serverId,
	isActive,
	isLightTheme,
	mode,
	paneId,
}: TerminalPaneProps) => {
	const termRef = useRef<HTMLDivElement | null>(null);
	const fitAddonRef = useRef<FitAddon | null>(null);

	useEffect(() => {
		const container = termRef.current ?? document.getElementById(paneId);
		if (container) {
			container.innerHTML = "";
		}

		const term = new Terminal({
			cursorBlink: true,
			lineHeight: 1.4,
			convertEol: true,
			fontFamily:
				'"SFMono-Regular", "JetBrains Mono", "Fira Code", "Menlo", "Monaco", monospace',
			theme: buildTerminalTheme(isLightTheme),
		});
		const fitAddon = new FitAddon();
		fitAddonRef.current = fitAddon;
		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const connectionMode = mode === "codex" ? "codex" : "exec";
		const activeWay = mode === "sh" ? "sh" : "bash";
		const wsUrl = `${protocol}//${window.location.host}/docker-container-terminal?containerId=${containerId}&activeWay=${activeWay}&mode=${connectionMode}${serverId ? `&serverId=${serverId}` : ""}`;
		const ws = new WebSocket(wsUrl);
		const attachAddon = new AttachAddon(ws);

		term.loadAddon(fitAddon);
		term.loadAddon(attachAddon);

		if (container) {
			term.open(container);
			window.requestAnimationFrame(() => {
				if (!container.isConnected || !isActive) {
					return;
				}
				try {
					fitAddon.fit();
				} catch {}
			});
		}

		return () => {
			fitAddonRef.current = null;
			if (ws.readyState === WebSocket.OPEN) {
				ws.close();
			}
			term.dispose();
		};
	}, [containerId, isLightTheme, mode, paneId, serverId]);

	useEffect(() => {
		if (!isActive) {
			return;
		}
		const frameId = window.requestAnimationFrame(() => {
			try {
				fitAddonRef.current?.fit();
			} catch {}
		});
		return () => window.cancelAnimationFrame(frameId);
	}, [isActive]);

	return (
		<div
			className={isActive ? "block" : "hidden"}
			aria-hidden={!isActive}
		>
			<div id={paneId} ref={termRef} className="min-h-[560px]" />
		</div>
	);
};

export const DockerTerminal: React.FC<Props> = ({
	id,
	containerId,
	serverId,
	allowAttach = false,
	defaultTerminalMode = "bash",
}) => {
	const availableModes: TerminalMode[] = allowAttach
		? ["codex", "bash", "sh"]
		: ["bash", "sh"];
	const [terminalMode, setTerminalMode] = useState<TerminalMode>(
		allowAttach ? defaultTerminalMode : "bash",
	);
	const { resolvedTheme } = useTheme();
	const isLightTheme = resolvedTheme === "light";

	return (
		<div className="flex flex-col gap-4">
			<div className="mt-4 flex flex-col gap-2">
				<span className="text-sm text-muted-foreground">
					Select way to connect to <b>{containerId}</b>
				</span>
				<Tabs
					value={terminalMode}
					onValueChange={(value) => setTerminalMode(value as TerminalMode)}
				>
					<TabsList
						className={
							isLightTheme
								? "border border-amber-100 bg-amber-50/80 text-slate-500"
								: undefined
						}
					>
						{availableModes.includes("codex") ? (
							<TabsTrigger value="codex">Codex</TabsTrigger>
						) : null}
						<TabsTrigger value="bash">Bash</TabsTrigger>
						<TabsTrigger value="sh">/bin/sh</TabsTrigger>
					</TabsList>
				</Tabs>
			</div>
			<div
				className={`w-full h-full rounded-xl border p-3 shadow-sm ${
					isLightTheme
						? "border-amber-100 bg-gradient-to-b from-amber-50 via-stone-50 to-white"
						: "border-slate-800 bg-slate-950"
				}`}
			>
				<div
					className={`mb-3 flex items-center gap-2 border-b pb-3 ${
						isLightTheme ? "border-amber-100" : "border-slate-800"
					}`}
				>
					<span className="size-2 rounded-full bg-rose-400" />
					<span className="size-2 rounded-full bg-amber-400" />
					<span className="size-2 rounded-full bg-emerald-400" />
					<span
						className={`ml-2 text-xs font-medium ${
							isLightTheme ? "text-slate-500" : "text-slate-400"
						}`}
					>
						{terminalMode === "codex"
							? "Codex Session"
							: terminalMode === "sh"
								? "/bin/sh"
								: "Bash"}
					</span>
				</div>
				<div
					className={`overflow-hidden rounded-lg border ${
						isLightTheme
							? "border-amber-100 bg-[#f8f5ef]"
							: "border-slate-800 bg-slate-950"
					}`}
				>
					{availableModes.map((mode) => (
						<TerminalPane
							key={mode}
							paneId={`${id}-${mode}`}
							containerId={containerId}
							serverId={serverId}
							mode={mode}
							isActive={terminalMode === mode}
							isLightTheme={isLightTheme}
						/>
					))}
				</div>
			</div>
		</div>
	);
};
