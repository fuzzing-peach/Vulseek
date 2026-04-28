import os from "node:os";
import { publicIpv4, publicIpv6 } from "public-ip";

export const getShell = () => {
	switch (os.platform()) {
		case "win32":
			return "powershell.exe";
		case "darwin":
			return "zsh";
		default:
			return "bash";
	}
};

export const getPublicIpWithFallback = async () => {
	let ip: string | null = null;
	try {
		ip = await publicIpv4();
	} catch (error) {
		console.log(
			"Error obtaining public IPv4 address, falling back to IPv6",
			error instanceof Error ? error.message : String(error),
		);
		try {
			ip = await publicIpv6();
		} catch (error) {
			console.error(
				"Error obtaining public IPv6 address",
				error instanceof Error ? error.message : String(error),
			);
			ip = null;
		}
	}
	return ip;
};
