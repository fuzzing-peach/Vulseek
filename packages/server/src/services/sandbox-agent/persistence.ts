import { promises as fs } from "node:fs";
import path from "node:path";
import type {
	SandboxAgentRuntimeArtifacts,
	SandboxAgentServerHandle,
} from "./types";

export const createSandboxAgentRuntimeArtifacts = (
	runtimeDir: string,
): SandboxAgentRuntimeArtifacts => ({
	stderrFileName: "sandbox-agent-stderr.log",
	metadataFileName: "sandbox-agent-runtime.json",
	serverLogFileName: "sandbox-agent-server.log",
	pidFileName: "sandbox-agent-server.pid",
	stderrPath: path.join(runtimeDir, "sandbox-agent-stderr.log"),
	metadataPath: path.join(runtimeDir, "sandbox-agent-runtime.json"),
	serverLogPath: path.join(runtimeDir, "sandbox-agent-server.log"),
	pidPath: path.join(runtimeDir, "sandbox-agent-server.pid"),
});

export const initializeSandboxAgentRuntimeFiles = async (
	artifacts: SandboxAgentRuntimeArtifacts,
) => {
	await fs.mkdir(path.dirname(artifacts.stderrPath), { recursive: true });
	await Promise.all([
		fs.writeFile(artifacts.stderrPath, "", "utf-8"),
		fs.writeFile(artifacts.serverLogPath, "", "utf-8"),
		fs.writeFile(artifacts.metadataPath, "{}", "utf-8"),
	]);
};

export const persistSandboxAgentRuntimeMetadata = async (input: {
	artifacts: SandboxAgentRuntimeArtifacts;
	server: SandboxAgentServerHandle;
	provider: string;
}) => {
	await fs.writeFile(
		input.artifacts.metadataPath,
		JSON.stringify(
			{
				runtime: "sandbox_agent",
				provider: input.provider,
				server: input.server,
				updatedAt: new Date().toISOString(),
			},
			null,
			2,
		),
		"utf-8",
	);
};
