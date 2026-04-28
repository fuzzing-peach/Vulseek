import path from "node:path";
import { execAsync } from "../../utils/process/execAsync";
import {
	createSandboxAgentRuntimeArtifacts,
	initializeSandboxAgentRuntimeFiles,
	persistSandboxAgentRuntimeMetadata,
} from "./persistence";
import { configureSandboxAgentTraefikProxy } from "../scan/runtime/sandbox-agent-traefik";
import type {
	PrepareSandboxAgentRuntimeResult,
	SandboxAgentProvider,
	StartSandboxAgentServerInput,
} from "./types";

const DEFAULT_SANDBOX_AGENT_CONTAINER_PORT = 2468;
const DEFAULT_SANDBOX_AGENT_STARTUP_TIMEOUT_MS = 15000;

const escapeSingleQuotes = (value: string) => value.replace(/'/g, `'\\''`);

const buildShellExports = (pairs: string[]) =>
	pairs
		.map((pair) => {
			const index = pair.indexOf("=");
			const key = index === -1 ? pair : pair.slice(0, index);
			const value = index === -1 ? "" : pair.slice(index + 1);
			return `export ${key}='${escapeSingleQuotes(value)}'`;
		})
		.join(" && ");

const coerceProvider = (provider: string): SandboxAgentProvider | null => {
	if (provider === "codex") {
		return "codex";
	}
	if (provider === "claude_code") {
		return "claude";
	}
	return null;
};

const inspectContainerIpAddress = async (containerName: string) => {
	const { stdout } = await execAsync(
		`docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${containerName}`,
	);
	const value = stdout.trim();
	if (!value) {
		throw new Error(`Unable to resolve container IP for ${containerName}`);
	}
	return value;
};

const waitForSandboxAgentHealth = async (baseUrl: string) => {
	const deadline = Date.now() + DEFAULT_SANDBOX_AGENT_STARTUP_TIMEOUT_MS;
	let lastError = "";

	while (Date.now() < deadline) {
		for (const pathname of ["/health", "/v1/health"]) {
			try {
				const response = await fetch(`${baseUrl}${pathname}`);
				if (response.ok) {
					return;
				}
				lastError = `HTTP ${response.status} from ${pathname}`;
			} catch (error) {
				lastError = error instanceof Error ? error.message : "Unknown health check failure";
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}

	throw new Error(
		`Timed out waiting for sandbox-agent health check (${lastError || "no response"})`,
	);
};

const startSandboxAgentServerInContainer = async (
	input: StartSandboxAgentServerInput,
) => {
	const artifacts = createSandboxAgentRuntimeArtifacts(input.runtimeDirHost);

	await initializeSandboxAgentRuntimeFiles(artifacts);

	const exportLines = buildShellExports([
		`HOME=${input.homeDir || "/root"}`,
		...(input.envPairs || []),
	]);

	await execAsync(
		`docker exec ${input.containerName} bash -lc "mkdir -p '${input.runtimeDirInContainer}' && : > '${path.posix.join(input.runtimeDirInContainer, artifacts.serverLogFileName)}' && rm -f '${path.posix.join(input.runtimeDirInContainer, artifacts.pidFileName)}' && ${exportLines}${exportLines ? " && " : ""}nohup sandbox-agent server --no-token --host 0.0.0.0 --port ${DEFAULT_SANDBOX_AGENT_CONTAINER_PORT} > '${path.posix.join(input.runtimeDirInContainer, artifacts.serverLogFileName)}' 2>&1 < /dev/null & echo \\$! > '${path.posix.join(input.runtimeDirInContainer, artifacts.pidFileName)}'"`,
	);

	const containerIp = await inspectContainerIpAddress(input.containerName);
	const baseUrl = `http://${containerIp}:${DEFAULT_SANDBOX_AGENT_CONTAINER_PORT}`;
	await waitForSandboxAgentHealth(baseUrl);
	const traefikProxy = await configureSandboxAgentTraefikProxy({
		routeId: input.containerName,
		targetHost: containerIp,
		targetPort: DEFAULT_SANDBOX_AGENT_CONTAINER_PORT,
	});

	return {
		artifacts,
		server: {
			baseUrl,
			publicBaseUrl: traefikProxy.baseUrl,
			host: containerIp,
			port: DEFAULT_SANDBOX_AGENT_CONTAINER_PORT,
		},
	};
};

export const prepareSandboxAgentRuntime = async (input: {
	containerName: string;
	runtimeDirHost: string;
	runtimeDirInContainer: string;
	provider: string;
	envPairs?: string[];
	homeDir?: string;
}): Promise<PrepareSandboxAgentRuntimeResult> => {
	const normalizedProvider = coerceProvider(input.provider);
	if (!normalizedProvider) {
		throw new Error(`sandbox-agent does not support provider '${input.provider}'`);
	}

	const result = await startSandboxAgentServerInContainer({
		containerName: input.containerName,
		runtimeDirHost: input.runtimeDirHost,
		runtimeDirInContainer: input.runtimeDirInContainer,
		envPairs: input.envPairs,
		homeDir: input.homeDir,
	});

	await persistSandboxAgentRuntimeMetadata({
		artifacts: result.artifacts,
		server: result.server,
		provider: normalizedProvider,
	});

	return result;
};
