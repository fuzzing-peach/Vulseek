import { Terminal as XTerm } from "@xterm/xterm";
import type React from "react";
import { useEffect, useRef } from "react";
import { FitAddon } from "xterm-addon-fit";
import "@xterm/xterm/css/xterm.css";
import { AttachAddon } from "@xterm/addon-attach";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { useTheme } from "next-themes";
import { getLocalServerData } from "./local-server-config";

interface Props {
	id: string;
	serverId: string;
}

export const Terminal: React.FC<Props> = ({ id, serverId }) => {
	const termRef = useRef<HTMLDivElement>(null);
	const initialized = useRef<boolean>(false);
	const { resolvedTheme } = useTheme();
	useEffect(() => {
		if (initialized.current) {
			// Required in strict mode to avoid issues due to double wss connection
			return;
		}

		initialized.current = true;
		let frameId: number | null = null;
		const container = termRef.current ?? document.getElementById(id);
		if (container) {
			container.innerHTML = "";
		}
		const term = new XTerm({
			cursorBlink: true,
			lineHeight: 1.4,
			convertEol: true,
			theme: {
				cursor: resolvedTheme === "light" ? "#000000" : "transparent",
				background: "rgba(0, 0, 0, 0)",
				foreground: "currentColor",
			},
		});

		const addonFit = new FitAddon();

		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";

		const urlParams = new URLSearchParams();
		urlParams.set("serverId", serverId);

		if (serverId === "local") {
			const { port, username } = getLocalServerData();
			urlParams.set("port", port.toString());
			urlParams.set("username", username);
		}

		const wsUrl = `${protocol}//${window.location.host}/terminal?${urlParams}`;

		const ws = new WebSocket(wsUrl);
		const addonAttach = new AttachAddon(ws);
		const clipboardAddon = new ClipboardAddon();
		term.loadAddon(clipboardAddon);

		term.loadAddon(addonFit);
		term.loadAddon(addonAttach);
		if (container) {
			term.open(container);
			frameId = window.requestAnimationFrame(() => {
				frameId = null;
				if (!container.isConnected) {
					return;
				}

				const rect = container.getBoundingClientRect();
				if (rect.width <= 0 || rect.height <= 0) {
					return;
				}

				try {
					addonFit.fit();
				} catch {
					// xterm renderer dimensions may not be ready during mount.
				}
			});
		}
		return () => {
			if (frameId !== null) {
				window.cancelAnimationFrame(frameId);
			}
			ws.readyState === WebSocket.OPEN && ws.close();
			term.dispose();
			initialized.current = false;
		};
	}, [id, serverId, resolvedTheme]);

	return (
		<div className="flex flex-col gap-4">
			<div className="w-full h-full bg-transparent border rounded-lg p-2">
				<div id={id} ref={termRef} className="rounded-xl" />
			</div>
		</div>
	);
};
