import { promises as fs } from "node:fs";
import path from "node:path";

export const AGENT_RUNTIME_FILE_NAMES = {
	activity: "activity.json",
	usage: "usage.json",
	state: "task-state.json",
	stderr: "driver-stderr.log",
	stdout: "driver-stdout.log",
} as const;

export const initializeAgentRuntimeFiles = async (runtimeDir: string) => {
	await fs.mkdir(runtimeDir, { recursive: true });
	await Promise.all([
		fs.writeFile(
			path.join(runtimeDir, AGENT_RUNTIME_FILE_NAMES.activity),
			"{}\n",
			"utf-8",
		),
		fs.writeFile(
			path.join(runtimeDir, AGENT_RUNTIME_FILE_NAMES.usage),
			"null\n",
			"utf-8",
		),
		fs.writeFile(
			path.join(runtimeDir, AGENT_RUNTIME_FILE_NAMES.state),
			"{}\n",
			"utf-8",
		),
		fs.writeFile(
			path.join(runtimeDir, AGENT_RUNTIME_FILE_NAMES.stderr),
			"",
			"utf-8",
		),
		fs.writeFile(
			path.join(runtimeDir, AGENT_RUNTIME_FILE_NAMES.stdout),
			"",
			"utf-8",
		),
	]);
};
