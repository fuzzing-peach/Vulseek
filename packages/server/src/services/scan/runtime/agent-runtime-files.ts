import { promises as fs } from "node:fs";
import path from "node:path";

export const AGENT_RUNTIME_FILE_NAMES = {
	stdout: "stdout",
} as const;

export const initializeAgentRuntimeFiles = async (runtimeDir: string) => {
	await fs.mkdir(runtimeDir, { recursive: true });
	await fs.writeFile(
		path.join(runtimeDir, AGENT_RUNTIME_FILE_NAMES.stdout),
		"",
		"utf-8",
	);
};
