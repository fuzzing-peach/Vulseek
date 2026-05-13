export type SandboxAgentProvider = "codex" | "claude";

export type SandboxAgentRuntimeArtifacts = {
	stderrFileName: string;
	metadataFileName: string;
	serverLogFileName: string;
	pidFileName: string;
	stderrPath: string;
	metadataPath: string;
	serverLogPath: string;
	pidPath: string;
};

export type SandboxAgentServerHandle = {
	baseUrl: string;
	publicBaseUrl: string;
	host: string;
	port: number;
};

export type StartSandboxAgentServerInput = {
	containerName: string;
	stageDirPath: string;
	stageDirInContainer: string;
	envPairs?: string[];
	homeDir?: string;
};

export type PrepareSandboxAgentRuntimeResult = {
	artifacts: SandboxAgentRuntimeArtifacts;
	server: SandboxAgentServerHandle;
};
